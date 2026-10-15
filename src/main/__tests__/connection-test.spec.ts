// @vitest-environment node
/**
 * "测试连接"（main/connection-test.ts，用户反馈 005）：分项验证 连通 / 流式 / **流式工具**，
 * 并把结论翻译成 延迟 / 四档状态（通过·失败·未验证·没跑）/ 一句人话。
 *
 * 用例打本地假供应商（127.0.0.1 随机端口），零外部网络。验的是四件事：
 *   ① 请求真的发出去了，而且工具那一步是**流式**的（用户场景就是流式 + 工具表）；
 *   ② 拿不到正面证据的都不算通过：只有思考 / 截断 / 断流 / 没调工具 / 工具参数不合法；
 *   ③ 探针工具**只读**、参数要过校验、真执行才认；
 *   ④ 文案里真的没有密钥（含只回显一部分、URL 里带凭据）。
 * 判据本身的边界（各档状态的组合）另用注入式用例逐条钉，不去构造离奇的 SSE。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderConfig } from '../../shared/providers'
import {
  PROBE_ECHO,
  PROBE_TOOL_NAME,
  PROBE_TOOL_OUTPUT,
  testConnection,
  TEST_MAX_OUTPUT_TOKENS,
  type StreamOutcome,
  type ToolRunOutcome
} from '../connection-test'

const KEY = 'sk-conn-4c8e0a6f-SECRET'

type RequestLog = { url?: string; authorization?: string; body: Record<string, unknown> }

const openServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close()
})

/** 一条 OpenAI 兼容的正文回包（非流式） */
function completion(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  })
}

/** 拼一条 SSE：每个元素都是 `choices[0].delta` */
function sse(chunks: Array<Record<string, unknown>>, finish: string | null = 'stop'): string {
  const lines = chunks.map(
    (delta) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-sse',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: null }]
      })}\n\n`
  )
  if (finish !== null) {
    lines.push(
      `data: ${JSON.stringify({
        id: 'chatcmpl-sse',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: finish }]
      })}\n\n`
    )
  }
  lines.push('data: [DONE]\n\n')
  return lines.join('')
}

/** 正文的 SSE（`text` = 真被消费的正文；`reasoning` = 思考增量） */
function sseText(options: { text?: string; reasoning?: string; finish?: string | null }): string {
  const chunks: Array<Record<string, unknown>> = [{ role: 'assistant' }]
  if (options.reasoning !== undefined) chunks.push({ reasoning_content: options.reasoning })
  if (options.text !== undefined) chunks.push({ content: options.text })
  return sse(chunks, options.finish === undefined ? 'stop' : options.finish)
}

/** 工具调用的 SSE（OpenAI 兼容的流式 tool_calls 分片） */
function sseToolCall(options: { name?: string; args: string; finish?: string | null }): string {
  return sse(
    [
      { role: 'assistant' },
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: options.name ?? PROBE_TOOL_NAME, arguments: options.args }
          }
        ]
      }
    ],
    options.finish === undefined ? 'tool_calls' : options.finish
  )
}

/** 探针的合法调用（`{"echo":"ok"}`） */
const PROBE_CALL_OK = JSON.stringify({ echo: PROBE_ECHO })

/**
 * 一个"会看请求体"的假供应商：
 *   - `stream: true` + 带 `tools` → 回工具调用的 SSE；
 *   - `stream: true` → 回正文的 SSE；
 *   - 其余 → 回一条普通正文。
 * `respond` 给用例自己接管（返回 true = 已经答复完）。
 */
async function fakeProvider(
  respond?: (request: RequestLog, response: ServerResponse) => boolean
): Promise<{ log: RequestLog[]; config: ProviderConfig }> {
  const log: RequestLog[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: RequestLog = {
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      }
      log.push(entry)
      if (respond?.(entry, response) === true) return

      if (entry.body.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          entry.body.tools === undefined
            ? sseText({ text: 'pong' })
            : sseToolCall({ args: PROBE_CALL_OK })
        )
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(completion('pong'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  openServers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  })
  return {
    log,
    config: {
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      isDefault: true
    }
  }
}

/** 只服务工具调用那一步的假供应商：`text` 是工具的 SSE 正文（其余两趟走默认答复） */
async function providerWithToolStream(text: string): Promise<{
  log: RequestLog[]
  config: ProviderConfig
}> {
  return fakeProvider((entry, response) => {
    if (entry.body.stream === true && entry.body.tools !== undefined) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(text)
      return true
    }
    return false
  })
}

type Result = Awaited<ReturnType<typeof testConnection>>

function statusOf(result: Result, id: string): string {
  return result.steps.find((step) => step.id === id)?.status ?? '(缺这一步)'
}

function detailOf(result: Result, id: string): string {
  return result.steps.find((step) => step.id === id)?.detail ?? ''
}

const OFFLINE_CONFIG: ProviderConfig = {
  id: 'custom-1',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:9/v1',
  model: 'test-model',
  isDefault: true
}

/** 不走网络的那条路：三步全由用例自己给答复 */
function offlineDeps(overrides: {
  generate?: () => Promise<unknown>
  stream?: () => Promise<StreamOutcome>
  toolStream?: () => Promise<ToolRunOutcome>
}): Parameters<typeof testConnection>[2] {
  return {
    generate: overrides.generate ?? (async () => ({ finishReason: 'stop' })),
    stream:
      overrides.stream ??
      (async () => ({
        textChars: 4,
        reasoningChars: 0,
        finishReason: 'stop',
        sawFinish: true,
        textPreview: 'pong'
      })),
    toolStream:
      overrides.toolStream ??
      (async () => ({
        calls: [{ name: PROBE_TOOL_NAME, invalid: false }],
        errors: [],
        outputs: [PROBE_TOOL_OUTPUT],
        finishReason: 'tool-calls',
        sawFinish: true
      }))
  }
}

describe('testConnection · 三步全绿', () => {
  it('连通 + 流式拿到正文 + 流式工具合法跑通 → 三步都 passed，且工具那趟是流式的', async () => {
    const provider = await fakeProvider()

    const result = await testConnection(provider.config, KEY)

    expect(result.ok).toBe(true)
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ['connectivity', 'passed'],
      ['streaming', 'passed'],
      ['tools', 'passed']
    ])
    expect(result.message).toBeUndefined()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)

    // 三趟都打到 /v1/chat/completions，都带 Bearer 密钥
    expect(provider.log.map((entry) => entry.url)).toEqual([
      '/v1/chat/completions',
      '/v1/chat/completions',
      '/v1/chat/completions'
    ])
    expect(provider.log.every((entry) => entry.authorization === `Bearer ${KEY}`)).toBe(true)

    // 第 ① 步是非流式的（只为往返），第 ②③ 步都必须是**流式**的
    expect(provider.log[0].body.stream).toBeUndefined()
    expect(provider.log[1].body.stream).toBe(true)
    expect(provider.log[2].body.stream).toBe(true)
    // 输出预算给了思考模型留空间
    expect(provider.log[0].body.max_tokens).toBe(TEST_MAX_OUTPUT_TOKENS)
    // 工具那趟只带一条**只读探针**，绝不把应用的真实工具递进去
    const tools = provider.log[2].body.tools as Array<{ function?: { name?: string } }>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.function?.name).toBe(PROBE_TOOL_NAME)
  }, 30_000)
})

describe('testConnection · 流式那一步（拿不到正面证据就不算通过）', () => {
  it('非流式 200 但流里没有任何正文 → streaming 未验证，整体不 ok', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.stream === true && entry.body.tools === undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sse([{ role: 'assistant' }]))
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'connectivity')).toBe('passed')
    expect(statusOf(result, 'streaming')).toBe('unverified')
    expect(result.ok).toBe(false)
    expect(detailOf(result, 'streaming')).toContain('没有任何正文')
  }, 30_000)

  it('只吐出思考（reasoning）没有正文 → streaming 未验证', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.stream === true && entry.body.tools === undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sseText({ reasoning: '想了一会儿' }))
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'streaming')).toBe('unverified')
    expect(result.ok).toBe(false)
    expect(detailOf(result, 'streaming')).toContain('只有思考内容')
  }, 30_000)

  it('正文被输出上限截断（finish_reason=length）→ streaming 未验证，不算成功', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.stream === true && entry.body.tools === undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sseText({ text: '很长很长的正文', finish: 'length' }))
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'streaming')).toBe('unverified')
    expect(result.ok).toBe(false)
    expect(detailOf(result, 'streaming')).toContain('被输出上限截断')
  }, 30_000)

  it('真实断流（发了一段 SSE 就把连接掐掉）→ streaming failed，不宣称"完整拿到了"', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.stream === true && entry.body.tools === undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        // 只吐一段正文，**没有** finish_reason、没有 [DONE]，直接把 socket 掐掉
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-cut',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-model',
            choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }]
          })}\n\n`
        )
        response.socket?.destroy()
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'streaming')).toBe('failed')
    expect(statusOf(result, 'tools')).toBe('skipped')
    expect(result.ok).toBe(false)
  }, 30_000)

  it('SSE 少了结束块（有 [DONE] 但没有 finish_reason）→ streaming failed', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.stream === true && entry.body.tools === undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sseText({ text: 'pong', finish: null }))
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'streaming')).toBe('failed')
    expect(result.ok).toBe(false)
  }, 30_000)
})

describe('testConnection · 流式工具那一步（合法调用 + 真执行才算通）', () => {
  it('工具参数不是 echo="ok"（校验不过）→ tools failed，绝不算通过', async () => {
    const provider = await providerWithToolStream(
      sseToolCall({ args: JSON.stringify({ echo: 'nope' }) })
    )

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'tools')).toBe('failed')
    expect(detailOf(result, 'tools')).toContain('不合法')
    // 连通与流式都过了，所以 ok 仍是 true——但结果里**明确**写着工具那步没过
    expect(result.ok).toBe(true)
    expect(result.message).toContain('工具那一步没通过')
  }, 30_000)

  it('工具参数是 {}（少了 echo）→ tools failed（探针不会被当成功执行）', async () => {
    const provider = await providerWithToolStream(sseToolCall({ args: '{}' }))

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'tools')).toBe('failed')
    expect(result.message).toContain('工具那一步没通过')
  }, 30_000)

  it('工具参数是**不完整 JSON** → tools failed', async () => {
    const provider = await providerWithToolStream(sseToolCall({ args: '{"echo":' }))

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'tools')).toBe('failed')
  }, 30_000)

  it('模型调的工具名不是探针 → tools failed（工具定义没原样过去）', async () => {
    const provider = await providerWithToolStream(
      sseToolCall({ name: 'some_other_tool', args: PROBE_CALL_OK })
    )

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'tools')).toBe('failed')
    expect(detailOf(result, 'tools')).toContain('some_other_tool')
  }, 30_000)

  it('工具那趟被端点拒（400）→ tools failed；连通与流式已过 → 整体仍 ok（不封注册）', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.tools !== undefined) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'tools: unsupported' } }))
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(result.ok).toBe(true)
    expect(statusOf(result, 'tools')).toBe('failed')
    expect(result.message).toContain('工具那一步没通过')
  }, 30_000)

  it('端点收下了工具定义但模型没调 → tools 未验证；整体仍 ok', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.tools !== undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sseText({ text: '我不需要工具。' }))
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(result.ok).toBe(true)
    expect(statusOf(result, 'tools')).toBe('unverified')
    expect(result.message).toContain('工具那一步没通过')
    // 范围声明始终在：通过 ≠ 本应用的全部工具在生产里都兼容
    expect(result.scopeNote).toContain('全部工具')
    expect(result.scopeNote).toContain('流式')
  }, 30_000)
})

describe('testConnection · 失败与脱敏', () => {
  it('认证失败（401）：连通 failed、后两步 skipped，供应商回显的密钥被抹掉', async () => {
    const provider = await fakeProvider((_entry, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `Invalid API key: ${KEY}` } }))
      return true
    })

    const result = await testConnection(provider.config, KEY)

    expect(result.ok).toBe(false)
    expect(statusOf(result, 'connectivity')).toBe('failed')
    expect(statusOf(result, 'streaming')).toBe('skipped')
    expect(statusOf(result, 'tools')).toBe('skipped')
    expect(result.message).toContain('认证失败（401）')
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('供应商只回显密钥的一部分：也抹掉', async () => {
    const provider = await fakeProvider((_entry, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: `key ${KEY.slice(0, 12)}...${KEY.slice(-6)} 无效` } })
      )
      return true
    })

    const result = await testConnection(provider.config, KEY)

    const text = JSON.stringify(result)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(KEY.slice(0, 12))
    expect(text).not.toContain(KEY.slice(-6))
  }, 30_000)

  it('连不上：网络错误 + 端点', async () => {
    const config: ProviderConfig = {
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test-model',
      isDefault: true
    }

    const result = await testConnection(config, KEY)

    expect(result.ok).toBe(false)
    expect(statusOf(result, 'connectivity')).toBe('failed')
    expect(result.message).toContain('网络错误')
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('Base URL 里带了用户名/密码：给一句能照做的提示，**凭据一个字符都不回显**', async () => {
    const config: ProviderConfig = {
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: 'http://user:super-secret@127.0.0.1:1/v1',
      model: 'test-model',
      isDefault: true
    }

    const result = await testConnection(config, KEY)

    expect(result.ok).toBe(false)
    expect(statusOf(result, 'connectivity')).toBe('failed')
    expect(result.message).toContain('不能带用户名/密码')
    // undici 的原话会把整条 URL（含密码）打出来，这里必须全被抹掉
    // （提示语里的 `user:pass@` 只是模板占位，不是被回显的凭据）
    expect(JSON.stringify(result)).not.toContain('super-secret')
    expect(JSON.stringify(result)).not.toContain('user:super-secret')
    expect(JSON.stringify(result)).not.toContain('127.0.0.1:1')
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('供应商把带查询串的地址回显在错误里：query 不进文案', async () => {
    const provider = await fakeProvider((_entry, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { message: `调用 https://gw.example.com/v1/chat/completions?token=${KEY} 失败` }
        })
      )
      return true
    })

    const result = await testConnection(provider.config, KEY)

    expect(result.message).toContain('认证失败')
    expect(JSON.stringify(result)).not.toContain('token=')
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('掐住不响应：超时（按 timeoutMs）而不是干等；整趟也有总超时', async () => {
    const provider = await fakeProvider(() => true)

    const result = await testConnection(provider.config, KEY, {
      timeoutMs: 300,
      totalTimeoutMs: 600
    })

    expect(statusOf(result, 'connectivity')).toBe('failed')
    expect(result.message).toContain('超时')
    expect(result.latencyMs).toBeLessThan(5_000)
  }, 30_000)

  it('流式那趟失败：连通 passed、流式 failed、工具 skipped，错误一样脱敏', async () => {
    const provider = await fakeProvider((entry, response) => {
      if (entry.body.stream === true && entry.body.tools === undefined) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: `bad request, key=${KEY}` } }))
        return true
      }
      return false
    })

    const result = await testConnection(provider.config, KEY)

    expect(statusOf(result, 'connectivity')).toBe('passed')
    expect(statusOf(result, 'streaming')).toBe('failed')
    expect(statusOf(result, 'tools')).toBe('skipped')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('请求失败（400）')
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)
})

describe('testConnection · 判据边界（注入式，逐条钉状态）', () => {
  it('流式：有正文但结束原因是 content-filter → 未验证', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        stream: async () => ({
          textChars: 10,
          reasoningChars: 0,
          finishReason: 'content-filter',
          sawFinish: true,
          textPreview: 'x'
        })
      })
    )

    expect(statusOf(result, 'streaming')).toBe('unverified')
    expect(detailOf(result, 'streaming')).toContain('content-filter')
  })

  it('流式：有正文但结束原因未知（other）→ 未验证', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        stream: async () => ({
          textChars: 10,
          reasoningChars: 0,
          finishReason: 'other',
          sawFinish: true,
          textPreview: ''
        })
      })
    )

    expect(statusOf(result, 'streaming')).toBe('unverified')
  })

  it('流式：有正文但没收到结束标记 → 失败（不许宣称完整流已通过）', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        stream: async () => ({
          textChars: 10,
          reasoningChars: 0,
          finishReason: 'stop',
          sawFinish: false,
          textPreview: ''
        })
      })
    )

    expect(statusOf(result, 'streaming')).toBe('failed')
    expect(detailOf(result, 'streaming')).toContain('没有结束标记')
  })

  it('流式：finish_reason=error（没抛异常）→ 失败', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        stream: async () => ({
          textChars: 0,
          reasoningChars: 0,
          finishReason: 'error',
          sawFinish: true,
          textPreview: ''
        })
      })
    )

    expect(statusOf(result, 'streaming')).toBe('failed')
  })

  it('流式那趟抛错 → 失败，工具 skipped', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        stream: async () => {
          throw new Error('stream 断了')
        }
      })
    )

    expect(statusOf(result, 'streaming')).toBe('failed')
    expect(statusOf(result, 'tools')).toBe('skipped')
  })

  it('工具：调用合法但被输出上限截断（length）→ 未验证', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        toolStream: async () => ({
          calls: [{ name: PROBE_TOOL_NAME, invalid: false }],
          errors: [],
          outputs: [PROBE_TOOL_OUTPUT],
          finishReason: 'length',
          sawFinish: true
        })
      })
    )

    expect(statusOf(result, 'tools')).toBe('unverified')
  })

  it('工具：没有结束标记 → 失败', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        toolStream: async () => ({
          calls: [{ name: PROBE_TOOL_NAME, invalid: false }],
          errors: [],
          outputs: [PROBE_TOOL_OUTPUT],
          finishReason: 'tool-calls',
          sawFinish: false
        })
      })
    )

    expect(statusOf(result, 'tools')).toBe('failed')
    expect(detailOf(result, 'tools')).toContain('没有收到结束标记')
  })

  it('工具：标记成 invalid 的调用 → 失败（哪怕流里同时报了别的信息）', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        toolStream: async () => ({
          calls: [{ name: PROBE_TOOL_NAME, invalid: true }],
          errors: ['参数不合法'],
          outputs: [],
          finishReason: 'tool-calls',
          sawFinish: true
        })
      })
    )

    expect(statusOf(result, 'tools')).toBe('failed')
    expect(detailOf(result, 'tools')).toContain('不合法')
  })

  it('工具：调了但没拿到探针的返回值 → 失败（没真执行）', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        toolStream: async () => ({
          calls: [{ name: PROBE_TOOL_NAME, invalid: false }],
          errors: [],
          outputs: [],
          finishReason: 'tool-calls',
          sawFinish: true
        })
      })
    )

    expect(statusOf(result, 'tools')).toBe('failed')
    expect(detailOf(result, 'tools')).toContain('没有被真正执行')
  })

  it('工具：execute 抛错（流里有工具错误）→ 失败', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        toolStream: async () => ({
          calls: [{ name: PROBE_TOOL_NAME, invalid: false }],
          errors: ['boom'],
          outputs: [],
          finishReason: 'tool-calls',
          sawFinish: true
        })
      })
    )

    expect(statusOf(result, 'tools')).toBe('failed')
  })

  it('工具：模型压根没调工具 → 未验证（不是失败：端点没毛病，只是这次没验出来）', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        toolStream: async () => ({
          calls: [],
          errors: [],
          outputs: [],
          finishReason: 'stop',
          sawFinish: true
        })
      })
    )

    expect(statusOf(result, 'tools')).toBe('unverified')
    expect(result.ok).toBe(true)
  })

  it('工具那趟抛错 → 失败，但整体 ok（判据只看前两步）', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        toolStream: async () => {
          throw new Error('工具请求被端点拒绝')
        }
      })
    )

    expect(result.ok).toBe(true)
    expect(statusOf(result, 'tools')).toBe('failed')
  })

  it('注入的 generate 抛一般错误 → 连通 failed 的文案是"连接失败：…"，密钥同样被抹掉', async () => {
    const result = await testConnection(
      OFFLINE_CONFIG,
      KEY,
      offlineDeps({
        generate: async () => {
          throw new Error(`proxy rejected key ${KEY}`)
        }
      })
    )

    expect(statusOf(result, 'connectivity')).toBe('failed')
    expect(result.message).toContain('连接失败')
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('每一步的 detail 都是非空人话，且整份结果不含密钥', async () => {
    const result = await testConnection(OFFLINE_CONFIG, KEY, offlineDeps({}))

    for (const step of result.steps) expect(step.detail.length).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})
