// @vitest-environment node
/**
 * 单轮步数预算（maxSteps）的验收：真 mastra server + 真 Chat + stub 模型。
 *
 * 现场（round 33，trace e3530c7f…）：一轮里 agent 跑到第 6 步无声收尾，最后结果
 * `{"finishReason":"tool-calls","stepCount":6}` —— 任务没做完就断了。根因是 Mastra
 * agent 的缺省 `maxSteps` 很小（`llmStepCountIs(5)`，见 @mastra/core 的 model.loop），
 * 且**审批挂起恢复后的那次运行会并回这个小数**：不显式给预算，恢复流跑几步就被截停。
 *
 * 本 spec 钉两条：
 *   1. 初始流：一个 12 步的任务能跑完（旧行为第 5 步截停）；
 *   2. 挂起恢复流：bash 审批挂起 → 真批准 → 恢复后的运行要跑过第 7 步直到完成。
 * 判据都用「stub 脚本被消费光 + 最终文本到达」——脚本没被消费 = 服务端没再生成。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport, type FinishReason, type UIMessage } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { canResumeAfterApproval } from '../../renderer/src/features/chat/approval'
import { threadMemoryBody } from '../../shared/threads'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

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

function toolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

function textDeltas(parts: Array<Record<string, unknown>>): string[] {
  return parts.filter((part) => part.type === 'text-delta').map((part) => String(part.delta ?? ''))
}

async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${label}`)
}

type ApprovalPart = {
  state: string
  toolCallId: string
  approval?: { id?: string; approved?: boolean }
}

function bashPart(messages: UIMessage[]): ApprovalPart | undefined {
  for (const message of messages) {
    for (const part of message.parts as unknown as ApprovalPart[]) {
      const record = part as unknown as { type?: string; toolCallId?: string }
      if (record.type === 'tool-bash' || record.toolCallId === 'call-bash') return part
    }
  }
  return undefined
}

/** 第 n 步的 glob 调用（读类工具不弹审批；每步一个独立 toolCallId） */
function globStep(index: number): () => StreamPart[] {
  return () => toolCallScript(`call-g${index}`, 'glob', { pattern: '**/*', path: workspace })
}

let dir: string
let workspace: string
let server: AgentServerHandle
let model: MockLanguageModelV4
const scripts: Array<() => StreamPart[]> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-maxsteps-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))

  model = new MockLanguageModelV4({
    provider: 'kyclaw-maxsteps-mock',
    modelId: 'kyclaw-maxsteps-mock',
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

describe('单轮步数预算（初始流）', () => {
  it('12 步任务能跑完：初始流不被 ~5 步的缺省预算截停', async () => {
    scripts.length = 0
    for (let step = 0; step < 12; step++) scripts.push(globStep(step))
    scripts.push(() => textScript('十二步全部完成了。'))

    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-steps', role: 'user', parts: [{ type: 'text', text: '跑十二步' }] }],
        ...threadMemoryBody('thread-maxsteps-initial')
      })
    })
    expect(response.status).toBe(200)
    const parts = sseParts(await response.text())

    const outputs = parts.filter((part) => part.type === 'tool-output-available')
    expect(outputs.length).toBe(12)
    expect(textDeltas(parts)).toContain('十二步全部完成了。')
    // 脚本被消费光 = 服务端真的跑了 13 次生成（12 步 + 收尾），不是中途截停
    expect(scripts.length).toBe(0)
  }, 120_000)
})

describe('单轮步数预算（审批挂起恢复流）', () => {
  it('恢复后的运行能跑过第 7 步：批准后 12 步 + 收尾全部跑完', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-bash', 'bash', { command: 'echo step-1-ok' }))
    for (let step = 0; step < 12; step++) scripts.push(globStep(step))
    scripts.push(() => textScript('恢复后十二步全部完成了。'))

    /** 客户端 onFinish 拿到的 finishReason（渲染端可见提示的数据面就是它） */
    let lastFinishReason: FinishReason | undefined
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { authorization: `Bearer ${server.token}` }
      }),
      onFinish: ({ finishReason }) => {
        lastFinishReason = finishReason
      },
      sendAutomaticallyWhen: ({ messages }) => canResumeAfterApproval(messages)
    })

    const options = { body: threadMemoryBody('thread-maxsteps-resume') }
    await chat.sendMessage({ text: '跑第一步再来十二步' }, options)

    await waitUntil(
      () => chat.status === 'ready' && bashPart(chat.messages)?.state === 'approval-requested',
      20_000,
      '挂起流收完 + approval-requested part'
    )
    const approvalId = bashPart(chat.messages)?.approval?.id
    expect(String(approvalId)).toMatch(/::call-bash$/)

    // 批准前已消费 1 个脚本（初始流那一步）；恢复流从第 2 个脚本开始
    const remainingAtApproval = scripts.length
    expect(remainingAtApproval).toBe(13)

    await chat.addToolApprovalResponse({ id: String(approvalId), approved: true, options })
    expect(canResumeAfterApproval(chat.messages)).toBe(true)

    // 先等"恢复流收尾"（bash 已执行 + 客户端回到 ready）——被截停时它也会很快收尾，
    // 所以下面的断言在旧行为下是**快速红**，不必等满超时。
    await waitUntil(
      () => chat.status === 'ready' && bashPart(chat.messages)?.state === 'output-available',
      120_000,
      '恢复流收尾（bash 已执行 + 客户端回到 ready）'
    )

    const bash = bashPart(chat.messages) as unknown as { output?: unknown }
    expect(String(bash.output)).toContain('step-1-ok')

    // 恢复后的运行消费了 13 个脚本（12 步 + 收尾）——远超旧的 ~5 步截停线（旧行为只消费 4 个）
    const stepsAfterResume = remainingAtApproval - scripts.length
    expect(stepsAfterResume).toBeGreaterThan(7)
    expect(scripts.length).toBe(0)
    const texts = chat.messages
      .flatMap((message) => message.parts)
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    expect(texts).toContain('恢复后十二步全部完成了。')
    // 正常跑完的那一轮 finishReason 是 stop（不是被截停的 tool-calls）
    expect(lastFinishReason).toBe('stop')
  }, 180_000)
})
