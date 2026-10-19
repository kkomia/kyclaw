// @vitest-environment node
/**
 * PB-035 C 真服务端联调：
 *   1. 失败轮（先吐正文再断流）→ `GET /api/threads/<id>/messages` 能读到**已产生 parts** +
 *      原 `error` part + `metadata.status='failed'`（刷新不丢）；
 *   2. 下一轮（重试 marker）**不再把失败内容喂给模型**，请求体仍合法（最后一条是 user）；
 *   3. 失败行仍然留在 history 里（UI 默认可见，不靠前端筛）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}

type Part =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends {
    stream: ReadableStream<infer T>
  }
    ? T
    : never

function textChunks(text: string): Part[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
  ] as unknown as Part[]
}

/** 先吐一段正文，再让流 error（模拟上游中途断开） */
function partialThenFail(): ReadableStream<Part> {
  const chunks = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: '第一部分正文已经产生。' },
    { type: 'text-end', id: 't1' }
  ] as unknown as Part[]
  let index = 0
  return new ReadableStream<Part>({
    // 必须让已产生的 chunk **先被消费**，再 error：start 里立刻 error 会把排队中的 chunk 一起丢掉
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index])
        index += 1
        return
      }
      controller.error(new Error('模拟断流：上游连接中断'))
    }
  })
}

let dir: string
let server: AgentServerHandle
let call = 0
const prompts: unknown[][] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-pb035-c-'))
  const model = new MockLanguageModelV4({
    provider: 'pb035-c-mock',
    modelId: 'pb035-c-mock',
    doStream: async (options) => {
      call += 1
      prompts.push(options.prompt as unknown[])
      if (call === 1) return { stream: partialThenFail() }
      return {
        stream: simulateReadableStream({
          chunks: textChunks('继续完成了。'),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      }
    }
  })
  server = await startAgentServer({ dataDir: dir, model })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] pb035 C temp cleanup deferred', dir)
  }
})

function postChat(body: unknown): Promise<Response> {
  return fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body)
  })
}

async function history(threadId: string): Promise<{
  messages: Array<{
    id: string
    role: string
    content: { parts?: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }
  }>
}> {
  const response = await fetch(
    `${server.baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages`,
    { headers: { authorization: `Bearer ${server.token}` } }
  )
  return (await response.json()) as never
}

it('失败轮：parts 补进已存在的 assistant 行；下一轮上下文不含失败内容且请求合法', async () => {
  const threadId = 'thread-pb035-c'
  const first = await postChat({
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '写一段话，然后断掉' }] }],
    ...threadMemoryBody(threadId)
  })
  expect(first.status).toBe(200)
  const streamText = await first.text()
  expect(streamText).toContain('"type":"error"')
  // 等失败轮收尾（Memory 写 error 行 + 我们补 parts）
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const afterFail = await history(threadId)
  const assistant = afterFail.messages.find((message) => message.role === 'assistant')
  expect(assistant).toBeTruthy()
  const parts = assistant?.content.parts ?? []
  // 1) 已产生的正文补进来了；2) 原 error part 没被覆盖；3) metadata.status=failed
  expect(parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: '第一部分正文已经产生。' }),
      expect.objectContaining({ type: 'error' })
    ])
  )
  expect(assistant?.content.metadata?.status).toBe('failed')

  // 下一轮：重试 marker（前端隐藏）
  const second = await postChat({
    messages: [
      {
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: '从中断处继续' }],
        metadata: { kyclawRetryKeep: true }
      }
    ],
    ...threadMemoryBody(threadId)
  })
  expect(second.status).toBe(200)
  await second.text()

  const promptText = JSON.stringify(prompts[1] ?? [])
  expect(promptText).not.toContain('第一部分正文已经产生。') // 失败内容不进上下文
  expect(promptText).toContain('继续。') // marker 换成中性内容，保留 user 结尾
  const last = (prompts[1] ?? []).at(-1) as { role?: string } | undefined
  expect(last?.role).toBe('user')

  // 失败行仍然返回（UI 默认可见）
  const afterRetry = await history(threadId)
  expect(
    afterRetry.messages.some(
      (message) =>
        message.role === 'assistant' &&
        (message.content.parts ?? []).some(
          (part) => part.type === 'text' && part.text === '第一部分正文已经产生。'
        )
    )
  ).toBe(true)
}, 60_000)
