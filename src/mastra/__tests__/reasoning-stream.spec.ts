// @vitest-environment node
/**
 * 思考过程随流下发（round29）：`chatRoute` 的 `sendReasoning` 口子（src/mastra/index.ts 开启）。
 *
 * 现场（2026-10-11，用户真实对话）：直播里最先看到的是工具调用，"思考过程"要刷新（从存储
 * 回放）才出现 —— 观感首字延迟严重。根因：@mastra/ai-sdk 1.10.7 的 chatRoute
 * `sendReasoning` **默认 false**（chat-route.d.ts 的 JSDoc：`[options.sendReasoning=false]`），
 * reasoning 只进存储、不进直播流。
 *
 * 本 spec 钉住修好后的 wire 形状：stub 模型先吐 reasoning 再吐工具调用时，
 * SSE 里 reasoning part 必须出现，且**先于** tool-input-available 到达。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

/** 第一轮：思考 → 工具调用（glob）。真实模型开场就是"先想再动手"，这里复刻这个顺序 */
function reasoningThenToolScript(workspace: string): StreamPart[] {
  const json = JSON.stringify({ pattern: '**/*', path: workspace })
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', delta: '先看看这个文件夹里有什么。' },
    { type: 'reasoning-end', id: 'r1' },
    { type: 'tool-input-start', id: 'call-glob', toolName: 'glob' },
    { type: 'tool-input-delta', id: 'call-glob', delta: json },
    { type: 'tool-input-end', id: 'call-glob' },
    { type: 'tool-call', toolCallId: 'call-glob', toolName: 'glob', input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

/** SSE 响应体 → 结构化 part 列表（跳过 [DONE] 终结行） */
function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-reasoning-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  writeFileSync(join(workspace, 'note.txt'), 'x', 'utf8')

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-reasoning-mock',
    modelId: 'kyclaw-reasoning-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })

  server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => [{ path: workspace, mode: 'ask' }],
    projects: () => []
  })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('思考过程随流下发（sendReasoning）', () => {
  it('reasoning part 实时到达，且先于 tool-input-available（不许工具先冒头）', async () => {
    scripts.length = 0
    scripts.push(() => reasoningThenToolScript(workspace))
    scripts.push(() => textScript('看完了。'))

    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '看看这个文件夹' }] }],
        ...threadMemoryBody('thread-reasoning')
      })
    })
    expect(response.status).toBe(200)
    const parts = sseParts(await response.text())

    // 1. reasoning part 必须在流里（不是只进存储）
    const reasoning = parts.filter((part) => String(part.type).startsWith('reasoning-'))
    expect(reasoning.length).toBeGreaterThan(0)
    const reasoningText = reasoning
      .filter((part) => part.type === 'reasoning-delta')
      .map((part) => String(part.delta ?? ''))
      .join('')
    expect(reasoningText).toContain('先看看这个文件夹里有什么。')

    // 2. 顺序：思考先到、工具调用后到（直播观感的关键判据）
    const firstReasoning = parts.findIndex((part) => String(part.type).startsWith('reasoning-'))
    const firstToolInput = parts.findIndex((part) => part.type === 'tool-input-available')
    expect(firstToolInput).toBeGreaterThanOrEqual(0)
    expect(firstReasoning).toBeLessThan(firstToolInput)

    // 3. 链路完好：工具结果 + 第二轮文本照常
    expect(
      parts.some((part) => part.type === 'tool-output-available' && part.toolCallId === 'call-glob')
    ).toBe(true)
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '看完了。'
    ])
  }, 30_000)
})
