// @vitest-environment node
/**
 * B3.1a 参考帧：**现有 kyclaw（0.1.6 行为）真实 SSE 帧**，作为"字段级等价"的基准。
 *
 * 用法：
 *   - 生成/更新基准：`KYCLAW_CAPTURE_SSE=1 vitest run src/main/kernel/__tests__/sse-reference.spec.ts`
 *   - 日常校验：不带 env 跑同一 spec（对比 fixture；不一致即红）
 *
 * 注意：这是**现有 chat 路径**（feature flag 关）的输出，不启动内核、不改 renderer。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../agent/service'
import { threadMemoryBody } from '../../../shared/threads'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import type { KyclawModel } from '../../../mastra/model'

const FIXTURE = fileURLToPath(new URL('./fixtures/renderer-sse-kyclaw-0.1.6.json', import.meta.url))

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }

/** mock 流的 chunk 类型（从 MockLanguageModelV4 的 doStream 签名上取，避免手抄 spec） */
type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

/** 把 SSE 文本拆成 `{data: object}` 列表（只保留 data 行，非 JSON 忽略） */
function parseSse(text: string): Array<{ data: Record<string, unknown> }> {
  const frames: Array<{ data: Record<string, unknown> }> = []
  for (const block of text.split('\n\n')) {
    const dataLines = block.split('\n').filter((line) => line.startsWith('data:'))
    if (dataLines.length === 0) continue
    const raw = dataLines.map((line) => line.slice(5).trimStart()).join('\n')
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null)
        frames.push({ data: parsed as Record<string, unknown> })
    } catch {
      // 非 JSON（例如错误文本）不入基准
    }
  }
  return frames
}

let dir: string
let server: AgentServerHandle

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-sse-ref-'))
  const model: KyclawModel = new MockLanguageModelV4({
    provider: 'sse-ref',
    modelId: 'deepseek-flash',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: textScript('字段级等价参考文本。'),
        initialDelayInMs: 0,
        chunkDelayInMs: 0
      })
    })
  })
  server = await startAgentServer({
    dataDir: dir,
    resolveModel: async () => model
  })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] sse reference temp cleanup deferred', dir)
  }
})

describe('现有 chat SSE 参考帧（0.1.6 行为，flag 关）', () => {
  it('采集并对比 renderer-sse-kyclaw-0.1.6.json', async () => {
    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'say hi' }] }],
        ...threadMemoryBody('thread-sse-ref')
      })
    })
    expect(response.status).toBe(200)
    const frames = parseSse(await response.text())
    expect(frames.length).toBeGreaterThan(3)

    const normalized = frames.map((frame) => normalize(frame.data))
    if (process.env.KYCLAW_CAPTURE_SSE === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown
    expect(normalized).toEqual(expected)
  })
})

/** 去掉随机值（messageId/step id 等），保留帧的**字段名与结构** */
function normalize(data: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
  if (typeof clone.messageId === 'string') clone.messageId = '<message-id>'
  if (typeof clone.id === 'string') clone.id = '<id>'
  if (typeof clone.data === 'object' && clone.data !== null) {
    const inner = clone.data as Record<string, unknown>
    if (typeof inner.stepIndex === 'number') inner.stepIndex = 0
  }
  return clone
}
