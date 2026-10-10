// @vitest-environment node
/**
 * 链路原型①（T6 验收）：确定性 mock 模型 → Mastra Agent → @mastra/hono 挂载 →
 * Node http（127.0.0.1 随机端口）→ 带 token fetch chat 路由 → SSE 文本增量与结束事件。
 *
 * 这里刻意跑的是"一条真请求走完全程"：断言的每个字节都出自 SSE 响应体，
 * 而不是对 mock 或转换层的重复单测。model 注入用的是 ai/test 的 simulateReadableStream，
 * 所以链路里没有任何真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { KYCLAW_INSTRUCTIONS } from '../agents/kyclaw'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'

/** 模型回吐的确定性文本（按增量切三片，用来验证"增量"确实是一段段过来的） */
const REPLY_CHUNKS = ['链路', '打通：', 'mock 流到了 SSE。'] as const
const AGENT_ID = 'kyclaw-agent'
const USER_MESSAGE = '在吗？'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}

/** v4 spec 的 finishReason 是 { unified, raw } 两段结构 */
const FINISH_REASON = { unified: 'stop' as const, raw: 'stop' }

/** 把 SSE 响应体解成结构化事件（跳过 [DONE] 终结行） */
function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

let dir: string
let server: AgentServerHandle
let model: MockLanguageModelV4
let status: number
let contentType: string | null
let body: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-link-'))
  model = new MockLanguageModelV4({
    provider: 'kyclaw-test-mock',
    modelId: 'kyclaw-test-mock',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          ...REPLY_CHUNKS.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: FINISH_REASON, usage: USAGE }
        ],
        initialDelayInMs: 0,
        chunkDelayInMs: 1
      })
    })
  })
  server = await startAgentServer({ dataDir: dir, model })

  const response = await fetch(`${server.baseUrl}/chat/${AGENT_ID}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`
    },
    body: JSON.stringify({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: USER_MESSAGE }] }]
    })
  })
  status = response.status
  contentType = response.headers.get('content-type')
  body = await response.text()
}, 60_000)

afterAll(async () => {
  await server?.stop()
  // libsql（native）在 Windows 上要过几秒才真正放掉库文件句柄；删不掉不判失败（见 service.spec 说明）
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('链路：mock 模型 → 内嵌服务 → chat 路由', () => {
  it('chat 路由回 SSE 流（200 / text/event-stream）', () => {
    expect(status).toBe(200)
    expect(contentType).toContain('text/event-stream')
  })

  it('SSE 里逐段带出模型的文本增量与结束事件', () => {
    const events = sseEvents(body)

    const deltas = events.filter((event) => event.type === 'text-delta').map((event) => event.delta)
    expect(deltas).toEqual([...REPLY_CHUNKS])

    const finish = events.find((event) => event.type === 'finish')
    expect(finish).toMatchObject({ finishReason: 'stop' })
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('agent 身份与用户消息真的进了模型请求（装配不是空壳）', () => {
    expect(model.doStreamCalls).toHaveLength(1)

    // 只看文本（content 可能是纯字符串或 text part 数组），别把 JSON 转义当内容比对
    const text = model.doStreamCalls[0].prompt
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      )
      .join('\n')

    expect(text).toContain(KYCLAW_INSTRUCTIONS)
    expect(text).toContain(USER_MESSAGE)
  })
})
