// @vitest-environment node
/**
 * 审批续跑链路（suspend → approve → resume）的端到端定位：真 mastra server + 真 bash 工具 +
 * stub 模型 + **真客户端 Chat**（`@ai-sdk/react` 的 Chat 类，与渲染端 thread-chats 同一实现）。
 *
 * 现场（15:42:56 / 15:51 两次）：模型调 bash（需审批）→ 服务端按设计挂起（流里发
 * tool-approval-request，快照落在 mastra_workflow_snapshot）→ 用户在 UI 点批准（客户端 part 到
 * approval-responded）→ **服务端毫无动静**（无新 trace、bash 没执行、DB 里消息仍 state:"call"）。
 *
 * 本 spec 把这条链按段钉死：
 *   1. 挂起面：真 chatRoute 的 SSE 里确实有 `tool-approval-request`，且流干净收尾（任务 4）；
 *   2. 客户端段：真 Chat 收下挂起流 → 拿到 approval-requested part；
 *      `chat.addToolApprovalResponse(...)`（与 ChatPage.decideApproval 同样的调用）之后，
 *      `canResumeAfterApproval` 为 true、**续跑请求真的发出去**（任务 1 的定位手段）；
 *   3. 服务端段：chatRoute 从快照 resume 成功 → bash 真执行（真实 Git Bash 回显）→ 第二轮跑完。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { canResumeAfterApproval } from '../../renderer/src/features/chat/approval'
import { mapStoredMessages } from '../../renderer/src/lib/message-map'
import { threadMemoryBody, threadMessagesResponseSchema } from '../../shared/threads'

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

/** 同一步里多个工具调用（现场形状：glob 真执行 + bash 挂起审批） */
function multiToolCallScript(
  calls: Array<{ id: string; name: string; input: unknown }>
): StreamPart[] {
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  for (const call of calls) {
    const json = JSON.stringify(call.input)
    parts.push({ type: 'tool-input-start', id: call.id, toolName: call.name })
    parts.push({ type: 'tool-input-delta', id: call.id, delta: json })
    parts.push({ type: 'tool-input-end', id: call.id })
  }
  for (const call of calls) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input)
    })
  }
  parts.push({ type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE })
  return parts
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

type ApprovalPart = {
  state: string
  toolCallId: string
  providerExecuted?: boolean
  approval?: { id?: string; approved?: boolean }
}

/** 客户端消息里找还在等审批/已回应的 bash part */
function bashPart(messages: UIMessage[]): ApprovalPart | undefined {
  for (const message of messages) {
    for (const part of message.parts as unknown as ApprovalPart[]) {
      const record = part as unknown as { type?: string; toolCallId?: string; state?: string }
      if (record.type === 'tool-bash' || record.toolCallId === 'call-bash') return part
    }
  }
  return undefined
}

/** 诊断用：客户端消息里各 part 的形状（类型/状态/工具 id，不含正文） */
function partSummary(messages: UIMessage[]): string {
  return JSON.stringify(
    messages.flatMap((message) =>
      message.parts.map((part) => {
        const record = part as unknown as Record<string, unknown>
        return {
          type: record.type,
          state: record.state,
          toolCallId: record.toolCallId,
          providerExecuted: record.providerExecuted,
          dynamic: record.dynamic,
          approval: record.approval
        }
      })
    )
  )
}

async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${label}`)
}

let dir: string
let workspace: string
let server: AgentServerHandle
let model: MockLanguageModelV4
const scripts: Array<() => StreamPart[]> = []

async function startServer(): Promise<AgentServerHandle> {
  return await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => [{ path: workspace, mode: 'ask' }],
    projects: () => []
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-resume-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))

  model = new MockLanguageModelV4({
    provider: 'kyclaw-resume-mock',
    modelId: 'kyclaw-resume-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })

  server = await startServer()
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('审批续跑：真客户端 Chat + 真 server', () => {
  it('挂起面：SSE 里发出 tool-approval-request，流干净收尾（无 error part）', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-bash', 'bash', { command: 'echo resumed-ok' }))
    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-face', role: 'user', parts: [{ type: 'text', text: '跑个命令' }] }],
        ...threadMemoryBody('thread-resume-face')
      })
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    const parts = sseParts(body)

    const approval = parts.find((part) => part.type === 'tool-approval-request')
    expect(approval).toBeDefined()
    expect(approval?.toolCallId).toBe('call-bash')
    expect(String(approval?.approvalId)).toMatch(/::call-bash$/)
    // 挂起是"干净收尾"：没有 error part，消息里 tool part 停在可审批态
    expect(parts.some((part) => part.type === 'error')).toBe(false)
    expect(body).toContain('[DONE]')
  }, 30_000)

  it('挂起面（多工具同一步）：兄弟工具的结果面**不随挂起流发出**（这就是客户端段断点的成因）', async () => {
    scripts.length = 0
    scripts.push(() =>
      multiToolCallScript([
        { id: 'call-glob', name: 'glob', input: { pattern: '**/*', path: workspace } },
        { id: 'call-bash', name: 'bash', input: { command: 'echo face-multi' } }
      ])
    )

    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-face-m', role: 'user', parts: [{ type: 'text', text: '看环境' }] }],
        ...threadMemoryBody('thread-resume-face-multi')
      })
    })
    expect(response.status).toBe(200)
    const parts = sseParts(await response.text())

    // wire 实测形状：两个工具都有输入面；glob 已经执行完但**没有** tool-output-available；
    // 审批面落在 bash 上。客户端因此把 glob 停在 input-available —— 判定必须放行它才能续跑。
    expect(parts.filter((part) => part.type === 'tool-input-available')).toHaveLength(2)
    expect(parts.some((part) => part.type === 'tool-output-available')).toBe(false)
    expect(
      parts.some((part) => part.type === 'tool-approval-request' && part.toolCallId === 'call-bash')
    ).toBe(true)
  }, 30_000)

  it('全链：批准后真的续跑 —— bash 执行、第二轮跑完、DB 消息不再停在 call', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-bash', 'bash', { command: 'echo resumed-ok' }))
    scripts.push(() => textScript('已经跑完了。'))

    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { authorization: `Bearer ${server.token}` }
      }),
      // 与 thread-chats.ts 的生产接线一致：AI SDK 用这个判定决定"批准后自动续跑"
      sendAutomaticallyWhen: ({ messages }) => canResumeAfterApproval(messages)
    })

    const options = { body: threadMemoryBody('thread-resume-live') }
    await chat.sendMessage({ text: '帮我跑个 echo' }, options)

    // 挂起：等流收完，客户端拿到 approval-requested 的 bash part
    await waitUntil(
      () => chat.status === 'ready' && bashPart(chat.messages)?.state === 'approval-requested',
      20_000,
      '挂起流收完 + approval-requested part'
    )
    const pending = bashPart(chat.messages)
    const approvalId = pending?.approval?.id
    expect(approvalId).toBeTruthy()
    expect(String(approvalId)).toMatch(/::call-bash$/)
    // 还没批准：判定不该自动续跑
    expect(canResumeAfterApproval(chat.messages)).toBe(false)

    // 用户点「允许一次」——与 ChatPage.decideApproval 同样的调用形状（请求体经 options 传）
    await chat.addToolApprovalResponse({
      id: String(approvalId),
      approved: true,
      options
    })

    // 定位探针：批准后判定必须为 true（false 就是客户端段的断点）
    expect(canResumeAfterApproval(chat.messages)).toBe(true)

    // 服务端段：续跑请求发出去、bash 真执行、第二轮回来
    await waitUntil(
      () =>
        bashPart(chat.messages)?.state === 'output-available' &&
        chat.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && 'text' in part && part.text === '已经跑完了。'
          )
        ),
      30_000,
      '续跑后 bash 执行完成 + 第二轮文本'
    )

    const tool = bashPart(chat.messages) as unknown as { output?: unknown }
    expect(String(tool.output)).toContain('resumed-ok')
    expect(scripts.length).toBe(0) // 两个脚本都被消费 = 服务端确实跑了第二轮
  }, 60_000)

  it('现场形状：同一步 glob（真执行）+ bash（挂起）→ 批准 bash 后续跑', async () => {
    scripts.length = 0
    scripts.push(() =>
      multiToolCallScript([
        { id: 'call-glob', name: 'glob', input: { pattern: '**/*', path: workspace } },
        { id: 'call-bash', name: 'bash', input: { command: 'echo field-shape-ok' } }
      ])
    )
    scripts.push(() => textScript('都处理完了。'))

    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { authorization: `Bearer ${server.token}` }
      }),
      sendAutomaticallyWhen: ({ messages }) => canResumeAfterApproval(messages)
    })

    const options = { body: threadMemoryBody('thread-resume-fieldshape') }
    await chat.sendMessage({ text: '看看工作环境' }, options)

    await waitUntil(
      () => chat.status === 'ready' && bashPart(chat.messages)?.state === 'approval-requested',
      20_000,
      '挂起流收完 + approval-requested part'
    )

    const pending = bashPart(chat.messages)
    const approvalId = pending?.approval?.id
    expect(String(approvalId)).toMatch(/::call-bash$/)
    expect(canResumeAfterApproval(chat.messages)).toBe(false)

    await chat.addToolApprovalResponse({ id: String(approvalId), approved: true, options })
    // 客户端段的核心判据：批准后判定必须放行（glob 还停在 input-available，见 approval.ts 头注第 3 条）
    expect(canResumeAfterApproval(chat.messages)).toBe(true)

    await waitUntil(
      () =>
        bashPart(chat.messages)?.state === 'output-available' &&
        chat.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && 'text' in part && part.text === '都处理完了。'
          )
        ),
      30_000,
      `续跑完成（client parts: ${partSummary(chat.messages)}）`
    )

    const tool = bashPart(chat.messages) as unknown as { output?: unknown }
    expect(String(tool.output)).toContain('field-shape-ok')
    // 续跑那轮把兄弟工具（glob）的结果也补上了：挂起时是 input-available，收尾必须是 output-available
    const glob = chat.messages
      .flatMap((message) => message.parts)
      .find((part) => (part as { toolCallId?: string }).toolCallId === 'call-glob') as unknown as
      { state?: string; output?: unknown } | undefined
    expect(glob?.state).toBe('output-available')
    expect(String(glob?.output)).toContain(workspace)
  }, 60_000)

  it('验收：重启后 —— 挂起审批从存储恢复成可审批卡片，批准后新进程从快照续跑', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-bash', 'bash', { command: 'echo after-restart-ok' }))
    scripts.push(() => textScript('重启后也跑完了。'))

    const threadId = 'thread-resume-restart'
    const suspended = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-restart', role: 'user', parts: [{ type: 'text', text: '跑个 echo' }] }],
        ...threadMemoryBody(threadId)
      })
    })
    expect(suspended.status).toBe(200)
    expect(
      sseParts(await suspended.text()).some((part) => part.type === 'tool-approval-request')
    ).toBe(true)

    // 重启应用：停掉服务，用同一个 dataDir 起新进程（快照与消息都在库里）
    await server.stop()
    server = await startServer()

    // 重开会话：历史从存储回灌（渲染端 message-map），挂起的审批要恢复成 approval-requested
    const messagesResponse = await fetch(
      `${server.baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages`,
      { headers: { authorization: `Bearer ${server.token}` } }
    )
    expect(messagesResponse.status).toBe(200)
    const { messages } = threadMessagesResponseSchema.parse(await messagesResponse.json())
    const restored = mapStoredMessages(messages)
    const restoredBash = restored
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool-bash') as unknown as
      { state?: string; approval?: { id?: string } } | undefined
    expect(restoredBash?.state).toBe('approval-requested')
    const approvalId = restoredBash?.approval?.id
    expect(String(approvalId)).toMatch(/::call-bash$/)

    // 新客户端（初值 = 回灌出来的历史）＋ 生产同款判定：批准 → 自动续跑
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { authorization: `Bearer ${server.token}` }
      }),
      messages: restored,
      sendAutomaticallyWhen: ({ messages }) => canResumeAfterApproval(messages)
    })
    await chat.addToolApprovalResponse({
      id: String(approvalId),
      approved: true,
      options: { body: threadMemoryBody(threadId) }
    })

    await waitUntil(
      () =>
        bashPart(chat.messages)?.state === 'output-available' &&
        chat.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && 'text' in part && part.text === '重启后也跑完了。'
          )
        ),
      30_000,
      `重启后续跑完成（client parts: ${partSummary(chat.messages)}）`
    )
    const tool = bashPart(chat.messages) as unknown as { output?: unknown }
    expect(String(tool.output)).toContain('after-restart-ok')
  }, 60_000)
})
