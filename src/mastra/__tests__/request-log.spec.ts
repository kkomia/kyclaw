// @vitest-environment node
/**
 * 请求快照（round 87 / 用户反馈 015）：从 onFinish 事件里抽"这一轮实际发出去的每一次请求"
 * （逐步），落库、按需读回。
 *
 * 四层：
 *   1. 抽取（纯函数）：provider 两种形状的系统指令（chat-completions 的 `messages[].role=system`
 *      与 anthropic 的 `body.system`）、工具表、消息清单（角色 + 正文）、计数；认不出的 null；
 *   2. 脱敏与截断：媒体 base64 换成一行说明、密钥类键的值换掉（**只动这两类**，正文一字不删）；
 *      超上限的正文截断并**标记**；
 *   3. 记账钩子：**每个 step 一条**（一轮多步就有多条）；认不出请求体不落行；写库失败只记日志；
 *   4. 真 libsql：两张表（快照行 + 正文池）建表 / 写入 / 读回（摘要不带正文；正文按 id 取），
 *      同一段文本只存一份（内容哈希）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bodyPartsOf,
  createRequestFailureRecorder,
  createRequestSnapshotRecorder,
  createRequestSnapshotStore,
  errorTextOf,
  messageCountOf,
  messagesOf,
  redactSecretsInText,
  redactValue,
  systemTextOf,
  tapStreamFailures,
  toolsTextOf,
  type RequestFinishEvent,
  type RequestSnapshot,
  type RequestSnapshotStore
} from '../request-log'
import { usageSqlClient } from '../usage'

/**
 * 临时工作目录（2026-10-15 起的新口径）：落**工作区** `.superpowers/test-scratch/` 下，唯一子目录，
 * **跑完不删**。共享 `TEMP`（本机是 `C:\lmstudio-temp`）不再放测试产物，也一律不清理
 * —— 那天有过一次把共享根目录整个清掉的事故，别的测试的临时文件跟着丢了。
 */
function scratchDir(label: string): string {
  const dir = join(
    process.cwd(),
    '.superpowers',
    'test-scratch',
    `${label}-${randomUUID().slice(0, 8)}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

/** provider 发出去的 chat-completions 形状（@ai-sdk/openai-compatible / deepseek 实测同形） */
const CHAT_COMPLETIONS_BODY = {
  model: 'deepseek-flash',
  messages: [
    { role: 'system', content: '你是 kyclaw。\n## Runtime snapshot' },
    { role: 'user', content: '你好' }
  ],
  tools: [{ type: 'function', function: { name: 'bash' } }],
  stream: true
}

function snapshot(overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    id: 's1',
    runId: 'run-1',
    threadId: 'thread-1',
    step: 0,
    status: 'complete',
    error: null,
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    system: '你是 kyclaw。',
    tools: '[\n  {\n    "type": "function"\n  }\n]',
    messages: [{ role: 'user', text: '你好', chars: 2, truncated: false }],
    messageCount: 2,
    toolCount: 1,
    truncated: false,
    createdAt: '2026-10-15T06:00:00.000Z',
    ...overrides
  }
}

describe('抽取：系统指令 / 工具表 / 消息清单 / 计数', () => {
  it('chat-completions 系：系统指令在 messages 里的 system 条；多条 system 合并（实测一轮三条）', () => {
    expect(systemTextOf(CHAT_COMPLETIONS_BODY)).toBe('你是 kyclaw。\n## Runtime snapshot')
    expect(
      systemTextOf({
        messages: [
          { role: 'system', content: '主指令' },
          { role: 'system', content: 'WORKING_MEMORY_SYSTEM_INSTRUCTION: 画像' },
          { role: 'system', content: [{ type: 'text', text: '规矩：回答要短' }] },
          { role: 'user', content: '你好' }
        ]
      })
    ).toBe('主指令\n\nWORKING_MEMORY_SYSTEM_INSTRUCTION: 画像\n\n规矩：回答要短')
  })

  it('anthropic 系：系统指令在 body.system（字符串 / 文本块数组）', () => {
    expect(systemTextOf({ system: '你是 kyclaw。' })).toBe('你是 kyclaw。')
    expect(
      systemTextOf({
        system: [
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' }
        ]
      })
    ).toBe('A\n\nB')
  })

  it('没有系统指令 / 认不出形状 → null（不假装空串）', () => {
    expect(systemTextOf(null)).toBeNull()
    expect(systemTextOf({ messages: [{ role: 'user', content: '你好' }] })).toBeNull()
    expect(systemTextOf({ system: '   ' })).toBeNull()
    expect(systemTextOf({ messages: '不是数组' })).toBeNull()
  })

  it('工具表：原样 pretty JSON；空表 / 没有 tools → null（"没带工具"与"没记上"分开）', () => {
    expect(toolsTextOf(CHAT_COMPLETIONS_BODY)).toBe(
      '[\n  {\n    "type": "function",\n    "function": {\n      "name": "bash"\n    }\n  }\n]'
    )
    expect(toolsTextOf({ tools: [] })).toBeNull()
    expect(toolsTextOf({ messages: [] })).toBeNull()
    expect(toolsTextOf(null)).toBeNull()
  })

  it('消息条数：认数组才计数，其余 null', () => {
    expect(messageCountOf(CHAT_COMPLETIONS_BODY)).toBe(2)
    expect(messageCountOf({ messages: [] })).toBe(0)
    expect(messageCountOf({})).toBeNull()
    expect(messageCountOf(null)).toBeNull()
  })

  it('消息清单：逐条角色 + 正文（字符串原样；结构化走 pretty JSON）', () => {
    const messages = messagesOf({
      messages: [
        { role: 'system', content: '主指令' },
        { role: 'user', content: '你好' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolName: 'read', input: { path: 'a.md' } }]
        },
        { role: 'tool', content: '文件内容' }
      ]
    })
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(messages[0]?.text).toBe('主指令')
    expect(messages[2]?.text).toContain('"toolName": "read"')
    expect(messages[3]?.text).toBe('文件内容')
    expect(messages.every((message) => message.truncated === false)).toBe(true)
  })

  it('没有 messages 数组 = 空清单（不编）', () => {
    expect(messagesOf({ tools: [] })).toEqual([])
    expect(messagesOf(null)).toEqual([])
  })
})

describe('脱敏与截断：只动这两类，正文一字不删', () => {
  it('媒体 base64 → 一行说明（图片不进库；用户写的字照旧）', () => {
    const base64 = 'A'.repeat(4000)
    const parts = bodyPartsOf({
      messages: [
        { role: 'system', content: '主指令' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
          ]
        }
      ]
    } as never)
    const user = parts.messages[1]
    expect(user?.text).toContain('看看这张图')
    expect(user?.text).toContain('<image/png 媒体已省略>')
    expect(user?.text).not.toContain(base64.slice(0, 100))
    // 用户正文的长度仍如实记着（脱敏没有把正文删光）
    expect(user?.chars).toBeGreaterThan(10)
  })

  it('密钥类键的值换掉（只在这几个键上动手，不动别的字段）', () => {
    const text = redactValue({
      apiKey: 'sk-secret',
      authorization: 'Bearer abc',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'apiKey 是我写在正文里的字，别动' }]
    })
    expect(text).toContain('"apiKey": "<已脱敏>"')
    expect(text).toContain('"authorization": "<已脱敏>"')
    expect(text).toContain('"model": "deepseek-flash"')
    // 用户正文里的字照旧（不做全文扫描）
    expect(text).toContain('apiKey 是我写在正文里的字，别动')
    expect(text).not.toContain('sk-secret')
  })

  it('系统指令走**自己的**安全上限（20 万字）：超了截断并标记', () => {
    const long = 'x'.repeat(200_001)
    const parts = bodyPartsOf({ messages: [{ role: 'system', content: long }] } as never)
    expect(parts.system?.length).toBe(200_000)
    expect(parts.messages[0]?.text.length).toBe(200_000)
    expect(parts.messages[0]?.truncated).toBe(true)
    expect(parts.truncated).toBe(true)
  })
})

describe('记账钩子：从 onFinish 事件取请求体（**逐步**）', () => {
  function collect(): {
    rows: RequestSnapshot[]
    errors: unknown[]
    record: (event: RequestFinishEvent) => Promise<void>
  } {
    const rows: RequestSnapshot[] = []
    const errors: unknown[] = []
    const store = {
      insert: async (row: RequestSnapshot) => {
        rows.push(row)
      }
    } as unknown as RequestSnapshotStore
    return {
      rows,
      errors,
      record: createRequestSnapshotRecorder({
        store,
        now: () => new Date('2026-10-15T06:00:00.000Z'),
        onError: (error) => errors.push(error)
      })
    }
  }

  it('**每个 step 一条**：第 2 步的请求体多出工具结果，两条都落', async () => {
    const { rows, record } = collect()
    await record({
      steps: [
        { request: { body: CHAT_COMPLETIONS_BODY } },
        {
          request: {
            body: {
              ...CHAT_COMPLETIONS_BODY,
              messages: [
                ...CHAT_COMPLETIONS_BODY.messages,
                { role: 'assistant', content: [{ type: 'tool-call', toolName: 'read' }] },
                { role: 'tool', content: '文件内容' }
              ]
            }
          }
        }
      ],
      model: { modelId: 'deepseek-flash', provider: 'deepseek.chat' },
      response: { dbMessages: [{ threadId: 'thread-1' }] },
      runId: 'run-1'
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      runId: 'run-1',
      threadId: 'thread-1',
      step: 0,
      status: 'complete',
      error: null,
      model: 'deepseek-flash',
      provider: 'deepseek.chat',
      messageCount: 2,
      toolCount: 1,
      createdAt: '2026-10-15T06:00:00.000Z',
      system: '你是 kyclaw。\n## Runtime snapshot'
    })
    expect(rows[0]?.tools).toContain('"name": "bash"')
    // 第 2 步：消息多了两条（助手工具调用 + 工具结果）——"后续工具结果"看得到
    expect(rows[1]?.step).toBe(1)
    expect(rows[1]?.messageCount).toBe(4)
    expect(rows[1]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool'
    ])
    expect(rows[1]?.messages[3]?.text).toBe('文件内容')
  })

  it('steps 里没有 request 时用整轮那个 request 兜底；JSON 字符串形状也认', async () => {
    const { rows, record } = collect()
    await record({
      steps: [{ usage: {} }],
      request: { body: JSON.stringify(CHAT_COMPLETIONS_BODY) },
      model: { modelId: 'deepseek-flash' }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.step).toBe(0)
    expect(rows[0]?.system).toBe('你是 kyclaw。\n## Runtime snapshot')
    expect(rows[0]?.messageCount).toBe(2)
    // 会话 id 取不到 = null（不是空串），模型 provider 同理
    expect(rows[0]).toMatchObject({ threadId: null, provider: null })
  })

  it('没有请求体 / 三样全空 → 不落行（不写空账）', async () => {
    const { rows, record } = collect()
    await record({ steps: [{ usage: {} }], model: { modelId: 'm' } })
    await record({ steps: [{ request: { body: { stream: true } } }] })
    expect(rows).toEqual([])
  })

  it('写库抛出只记日志（onError），不往上传（对话不受影响）', async () => {
    const errors: unknown[] = []
    const record = createRequestSnapshotRecorder({
      store: {
        insert: async () => {
          throw new Error('库锁住了')
        }
      } as unknown as RequestSnapshotStore,
      onError: (error) => errors.push(error)
    })

    await expect(record({ steps: [{ request: { body: CHAT_COMPLETIONS_BODY } }] })).resolves.toBe(
      undefined
    )
    expect(errors).toHaveLength(1)
  })
})

describe('失败请求的记录（onFinish 不触发时的那一行）', () => {
  it('落一行 status=error：会话 / 原因在，正文如实留空', async () => {
    const rows: RequestSnapshot[] = []
    const record = createRequestFailureRecorder({
      store: {
        insert: async (row: RequestSnapshot) => {
          rows.push(row)
        }
      } as unknown as RequestSnapshotStore,
      now: () => new Date('2026-10-15T06:00:00.000Z')
    })

    await record({ threadId: 'thread-1', runId: 'run-1', error: 'Bad Request' })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      threadId: 'thread-1',
      runId: 'run-1',
      step: null,
      status: 'error',
      error: 'Bad Request',
      // 正文**空着**：provider 报错时拿不到请求体，不编一份"本该发出去的东西"
      system: null,
      tools: null,
      messages: [],
      messageCount: null,
      toolCount: null,
      truncated: false
    })
  })

  it('原因里带媒体 base64 也脱敏；空原因给人话', async () => {
    const rows: RequestSnapshot[] = []
    const record = createRequestFailureRecorder({
      store: {
        insert: async (row: RequestSnapshot) => {
          rows.push(row)
        }
      } as unknown as RequestSnapshotStore
    })

    await record({ threadId: null, error: `图太大 data:image/png;base64,${'A'.repeat(500)}` })
    await record({ threadId: null, error: '   ' })
    await record({
      threadId: null,
      error: '{"message":"Engine protocol predict request returned 400","name":"Error"}'
    })

    expect(rows[0]?.error).toContain('媒体已省略')
    expect(rows[0]?.error).not.toContain('A'.repeat(100))
    expect(rows[1]?.error).toBe('请求失败（原因未报）')
    // 错误对象整个 JSON 塞进来时取里面的 message（原文解析，不是改写）
    expect(rows[2]?.error).toBe('Engine protocol predict request returned 400')
  })
})

describe('上限与截断（安全上限 / 条数 / 总量：命中都要标记）', () => {
  it('日常长度的正文**不再被截断**：9,000 字的消息照原样落（旧口径 8,000 字就砍）', () => {
    const long = '甲'.repeat(9_000)
    const parts = bodyPartsOf({ messages: [{ role: 'user', content: long }] } as never)
    expect(parts.messages[0]?.text.length).toBe(9_000)
    expect(parts.messages[0]?.truncated).toBe(false)
    expect(parts.truncated).toBe(false)
  })

  it('安全上限（单条 20 万字）才截断并标记 —— 兜底，不是门槛', () => {
    const huge = '乙'.repeat(200_001)
    const parts = bodyPartsOf({ messages: [{ role: 'tool', content: huge }] } as never)
    expect(parts.messages[0]?.chars).toBe(200_001)
    expect(parts.messages[0]?.text.length).toBe(200_000)
    expect(parts.messages[0]?.truncated).toBe(true)
    expect(parts.truncated).toBe(true)
  })

  it('条数超上限（400）：只留**最后** 400 条，且**标记 truncated**（丢弃也算截断）', () => {
    const messages = Array.from({ length: 450 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${index + 1} 条`
    }))
    const parts = bodyPartsOf({ messages } as never)
    expect(parts.messages).toHaveLength(400)
    expect(parts.messages[0]?.text).toBe('第 51 条')
    expect(parts.messages[399]?.text).toBe('第 450 条')
    // 真实条数照记（界面据此说"前面 N 条未保留"），并且**这一份请求被标成已截断**
    expect(parts.messageCount).toBe(450)
    expect(parts.truncated).toBe(true)
  })

  it('总量超上限（200 万字）：从**最旧的**开始丢，同样标记 truncated', () => {
    // 11 条 × 20 万字 = 220 万字 > 200 万 → 必须丢掉最旧的那几条
    const messages = Array.from({ length: 11 }, (_, index) => ({
      role: 'user',
      content: `#${index + 1} `.padEnd(200_000, '丙')
    }))
    const parts = bodyPartsOf({ messages } as never)
    expect(parts.messages.length).toBeLessThan(11)
    expect(parts.messages[0]?.text.startsWith('#2')).toBe(true)
    expect(parts.truncated).toBe(true)
  })

  it('媒体与二进制：data: 图片、**裸 base64**、Uint8Array 都只留说明（正文一字不删）', () => {
    // 裸 base64 要"三类字符齐"才算（见 looksLikeBase64）：真图片 base64 就是这个样子
    const bare = 'Ab3+/x'.repeat(100)
    const parts = bodyPartsOf({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看一眼这张图' },
            { type: 'image', image: bare },
            { type: 'file', data: new Uint8Array(2048) }
          ]
        }
      ]
    } as never)
    const text = parts.messages[0]?.text ?? ''
    expect(text).toContain('看一眼这张图')
    expect(text).toContain('<base64 数据已省略（600 字符）>')
    expect(text).toContain('<2048 字节二进制>')
    expect(text).not.toContain(bare.slice(0, 100))
  })

  it('**长正文不会被当成裸 base64**：18 万字的连续小写正文原样留着（旧规则会整段换掉）', () => {
    // 这串没有空格、长度也过了 512 的门槛 —— 只靠"长度"判定就会把它当裸 base64 换掉；
    // 真实判定还要求大小写/数字/符号至少三类（见 looksLikeBase64）
    const prose = 'x'.repeat(180_000)
    const parts = bodyPartsOf({ messages: [{ role: 'user', content: prose }] } as never)
    expect(parts.messages[0]?.text).toBe(prose)
    expect(parts.messages[0]?.chars).toBe(180_000)
    expect(parts.messages[0]?.truncated).toBe(false)
  })

  it('失败原因里的凭据串先脱敏再落库（provider 常回显请求头/请求体）', async () => {
    const rows: RequestSnapshot[] = []
    const record = createRequestFailureRecorder({
      store: {
        insert: async (row: RequestSnapshot) => {
          rows.push(row)
        }
      } as unknown as RequestSnapshotStore
    })

    await record({
      threadId: 'thread-1',
      runId: 'run-1',
      error: [
        'AI_APICallError: 401',
        'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345',
        'apiKey="sk-0123456789abcdefghijkl"',
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSM'
      ].join(' | ')
    })

    const stored = rows[0]?.error ?? ''
    expect(stored).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    expect(stored).not.toContain('sk-0123456789abcdefghijkl')
    expect(stored).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(stored).toContain('Bearer <已脱敏>')
    expect(stored).toContain('已脱敏')
  })

  it('redactSecretsInText：各类凭据串都换掉，普通人话原样', () => {
    expect(redactSecretsInText('key=sk-ABCDEFGHIJKLMNOPQRST')).toContain('sk-<已脱敏>')
    expect(redactSecretsInText('Bearer abcdefghijklmnop')).toBe('Bearer <已脱敏>')
    expect(redactSecretsInText('api_key: abcdefghijklmnop')).toBe('api_key=<已脱敏>')
    expect(redactSecretsInText('d41d8cd98f00b204e9800998ecf8427e')).toBe('<十六进制串已脱敏>')
    // 普通错误人话不动（只换"一眼是凭据"的串）
    expect(redactSecretsInText('模型配置不完整：缺 API 密钥')).toBe('模型配置不完整：缺 API 密钥')
  })
})

describe('UI 消息流的失败观察者（三个入口共用）', () => {
  it('error part → 交给 note（原文照传，包括"原因未报"）；其余 part 原样放行', async () => {
    const noted: string[] = []
    const source = new ReadableStream<Record<string, unknown>>({
      start(controller) {
        controller.enqueue({ type: 'text-delta', delta: '好' })
        controller.enqueue({ type: 'error', errorText: 'Bad Request' })
        controller.enqueue({ type: 'error', errorText: { message: '对象形状' } })
        controller.enqueue({ type: 'error' })
        controller.close()
      }
    })

    const out: Array<Record<string, unknown>> = []
    const tapped = tapStreamFailures(source, (errorText) => noted.push(errorText))
    const reader = tapped.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(value)
    }

    expect(noted).toEqual(['Bad Request', '对象形状', '请求失败（原因未报）'])
    // 流**一个 part 都没少**（只观察、不改流）
    expect(out.map((part) => part.type)).toEqual(['text-delta', 'error', 'error', 'error'])
  })

  it('errorTextOf：对象 JSON 取 message，别的原样', () => {
    expect(errorTextOf('{"message":"超上下文","name":"Error"}')).toBe('超上下文')
    expect(errorTextOf('  engine 400  ')).toBe('engine 400')
    expect(errorTextOf('{"name":"Error"}')).toBe('{"name":"Error"}')
  })
})
describe('请求快照 store（真 libsql：快照行 + 正文池）', () => {
  let dir: string
  let storage: LibSQLStore
  let store: RequestSnapshotStore

  beforeAll(async () => {
    // 工作区内的临时目录（不碰共享 TEMP），跑完**不删**（见文件头 scratchDir 的口径）
    dir = scratchDir('request-log')
    storage = new LibSQLStore({
      id: 'kyclaw-request-log',
      url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
    store = createRequestSnapshotStore(usageSqlClient(storage))
    await store.ensureTable()
  })

  afterAll(async () => {
    await storage?.close()
  })

  it('摘要按会话读回：时间升序、字段逐个对上；别的会话不串行', async () => {
    await store.insert(snapshot({ id: 's2', createdAt: '2026-10-15T07:00:00.000Z' }))
    await store.insert(snapshot({ id: 's1', createdAt: '2026-10-15T06:00:00.000Z' }))
    await store.insert(
      snapshot({ id: 'other', threadId: 'thread-2', createdAt: '2026-10-15T06:30:00.000Z' })
    )

    const rows = await store.listByThread('thread-1')
    expect(rows.map((row) => row.id)).toEqual(['s1', 's2'])
    expect(rows[0]).toEqual({
      id: 's1',
      runId: 'run-1',
      threadId: 'thread-1',
      step: 0,
      status: 'complete',
      error: null,
      model: 'deepseek-flash',
      provider: 'deepseek.chat',
      messageCount: 2,
      toolCount: 1,
      systemChars: 10,
      toolsChars: 34,
      truncated: false,
      createdAt: '2026-10-15T06:00:00.000Z'
    })
    expect(await store.listByThread('none')).toEqual([])
  })

  it('正文按 id 取回：系统指令 / 工具表 / 消息清单逐个对上', async () => {
    const detail = await store.detail('s1')
    expect(detail).toMatchObject({
      id: 's1',
      system: '你是 kyclaw。',
      tools: '[\n  {\n    "type": "function"\n  }\n]',
      messages: [{ role: 'user', text: '你好', chars: 2, truncated: false }]
    })
    expect(await store.detail('nope')).toBeNull()
  })

  it('空字段读写一致：system / tools / 计数为 null 时读回也是 null（不是空串 / 0）', async () => {
    await store.insert(
      snapshot({
        id: 's3',
        createdAt: '2026-10-15T08:00:00.000Z',
        status: 'error',
        error: 'Bad Request',
        step: null,
        runId: null,
        provider: null,
        system: null,
        tools: null,
        messages: [],
        messageCount: null,
        toolCount: null
      })
    )

    const row = (await store.listByThread('thread-1')).find((entry) => entry.id === 's3')
    expect(row).toMatchObject({
      runId: null,
      provider: null,
      step: null,
      status: 'error',
      error: 'Bad Request',
      systemChars: null,
      toolsChars: null,
      messageCount: null,
      toolCount: null
    })
    expect((await store.detail('s3'))?.messages).toEqual([])
  })

  it('同一段正文只存一份（内容哈希去重）：三段相同系统指令 → 正文池里一行', async () => {
    const client = usageSqlClient(storage)
    for (const id of ['d1', 'd2', 'd3'])
      await store.insert(
        snapshot({
          id,
          createdAt: `2026-10-15T09:0${id.slice(1)}:00.000Z`,
          threadId: 'thread-dedupe'
        })
      )
    const rows = await store.listByThread('thread-dedupe')
    expect(rows).toHaveLength(3)

    const counted = await client.execute(
      `SELECT COUNT(*) AS n FROM "request_blobs" WHERE "text" = '你是 kyclaw。'`
    )
    expect(Number((counted.rows[0] as { n?: unknown }).n)).toBe(1)
    // 三行的摘要形状一致（正文都指同一份）
    expect(new Set(rows.map((row) => row.systemChars))).toEqual(new Set([10]))
    expect((await store.detail('d2'))?.system).toBe('你是 kyclaw。')
  })

  it('消息正文**分块**去重且逐字重建：同一段长正文在两次请求里只存一套分块', async () => {
    const client = usageSqlClient(storage)
    // 9,000 字（> 4,096 的分块大小 → 3 块）；两次请求里的这一条一模一样
    const long = '丁'.repeat(9_000)
    const one = {
      ...snapshot({ id: 'chunk-1', threadId: 'thread-chunk' }),
      messages: [{ role: 'tool', text: long, chars: long.length, truncated: false }]
    }
    await store.insert(one)
    await store.insert({
      ...one,
      id: 'chunk-2',
      createdAt: '2026-10-15T09:10:00.000Z'
    })

    // 分块入池：3 块里前两块内容**完全相同**（都是 4096 个"丁"）→ 只落 2 行
    // （分块内去重也算数：不是 3 行，更不是 2 份整段 6 行）
    const counted = await client.execute(
      `SELECT COUNT(*) AS n FROM "request_blobs" WHERE "text" LIKE '丁%'`
    )
    expect(Number((counted.rows[0] as { n?: unknown }).n)).toBe(2)

    // 重建逐字等值（分块拼接不改一个字符）
    const detail = await store.detail('chunk-2')
    expect(detail?.messages[0]?.text).toBe(long)
    expect(detail?.messages[0]?.truncated).toBe(false)
  })

  it('早先那版落的行也读得出来（message_refs 的单哈希形状）与**老表补列**', async () => {
    const client = usageSqlClient(storage)
    const hash = 'a'.repeat(32)
    await client.execute({
      sql: `INSERT OR IGNORE INTO "request_blobs" ("hash", "text") VALUES (?, ?)`,
      args: [hash, '旧形状的正文']
    })
    // 早先那版：message_refs 里是 `hash` 而不是 `chunks`
    await client.execute({
      sql: `INSERT OR REPLACE INTO "request_snapshots"
        ("id", "run_id", "thread_id", "step", "status", "error", "model", "provider", "message_refs", "message_count", "created_at")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'legacy-ref',
        'run-legacy',
        'thread-legacy',
        0,
        'complete',
        null,
        'deepseek-flash',
        null,
        JSON.stringify([{ role: 'user', hash, chars: 6, truncated: false }]),
        1,
        '2026-10-15T05:00:00.000Z'
      ]
    })
    const detail = await store.detail('legacy-ref')
    expect(detail?.messages).toEqual([
      { role: 'user', text: '旧形状的正文', chars: 6, truncated: false }
    ])

    // 老表（列名不同 / 少列）：ensureTable 补列后照样能写能读
    const legacyDir = scratchDir('request-log-legacy-table')
    const legacyStorage = new LibSQLStore({
      id: 'kyclaw-request-log-legacy',
      url: `file:${join(legacyDir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
    try {
      const legacyClient = usageSqlClient(legacyStorage)
      await legacyClient.execute(
        `CREATE TABLE "request_snapshots" (
          "id" TEXT PRIMARY KEY,
          "model" TEXT NOT NULL,
          "system_text" TEXT,
          "tools_json" TEXT,
          "created_at" TEXT NOT NULL
        )`
      )
      const legacyStore = createRequestSnapshotStore(legacyClient)
      await legacyStore.insert(snapshot({ id: 'migrated', threadId: 'thread-migrated' }))
      const rows = await legacyStore.listByThread('thread-migrated')
      expect(rows.map((row) => row.id)).toEqual(['migrated'])
      expect((await legacyStore.detail('migrated'))?.system).toBe('你是 kyclaw。')
    } finally {
      await legacyStorage.close()
    }
  })
})
