// @vitest-environment node
/**
 * B3.2 工具路径参考帧（flag 关，旧 Mastra 路径）：
 * 成功：模型 tool-call(todo) → Mastra 真执行 → 工具输出帧；
 * 失败：模型 tool-call(not_a_tool) → 工具不存在 → 工具错误帧。
 * 这两份帧是内核工具事件映射的**字段级基准**。
 *
 * 生成：KYCLAW_CAPTURE_TOOL_REF=1 vitest run src/main/kernel/__tests__/b3-2-tool-reference.spec.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../agent/service'
import { threadMemoryBody } from '../../../shared/threads'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import type { KyclawModel } from '../../../mastra/model'

const SUCCESS = fileURLToPath(
  new URL('./fixtures/renderer-sse-tool-success-0.1.6.json', import.meta.url)
)
const ERROR = fileURLToPath(
  new URL('./fixtures/renderer-sse-tool-error-0.1.6.json', import.meta.url)
)
const CAPTURE = process.env.KYCLAW_CAPTURE_TOOL_REF === '1'

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 }
}

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function toolScript(toolName: string, input: unknown): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'call_tool_1',
      toolName,
      input: JSON.stringify(input)
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE }
  ] as unknown as StreamPart[]
}

function doneScript(): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't2' },
    { type: 'text-delta', id: 't2', delta: '工具已完成。' },
    { type: 'text-end', id: 't2' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE }
  ] as unknown as StreamPart[]
}

function parseSse(text: string): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((value) => value.startsWith('data:'))
    if (line === undefined) continue
    try {
      frames.push(JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>)
    } catch {
      // ignore
    }
  }
  return frames
}

function normalizeRecords(frames: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return frames.map((frame) => {
    const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>
    if (typeof clone.toolCallId === 'string') clone.toolCallId = '<id>'
    if (typeof clone.toolName === 'string') clone.toolName = '<tool>'
    if (typeof clone.input === 'object' && clone.input !== null) clone.input = '<input>'
    if (typeof clone.output === 'object' && clone.output !== null) clone.output = '<output>'
    if (typeof clone.errorText === 'string') clone.errorText = '<error>'
    return clone
  })
}

let dir: string
let server: AgentServerHandle

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-tool-ref-'))
  let calls = 0
  const scripts: StreamPart[][] = [
    toolScript('todo', { todos: [{ content: '检查工具卡', status: 'pending' }] }),
    doneScript(),
    toolScript('not_a_tool', {}),
    doneScript()
  ]
  const model: KyclawModel = new MockLanguageModelV4({
    provider: 'tool-ref',
    modelId: 'deepseek-flash',
    doStream: async () => {
      const script = scripts[Math.min(calls, scripts.length - 1)] ?? doneScript()
      calls += 1
      return {
        stream: simulateReadableStream({ chunks: script, initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })
  server = await startAgentServer({ dataDir: dir, resolveModel: async () => model })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] tool ref temp cleanup deferred', dir)
  }
})

async function chat(threadId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '用一下工具' }] }],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  return parseSse(await response.text()).filter(
    (frame) => typeof frame.type === 'string' && frame.type.includes('tool')
  )
}

describe('B3.2 工具路径参考帧（0.1.6，flag 关）', () => {
  it('成功工具：tool-input-available → tool-output-available', async () => {
    const frames = await chat('thread-tool-success')
    if (CAPTURE)
      writeFileSync(SUCCESS, `${JSON.stringify(normalizeRecords(frames), null, 2)}\n`, 'utf8')
    expect(normalizeRecords(frames)).toEqual(JSON.parse(readFileSync(SUCCESS, 'utf8')) as unknown)
    console.log('[tool-success]', JSON.stringify(frames.map((frame) => frame.type)))
  })

  it('失败工具：tool-input-available → tool-output-error', async () => {
    const frames = await chat('thread-tool-error')
    if (CAPTURE)
      writeFileSync(ERROR, `${JSON.stringify(normalizeRecords(frames), null, 2)}\n`, 'utf8')
    expect(normalizeRecords(frames)).toEqual(JSON.parse(readFileSync(ERROR, 'utf8')) as unknown)
    console.log('[tool-error]', JSON.stringify(frames.map((frame) => frame.type)))
  })
})
