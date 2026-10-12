// @vitest-environment node
/**
 * 审批回调里的"会话是谁"（round 46 实证）。
 *
 * 背景：权限 chip 显示「完全访问」，但 bash 不给 cwd 时仍弹审批卡 —— guard.needsApproval 的
 * "无显式目标"分支判不了"这个会话的根是哪个工作区"，只能拿整份授权列表保守判（见 guard.ts 头注）。
 *
 * 本 spec 先钉**运行时事实**：真跑一轮（真 mastra agent + 真 chatRoute + stub 模型），让一个
 * 探针工具的 `requireApproval` 把第二参原样记下来 —— 到底有没有一个能反推线程 id 的键。
 * 再钉**判定口径**：完全访问（会话根 full）下 bash 不给 cwd 不弹卡；ask 档照弹。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { approvalSessionOf } from '../tools/guard'
import { threadMemoryBody } from '../../shared/threads'
import { z } from '../../shared/zod'
import type { Workspace } from '../../shared/settings'

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

function mockModel(scripts: Array<() => StreamPart[]>, id: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: id,
    modelId: id,
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })
}

/** 探针回调收到的第二参（原样记下来，别在断言里再加工） */
type CapturedApproval = {
  args?: unknown
  requestContext?: Record<string, unknown>
  workspace?: unknown
}

let dir: string
let workspaceA: string
let workspaceB: string
let probeScripts: Array<() => StreamPart[]>
let probeServer: { baseUrl: string; stop(): Promise<void> } | undefined
let kyclawServer: AgentServerHandle | undefined
let kyclawModel: MockLanguageModelV4
let kyclawScripts: Array<() => StreamPart[]>
let workspaces: Workspace[]
let defaultWorkspace: string | null
const captured: CapturedApproval[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-approval-session-'))
  mkdirSync(join(dir, 'ws-a'), { recursive: true })
  mkdirSync(join(dir, 'ws-b'), { recursive: true })
  workspaceA = realpathSync.native(join(dir, 'ws-a'))
  workspaceB = realpathSync.native(join(dir, 'ws-b'))
}, 60_000)

afterAll(async () => {
  await probeServer?.stop()
  await kyclawServer?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('实证：requireApproval 回调的第二参里有什么', () => {
  it('真跑一轮：approvalCtx.requestContext 是摊平的 plain object，线程 id 从 MastraMemory.thread.id 取', async () => {
    const [
      { Hono },
      { serve },
      { MastraServer },
      { Mastra },
      { LibSQLStore },
      { Memory },
      { chatRoute },
      { Agent },
      { createTool }
    ] = await Promise.all([
      import('hono'),
      import('@hono/node-server'),
      import('@mastra/hono'),
      import('@mastra/core/mastra'),
      import('@mastra/libsql'),
      import('@mastra/memory'),
      import('@mastra/ai-sdk'),
      import('@mastra/core/agent'),
      import('@mastra/core/tools')
    ])

    const storage = new LibSQLStore({
      id: 'probe-storage',
      url: `file:${join(dir, 'probe.db').replace(/\\/g, '/')}`
    })
    const memory = new Memory({ storage, options: { lastMessages: 10 } })
    // 探针工具：requireApproval 把第二参原样记下来，返回 false（不挂审批，走完真链路）
    const probe = createTool({
      id: 'probe',
      description: '审批上下文探针',
      inputSchema: z.object({ note: z.string() }),
      outputSchema: z.string(),
      requireApproval: (_input: unknown, approval?: CapturedApproval) => {
        captured.push(approval ?? {})
        return false
      },
      execute: async () => 'probe-ok'
    })
    probeScripts = [
      () => toolCallScript('call-probe', 'probe', { note: 'hi' }),
      () => textScript('探完了。')
    ]
    const model = mockModel(probeScripts, 'kyclaw-probe-mock')
    const agent = new Agent({
      id: 'probe-agent',
      name: 'probe-agent',
      instructions: '只调探针工具。',
      model,
      memory,
      tools: { probe }
    })
    const mastra = new Mastra({
      agents: { 'probe-agent': agent },
      storage,
      server: {
        apiRoutes: [
          chatRoute({ path: '/chat/:agentId', version: 'v7', defaultOptions: { maxSteps: 5 } })
        ]
      }
    })
    const app = new Hono()
    const mastraServer = new MastraServer({ app, mastra })
    await mastraServer.init()
    const httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', () => resolve())
      httpServer.once('error', reject)
    })
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('拿不到探针端口')
    probeServer = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      stop: async () => {
        await mastra.shutdown().catch(() => {})
        await storage.close().catch(() => {})
        if ('closeAllConnections' in httpServer) httpServer.closeAllConnections()
        await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      }
    }

    const threadId = 'thread-probe-ctx'
    const response = await fetch(`${probeServer.baseUrl}/chat/probe-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'u-probe', role: 'user', parts: [{ type: 'text', text: '探一下' }] }],
        ...threadMemoryBody(threadId)
      })
    })
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    const approval = captured[0]
    // 回调第一参是解析后的入参；第二参 = { args, requestContext, workspace }（core 的
    // buildToolApprovalContext 形状，见 guard.approvalSessionOf 头注）
    expect(approval.args).toEqual({ note: 'hi' })
    const requestContext = approval.requestContext
    expect(requestContext).toBeDefined()
    // 摊平后的 plain object：没有 RequestContext 实例的方法（core 做了
    // Object.fromEntries([...entries()])，见 @mastra/core/dist/agent-*.js 的 tool-approval-verdict 段）
    expect(typeof (requestContext as { get?: unknown }).get).toBe('undefined')
    const keys = Object.keys(requestContext ?? {})
    // 线程 id 的真实来源：MastraMemory.thread.id（agent 每轮写进 requestContext 的那份）
    const memoryValue = (requestContext as Record<string, unknown>).MastraMemory as
      { thread?: { id?: unknown } } | undefined
    expect(memoryValue?.thread?.id).toBe(threadId)
    // 实证记录的键清单（诊断；换 core 版本后这条断言失败就把实际情况抄回 guard 头注）
    console.log('[kyclaw] approvalCtx.requestContext 键：', JSON.stringify(keys))
    expect(keys, `实际键：${JSON.stringify(keys)}`).toContain('MastraMemory')
    // core 的单键线程 id（MASTRA_THREAD_ID_KEY）在这条路径上**不存在**（1.75.0 实测）；
    // guard 里留了兜底 —— 哪天它出现了，值必须与线程 id 一致
    const direct = (requestContext as Record<string, unknown>).mastra__threadId
    if (direct !== undefined) expect(direct).toBe(threadId)
    // helper 从真相里取出来的就是当前线程（各工具 requireApproval 走的就是它）
    expect(approvalSessionOf(approval)).toBe(threadId)
  }, 60_000)
})

async function startKyclawServer(): Promise<void> {
  kyclawScripts = []
  kyclawModel = mockModel(kyclawScripts, 'kyclaw-approval-session-mock')
  kyclawServer = await startAgentServer({
    dataDir: dir,
    model: kyclawModel,
    workspaces: () => workspaces,
    defaultWorkspace: () => defaultWorkspace,
    projects: () => []
  })
}

async function sendBash(threadId: string, input: unknown): Promise<string> {
  kyclawScripts.length = 0
  kyclawScripts.push(() => toolCallScript('call-bash', 'bash', input))
  // 第二个脚本只会在"工具跑完 → 续跑第二轮"时被消费：它还剩着 = 这一轮停在挂起/出错
  kyclawScripts.push(() => textScript('看完了。'))
  const response = await fetch(`${kyclawServer?.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${kyclawServer?.token}`
    },
    body: JSON.stringify({
      messages: [{ id: 'u-bash', role: 'user', parts: [{ type: 'text', text: '看看目录' }] }],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  return await response.text()
}

describe('判定口径：无显式目标的 bash 按会话根判 full', () => {
  it('用户场景：多工作区（会话根 full + 另一个 ask）+ bash 不给 cwd → 不弹审批', async () => {
    workspaces = [
      { path: workspaceA, mode: 'full' },
      { path: workspaceB, mode: 'ask' }
    ]
    defaultWorkspace = workspaceA
    await startKyclawServer()

    const body = await sendBash('thread-full-root', { command: 'pwd && ls -la' })
    const parts = sseParts(body)
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(
      parts.some((part) => part.type === 'tool-input-available' && part.toolName === 'bash')
    ).toBe(true)
    // 免审的硬证据：命令真跑了、第二轮也真跑了（挂起的话两个脚本都不会被走完）
    expect(parts.some((part) => part.type === 'tool-output-available')).toBe(true)
    expect(kyclawScripts.length).toBe(0)
    await kyclawServer?.stop()
    kyclawServer = undefined
  }, 60_000)

  it('对照组：同一个多工作区布局，会话根是 ask 档 → 照弹审批', async () => {
    workspaces = [
      { path: workspaceA, mode: 'ask' },
      { path: workspaceB, mode: 'full' }
    ]
    defaultWorkspace = workspaceA
    await startKyclawServer()

    const body = await sendBash('thread-ask-root', { command: 'pwd && ls -la' })
    const parts = sseParts(body)
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(true)
    // 挂起即止：工具没执行、续跑那轮没跑（第二个脚本留着）
    expect(parts.some((part) => part.type === 'tool-output-available')).toBe(false)
    expect(kyclawScripts.length).toBe(1)
    await kyclawServer?.stop()
    kyclawServer = undefined
  }, 60_000)

  it('显式目标不变：bash 带 cwd 落在 ask 工作区 → 照弹审批', async () => {
    workspaces = [
      { path: workspaceA, mode: 'full' },
      { path: workspaceB, mode: 'ask' }
    ]
    defaultWorkspace = workspaceA
    await startKyclawServer()

    const body = await sendBash('thread-explicit-target', {
      command: 'pwd',
      cwd: workspaceB
    })
    const parts = sseParts(body)
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(true)
    await kyclawServer?.stop()
    kyclawServer = undefined
  }, 60_000)
})
