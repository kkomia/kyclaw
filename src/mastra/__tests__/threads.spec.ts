// @vitest-environment node
/**
 * 线程 API 的 HTTP 行为（T9 Step 2）：挂在既有 agent 服务上，和 chat 路由同一道 token 闸门。
 *
 * 覆盖：列表（只认 local-user）/ 消息回灌 / 重命名 / 删除级联 / 截断重发（R2 服务端半边）/
 * 标题生成（模型被调 + 落库；失败降级截断首句）+ 断流语义的端到端证据（客户端断开 = 服务端取消，
 * 半截回复会落库——这条决定了渲染端"切走不掐流"的设计，见 report）。
 *
 * 全链路真跑：libsql 落临时目录、Mastra agent（mock 模型）真执行、SSE 真读，
 * 断言只针对 HTTP 状态码与 JSON 回包。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { LOCAL_USER_RESOURCE_ID, threadMemoryBody } from '../../shared/threads'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'

const AGENT_ID = 'kyclaw-agent'
const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_REASON = { unified: 'stop' as const, raw: 'stop' }

interface MockOptions {
  /** 流式回复的增片段（chat 用） */
  replyChunks: string[]
  /** generate（标题生成用）回吐的文本；不给就抛错（降级路径） */
  generateText?: string
  /** 每段之间的延迟（断流用例用） */
  chunkDelayMs?: number
}

function mockModel(options: MockOptions): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'kyclaw-test-mock',
    modelId: 'kyclaw-test-mock',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          ...options.replyChunks.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: FINISH_REASON, usage: USAGE }
        ],
        initialDelayInMs: 0,
        chunkDelayInMs: options.chunkDelayMs ?? 0
      })
    }),
    doGenerate:
      options.generateText === undefined
        ? async () => {
            throw new Error('标题生成被要求失败（测试）')
          }
        : async () => ({
            content: [{ type: 'text' as const, text: options.generateText! }],
            finishReason: FINISH_REASON,
            usage: USAGE,
            warnings: []
          })
  })
}

let dir: string
const started: AgentServerHandle[] = []

beforeEach(() => {
  // 每个用例一份空库：列表/删除类断言要的是"这个用例自己的世界"
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-threads-'))
})

afterEach(async () => {
  for (const handle of started.splice(0)) await handle.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

async function start(
  options: Partial<Parameters<typeof startAgentServer>[0]> = {}
): Promise<AgentServerHandle> {
  const handle = await startAgentServer({
    dataDir: dir,
    model: mockModel({ replyChunks: ['回复。'] }) as never,
    ...options
  })
  started.push(handle)
  return handle
}

function authed(server: AgentServerHandle, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`,
      ...init.headers
    }
  }
}

/** 发一轮对话（带线程语义），把 SSE 读完 */
async function say(
  server: AgentServerHandle,
  options: { threadId: string; messages: unknown[]; resource?: string; trigger?: string }
): Promise<Response> {
  return fetch(`${server.baseUrl}/chat/${AGENT_ID}`, {
    method: 'POST',
    ...authed(server),
    body: JSON.stringify({
      messages: options.messages,
      // 线程上下文用与渲染端同一个构造函数：两边口径写岔了这里就红
      ...(options.resource === undefined
        ? threadMemoryBody(options.threadId)
        : { memory: { thread: options.threadId, resource: options.resource } }),
      ...(options.trigger === undefined ? {} : { trigger: options.trigger })
    })
  })
}

function userMessage(id: string, text: string): unknown {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMessage(id: string, text: string): unknown {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

async function listThreads(
  server: AgentServerHandle
): Promise<{ id: string; title: string | null; updatedAt: string }[]> {
  const response = await fetch(`${server.baseUrl}/api/threads`, authed(server))
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    threads: { id: string; title: string | null; updatedAt: string }[]
  }
  return body.threads
}

async function threadMessages(
  server: AgentServerHandle,
  threadId: string
): Promise<{ id: string; role: string; content: { parts?: { type: string; text?: string }[] } }[]> {
  const response = await fetch(`${server.baseUrl}/api/threads/${threadId}/messages`, authed(server))
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    messages: { id: string; role: string; content: { parts?: { type: string; text?: string }[] } }[]
  }
  return body.messages
}

/** 一轮问答（确定性 mock：回复 = replyChunks 拼接） */
async function turn(
  server: AgentServerHandle,
  threadId: string,
  index: number,
  question: string
): Promise<void> {
  const history: unknown[] = []
  for (let i = 1; i < index; i++) {
    history.push(userMessage(`u${i}`, `问题${i}`), assistantMessage(`a${i}`, '回复。'))
  }
  history.push(userMessage(`u${index}`, question))
  const response = await say(server, { threadId, messages: history })
  expect(response.status).toBe(200)
  await response.text()
  // 落库是流收尾的收尾：轮询到消息真的在（避免用例之间的竞态）
  for (let attempt = 0; attempt < 50; attempt++) {
    const messages = await threadMessages(server, threadId)
    if (messages.some((message) => message.id === `u${index}`)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`消息 u${index} 未在预期时间内落库`)
}

describe('线程 API：token 闸门与 zod 入参', () => {
  it('五个路由没 token 一律 401（token 是唯一闸门）', async () => {
    const server = await start()

    const requests = [
      fetch(`${server.baseUrl}/api/threads`),
      fetch(`${server.baseUrl}/api/threads/t1`, { method: 'DELETE' }),
      fetch(`${server.baseUrl}/api/threads/t1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' })
      }),
      fetch(`${server.baseUrl}/api/threads/t1/messages`),
      fetch(`${server.baseUrl}/api/threads/t1/truncate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'm1' })
      }),
      fetch(`${server.baseUrl}/api/threads/t1/title`, { method: 'POST' })
    ]
    const responses = await Promise.all(requests)
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401])
  }, 60_000)

  it('重命名/截断的坏入参被 zod 挡住（400），不进业务逻辑', async () => {
    const server = await start()
    await turn(server, 'thread-zod', 1, '你好')

    const badRename = await fetch(
      `${server.baseUrl}/api/threads/thread-zod`,
      authed(server, { method: 'PATCH', body: JSON.stringify({ title: '   ' }) })
    )
    expect(badRename.status).toBe(400)

    const badTruncate = await fetch(
      `${server.baseUrl}/api/threads/thread-zod/truncate`,
      authed(server, { method: 'POST', body: JSON.stringify({}) })
    )
    expect(badTruncate.status).toBe(400)

    const notJson = await fetch(
      `${server.baseUrl}/api/threads/thread-zod/truncate`,
      authed(server, { method: 'POST', body: '不是 json' })
    )
    expect(notJson.status).toBe(400)
  }, 60_000)
})

describe('GET /api/threads：列表', () => {
  it('列出 local-user 的线程（id/title/updatedAt），最新在前；别人的资源不出现', async () => {
    const server = await start()

    await turn(server, 'thread-old', 1, '第一段会话')
    await turn(server, 'thread-new', 1, '第二段会话')
    const foreign = await say(server, {
      threadId: 'thread-foreign',
      messages: [userMessage('uF', '别人的')],
      resource: 'other-user'
    })
    await foreign.text()

    const threads = await listThreads(server)

    expect(threads.map((thread) => thread.id)).toEqual(['thread-new', 'thread-old'])
    expect(threads[0]).toMatchObject({ id: 'thread-new', title: null })
    expect(new Date(threads[0].updatedAt).toString()).not.toBe('Invalid Date')
  }, 60_000)

  it('一轮对话后：用户/助手消息都在存储里（回灌的来源），用户消息 id 原样保留', async () => {
    const server = await start({
      model: mockModel({ replyChunks: ['你好，', '我是 kyclaw。'] }) as never
    })
    await turn(server, 'thread-msg', 1, '做个自我介绍')

    const messages = await threadMessages(server, 'thread-msg')

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0].id).toBe('u1')
    expect(messages[0].content.parts?.[0]).toMatchObject({ type: 'text', text: '做个自我介绍' })
    expect(messages[1].content.parts?.[0]).toMatchObject({
      type: 'text',
      text: '你好，我是 kyclaw。'
    })
  }, 60_000)

  it('不存在的线程：消息回灌返回空数组（新建会话还没发消息就有这条路径）', async () => {
    const server = await start()

    expect(await threadMessages(server, 'thread-missing')).toEqual([])
  }, 60_000)
})

describe('PATCH /api/threads/:id：重命名', () => {
  it('改标题落库，列表里立刻可见；空标题/不存在分别 400/404', async () => {
    const server = await start()
    await turn(server, 'thread-rename', 1, '随便聊聊')

    const renamed = await fetch(
      `${server.baseUrl}/api/threads/thread-rename`,
      authed(server, { method: 'PATCH', body: JSON.stringify({ title: '  自己改的名字  ' }) })
    )
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ id: 'thread-rename', title: '自己改的名字' })

    expect((await listThreads(server)).find((thread) => thread.id === 'thread-rename')?.title).toBe(
      '自己改的名字'
    )

    const missing = await fetch(
      `${server.baseUrl}/api/threads/thread-missing`,
      authed(server, { method: 'PATCH', body: JSON.stringify({ title: 'x' }) })
    )
    expect(missing.status).toBe(404)
  }, 60_000)
})

describe('DELETE /api/threads/:id：级联删消息', () => {
  it('删线程连消息一起删；别的线程不受影响；重复删幂等', async () => {
    const server = await start()
    await turn(server, 'thread-a', 1, '甲')
    await turn(server, 'thread-b', 1, '乙')

    const deleted = await fetch(
      `${server.baseUrl}/api/threads/thread-a`,
      authed(server, { method: 'DELETE' })
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })

    expect((await listThreads(server)).map((thread) => thread.id)).toEqual(['thread-b'])
    expect(await threadMessages(server, 'thread-a')).toEqual([])
    expect((await threadMessages(server, 'thread-b')).length).toBeGreaterThan(0)

    const again = await fetch(
      `${server.baseUrl}/api/threads/thread-a`,
      authed(server, { method: 'DELETE' })
    )
    expect(again.status).toBe(200)
  }, 60_000)
})

describe('POST /api/threads/:id/truncate：编辑重发的服务端半边（R2）', () => {
  it('从 messageId 起连它一起删；然后同 id 重发，存储里只剩新版本', async () => {
    const server = await start()
    await turn(server, 'thread-t', 1, '第一个问题')
    await turn(server, 'thread-t', 2, '第二个问题')

    expect(await threadMessages(server, 'thread-t')).toHaveLength(4)

    const truncated = await fetch(
      `${server.baseUrl}/api/threads/thread-t/truncate`,
      authed(server, { method: 'POST', body: JSON.stringify({ messageId: 'u2' }) })
    )
    expect(truncated.status).toBe(200)
    expect(await truncated.json()).toEqual({ deleted: 2 })

    const remaining = await threadMessages(server, 'thread-t')
    expect(remaining.map((message) => message.id)).toEqual(['u1', expect.any(String)])

    // 编辑重发：同一个消息 id、新文本（客户端 useChat 的行为）
    const resend = await say(server, {
      threadId: 'thread-t',
      messages: [
        userMessage('u1', '第一个问题'),
        assistantMessage('a1', '回复。'),
        userMessage('u2', '第二个问题（改）')
      ]
    })
    await resend.text()

    for (let attempt = 0; attempt < 50; attempt++) {
      const messages = await threadMessages(server, 'thread-t')
      const u2 = messages.find((message) => message.id === 'u2')
      if (u2?.content.parts?.[0].text === '第二个问题（改）' && messages.length === 4) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const final = await threadMessages(server, 'thread-t')
    expect(final).toHaveLength(4)
    expect(final[2].content.parts?.[0]).toMatchObject({ type: 'text', text: '第二个问题（改）' })
  }, 60_000)

  it('消息/线程不存在时 deleted=0（幂等，不报错）', async () => {
    const server = await start()
    await turn(server, 'thread-t2', 1, '在吗')

    const unknownMessage = await fetch(
      `${server.baseUrl}/api/threads/thread-t2/truncate`,
      authed(server, { method: 'POST', body: JSON.stringify({ messageId: '不存在' }) })
    )
    expect(await unknownMessage.json()).toEqual({ deleted: 0 })

    const unknownThread = await fetch(
      `${server.baseUrl}/api/threads/thread-missing/truncate`,
      authed(server, { method: 'POST', body: JSON.stringify({ messageId: 'u1' }) })
    )
    expect(await unknownThread.json()).toEqual({ deleted: 0 })
  }, 60_000)
})

describe('POST /api/threads/:id/title：标题生成', () => {
  it('首轮后调模型生成，清理后落库；已有标题不再调模型', async () => {
    const model = mockModel({ replyChunks: ['回复。'], generateText: '「电源管理对比表」' })
    const server = await start({ model: model as never })
    await turn(server, 'thread-title', 1, '帮我把电源管理的调研资料整理成对比表')

    const before = model.doGenerateCalls.length
    const generated = await fetch(
      `${server.baseUrl}/api/threads/thread-title/title`,
      authed(server, { method: 'POST' })
    )
    expect(generated.status).toBe(200)
    expect(await generated.json()).toEqual({ title: '电源管理对比表', generated: true })
    expect(model.doGenerateCalls.length).toBe(before + 1)
    // 送给模型的素材就是首条用户消息
    const prompt = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt)
    expect(prompt).toContain('电源管理的调研资料')

    expect((await listThreads(server)).find((thread) => thread.id === 'thread-title')?.title).toBe(
      '电源管理对比表'
    )

    const again = await fetch(
      `${server.baseUrl}/api/threads/thread-title/title`,
      authed(server, { method: 'POST' })
    )
    expect(await again.json()).toEqual({ title: '电源管理对比表', generated: false })
    expect(model.doGenerateCalls.length).toBe(before + 1)
  }, 60_000)

  it('模型生成失败 → 降级截断首句，照常落库', async () => {
    // doGenerate 抛错（mockModel 的缺省行为）；chat 的流式回复不受影响
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const server = await start()
      await turn(server, 'thread-fallback', 1, '帮我把资料整理成对比表。另外做个图表')

      const response = await fetch(
        `${server.baseUrl}/api/threads/thread-fallback/title`,
        authed(server, { method: 'POST' })
      )
      expect(await response.json()).toEqual({ title: '帮我把资料整理成对比表', generated: true })
      expect(
        (await listThreads(server)).find((thread) => thread.id === 'thread-fallback')?.title
      ).toBe('帮我把资料整理成对比表')
    } finally {
      warn.mockRestore()
    }
  }, 60_000)

  it('线程不存在 → 404', async () => {
    const server = await start()

    const response = await fetch(
      `${server.baseUrl}/api/threads/thread-missing/title`,
      authed(server, { method: 'POST' })
    )
    expect(response.status).toBe(404)
  }, 60_000)
})

describe('DELETE：流式中的会话也要删得掉', () => {
  it('先停再删（客户端的真实顺序）：线程与消息都不复活', async () => {
    const server = await start({
      model: mockModel({
        replyChunks: ['第一段。', '第二段。', '第三段。'],
        chunkDelayMs: 400
      }) as never
    })

    const controller = new AbortController()
    const response = await fetch(`${server.baseUrl}/chat/${AGENT_ID}`, {
      method: 'POST',
      ...authed(server),
      body: JSON.stringify({
        messages: [userMessage('u1', '慢慢说')],
        ...threadMemoryBody('thread-del')
      }),
      signal: controller.signal
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    while (!seen.includes('第一段。')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }

    // 渲染端的顺序：先停（断开这一轮）→ 再删。DELETE 里先掐运行、等落库、再删线程；
    // 少了这一步，"取消 → 半截回复落库"会把线程行写回来（T9 实测到的复活）
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const deleted = await fetch(
      `${server.baseUrl}/api/threads/thread-del`,
      authed(server, { method: 'DELETE' })
    )
    expect(deleted.status).toBe(200)

    // 给"取消引发的落库"足够的时间窗（正常几百毫秒内发生）
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await listThreads(server)).map((thread) => thread.id)).not.toContain('thread-del')
    expect(await threadMessages(server, 'thread-del')).toEqual([])
  }, 60_000)
})

describe('断流语义（spec §7.2 的端到端证据）', () => {
  it('客户端断开：服务端取消本轮，半截助手回复会落库（不续写）', async () => {
    // 段间 1.5s：给"读到第一段就断开"留出足够余量（读取循环被调度晚一点也不会整条流已到齐）
    const server = await start({
      model: mockModel({
        replyChunks: ['第一段。', '第二段。', '第三段。'],
        chunkDelayMs: 1500
      }) as never
    })

    const controller = new AbortController()
    const response = await fetch(`${server.baseUrl}/chat/${AGENT_ID}`, {
      method: 'POST',
      ...authed(server),
      body: JSON.stringify({
        messages: [userMessage('u1', '慢慢说')],
        memory: { thread: 'thread-abort', resource: LOCAL_USER_RESOURCE_ID }
      }),
      signal: controller.signal
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    while (!seen.includes('第一段。')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    // 前提断言：断开必须发生在"这一轮还没跑完"的时候，否则这条用例证明不了任何事
    expect(seen).not.toContain('第二段')
    controller.abort()
    // 若服务端继续跑，1.5s 一段的第三段也早该出完了（这里只等一个"够晚"的时间窗）
    await new Promise((resolve) => setTimeout(resolve, 4000))

    const messages = await threadMessages(server, 'thread-abort')
    const assistant = messages.find((message) => message.role === 'assistant')
    const assistantText = (assistant?.content.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')

    // 取消落在哪一步决定落库结果：可能什么都没存（取消早于落库），也可能存到断开为止
    // （两种都实测到过）。**确定不变的**是这一轮不会继续跑完——后两段永远不会出现。
    // 这也正是渲染端"切走不掐连接"的理由：断开语义不可控，用户可见的结果要靠不断开来保证。
    expect(assistantText).not.toContain('第二段')
    expect(assistantText).not.toContain('第三段')
    expect(['', '第一段。']).toContain(assistantText)
  }, 60_000)
})
