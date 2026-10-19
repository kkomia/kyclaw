// @vitest-environment node
/**
 * PB-021 / Wave B · 审批真实链路（**真内核 + 本地 Anthropic stub provider；默认 skip**）
 *
 * 目的：不碰 UI、不要真密钥，验证「内核真的会申请审批 → main 真的能应答 → 内核真的按结果执行/不执行」：
 *   A. 触发（确定性）：stub provider 让模型调 `write`，参数带 `sandbox_permissions:'danger-full-access'` +
 *      `justification` —— 内核把它当"沙箱升级请求"，**必然产生审批**（Step 0 实测：
 *      `approval {toolName:'write', callId:'toolu_approval_1', reason:'escalate sandbox to danger-full-access: …'}`）。
 *   B. 应答：adapter 层 `respondInteraction`；HTTP 层 `POST /api/kernel/interactions/:eventId/respond`
 *      （Bao 的 PB-026 写面）。
 *   C. 断言到**帧级**：allowed-once → 文件真落盘 + `tool-output-available`；rejected → 文件不落盘 +
 *      `tool-output-error`，且正文（"工具已完成。"）不被替换；hub 结果行 outcome 四态之一。
 *
 * 失败诊断三分类（不混）：
 *   E1 未触发：等 interaction 超时 → 失败消息带 follow 事件序列 + 轮结果（策略自动放行/工具名不对/gateway 未开）；
 *   E2 应答通道失败：respond HTTP 非 200 / adapter 抛错 → 带状态码与内核错误文本；
 *   E3 语义错：pending/result 字段 expected/actual 全量打印。
 *
 * 跑法（gated；不进 `pnpm test:e2e` / CI）：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='E:\gitlab\kyclaw\node_modules\electron\dist\electron.exe'   # 可省，默认这个
 *   $env:KYCLAW_KERNEL_ROOT='E:\gitlab\kyclaw\resources\kernel'                              # 可省，默认这个
 *   pnpm exec vitest run src/main/kernel/__tests__/nia-approval-real.integration.spec.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startAgentServer } from '../../agent/service'
import { KYCLAW_AGENT_ID } from '../../../shared/agent-id'
import { InteractionHub, applyInteractionEvent, feedKernelEvent, respondAndDismiss } from '../interaction-hub'
import { startKernelAdapter, type KernelAdapter } from '../kernel-adapter'
import type { KernelInteractionEvent } from '../kernel-interactions'
import { resolveKernelLayout } from '../kernel-layout'
import type { KernelFollowValue, RendererSseFrame } from '../sse-map'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const PROBE = process.env.KYCLAW_APPROVAL_PROBE === '1'
const ELECTRON =
  process.env.KYCLAW_KERNEL_ELECTRON ?? join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const KERNEL_ROOT = process.env.KYCLAW_KERNEL_ROOT ?? join(repoRoot, 'resources', 'kernel')

function kernelVersionDir(): string | null {
  const layout = resolveKernelLayout({ kernelRoot: KERNEL_ROOT })
  return layout.ok ? layout.versionDir : null
}

const VERSION_DIR = kernelVersionDir()
const READY_TO_RUN = ENABLED && VERSION_DIR !== null

/** 本地 Anthropic Messages stub：第一次响应 = tool_use（完整 input），之后 = 文本收尾。 */
function startToolStub(tool: { name: string; input: Record<string, unknown> }): Promise<{
  server: Server
  baseUrl: string
}> {
  let calls = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    request.on('end', () => {
      void body
      if (request.method !== 'POST' || !/\/v1\/messages/.test(request.url ?? '')) {
        response.writeHead(404).end('not found')
        return
      }
      calls += 1
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: `msg_approval_${String(calls)}`,
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 }
        }
      })
      if (calls === 1) {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_approval_1', name: tool.name, input: {} }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
      } else {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '工具已完成。' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
      }
      send('message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({ server, baseUrl: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

function approvalTool(target: string): { name: string; input: Record<string, unknown> } {
  return {
    name: 'write',
    input: {
      file_path: target,
      content: 'approval probe',
      sandbox_permissions: 'danger-full-access',
      justification: '探针：需要写工作区外文件'
    }
  }
}

interface AdapterHandle {
  adapter: KernelAdapter
  hub: InteractionHub
  interactions: KernelInteractionEvent[]
  followTypes: string[]
  stop: () => Promise<void>
}

async function startRealAdapter(extraEnv: Record<string, string> = {}): Promise<AdapterHandle> {
  if (VERSION_DIR === null) throw new Error(`kernel layout unavailable: ${KERNEL_ROOT}`)
  const dataDir = mkdtempSync(join(tmpdir(), 'kyclaw-approval-real-'))
  const hub = new InteractionHub()
  const interactions: KernelInteractionEvent[] = []
  const followTypes: string[] = []
  const adapter = await startKernelAdapter({
    electronExecutable: ELECTRON,
    asarPath: VERSION_DIR,
    appDataDir: dataDir,
    extraEnv,
    readyTimeoutMs: 45_000,
    turnTimeoutMs: 120_000,
    onInteractionEvent: (event) => {
      interactions.push(event)
      applyInteractionEvent(hub, event)
    },
    onSessionEvent: (threadId, event) => {
      feedKernelEvent(hub, threadId, event)
    },
    onFollowValue: (value: KernelFollowValue) => {
      followTypes.push(value.type === 'event' ? `event:${value.event.type}` : value.type)
    }
  })
  return {
    adapter,
    hub,
    interactions,
    followTypes,
    stop: async () => {
      await adapter.stop()
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // 忽略清理失败
      }
    }
  }
}

/** 等审批请求（E1：超时抛可诊断错误，附 follow 事件序列） */
async function waitForApproval(handle: AdapterHandle, timeoutMs = 25_000): Promise<KernelInteractionEvent> {
  const deadline = Date.now() + timeoutMs
  while (handle.interactions.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (handle.interactions.length === 0) {
    throw new Error(
      `E1 未触发审批：${String(timeoutMs)}ms 内 $events 没有 approval 请求；` +
        `follow 事件序列=${JSON.stringify(handle.followTypes.slice(-20))}`
    )
  }
  return handle.interactions[0] as KernelInteractionEvent
}

function textOf(frames: readonly RendererSseFrame[]): string {
  return frames.flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : [])).join('')
}

function frameTypes(frames: readonly RendererSseFrame[]): string[] {
  return frames.map((frame) => frame.type)
}

function parseSse(text: string): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((value) => value.startsWith('data:'))
    if (line === undefined) continue
    try {
      frames.push(JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>)
    } catch {
      // 非 JSON 行忽略
    }
  }
  return frames
}

function cleanupFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // 忽略
  }
}

describe.runIf(READY_TO_RUN)('PB-021/WaveB · 审批真实链路（真内核 + 本地 stub provider）', () => {
  it('allowed-once：审批请求字段对、文件真落盘、tool-output-available、hub 结果行 allowed-once', async () => {
    const target = join(tmpdir(), `kyclaw-approval-allowed-${String(Date.now())}.txt`)
    const stub = await startToolStub(approvalTool(target))
    const handle = await startRealAdapter({ DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl })
    try {
      const turnPromise = handle.adapter.startTurn('写一个文件到工作区外', { threadId: 'thread-approval-allow' })
      // 立即挂错误处理：断言失败时 turn 仍在等审批，stop() 会让它 reject（不能变 unhandled rejection）
      const settled = turnPromise.then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error })
      )
      const interaction = await waitForApproval(handle)
      console.log('[approval-real] interaction', JSON.stringify(interaction))
      expect(interaction.kind).toBe('approval')
      if (interaction.kind !== 'approval') return
      expect(interaction.toolName).toBe('write')
      expect(interaction.callId).toBe('toolu_approval_1')
      expect(interaction.threadId).toBe('thread-approval-allow')
      expect(interaction.reason ?? '').toContain('danger-full-access')

      // hub 挂起：waterfall（可应答，id=eventId）与内核审计 asked（只观察）**两条都在**，属设计（id 不同源）
      const pending = handle.hub.snapshot('thread-approval-allow').approvals.pending
      console.log('[approval-real] pending', JSON.stringify(pending))
      expect(pending.some((item) => item.id === interaction.eventId)).toBe(true)
      expect(pending.some((item) => item.source === 'waterfall')).toBe(true)

      // E2：应答走 PB-025 的 respondAndDismiss（应答内核 + 摘本地挂起；HTTP 面由 route 做同一件事）
      await respondAndDismiss(handle.adapter, handle.hub, 'thread-approval-allow', {
        eventId: interaction.eventId,
        kind: 'approval',
        outcome: 'allowed-once'
      })
      const settledResult = await settled
      if (!settledResult.ok) throw settledResult.error
      const result = settledResult.result
      expect(result.error).toBeUndefined()
      expect(textOf(result.frames)).toBe('工具已完成。')
      expect(frameTypes(result.frames)).toContain('tool-input-available')
      expect(frameTypes(result.frames)).toContain('tool-output-available')
      expect(frameTypes(result.frames)).not.toContain('tool-output-error')

      // 真工具执行（内核按 allow 真的写了文件）
      expect(existsSync(target), '允许后文件应真实存在').toBe(true)
      expect(readFileSync(target, 'utf8')).toBe('approval probe')

      // hub 四态：结果行 outcome=allowed-once、挂起清空
      const after = handle.hub.snapshot('thread-approval-allow')
      expect(after.approvals.pending).toHaveLength(0)
      expect(after.approvals.results).toHaveLength(1)
      expect(after.approvals.results[0]?.outcome, JSON.stringify(after.approvals.results)).toBe(
        'allowed-once'
      )
    } finally {
      await handle.stop()
      await closeServer(stub.server)
      cleanupFile(target)
    }
  }, 180_000)

  it('rejected：文件不落盘、tool-output-error 出现、正文不被替换、hub 结果行 rejected', async () => {
    const target = join(tmpdir(), `kyclaw-approval-rejected-${String(Date.now())}.txt`)
    const stub = await startToolStub(approvalTool(target))
    const handle = await startRealAdapter({ DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl })
    try {
      const turnPromise = handle.adapter.startTurn('写一个文件到工作区外', { threadId: 'thread-approval-reject' })
      const settled = turnPromise.then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error })
      )
      const interaction = await waitForApproval(handle)
      if (interaction.kind !== 'approval') throw new Error(`E3 期望 approval，实际 ${interaction.kind}`)
      const pendingBefore = handle.hub.snapshot('thread-approval-reject').approvals.pending
      expect(pendingBefore.some((item) => item.id === interaction.eventId)).toBe(true)
      await respondAndDismiss(handle.adapter, handle.hub, 'thread-approval-reject', {
        eventId: interaction.eventId,
        kind: 'approval',
        outcome: 'rejected'
      })
      const settledResult = await settled
      if (!settledResult.ok) throw settledResult.error
      const result = settledResult.result
      expect(result.error).toBeUndefined()
      // 帧级：被拒的工具给 error 帧，但模型继续 → 正文仍是第二段文本（不替换/不截断）
      expect(frameTypes(result.frames)).toContain('tool-output-error')
      expect(frameTypes(result.frames)).not.toContain('tool-output-available')
      expect(textOf(result.frames)).toBe('工具已完成。')
      expect(existsSync(target), '拒绝后文件不应存在').toBe(false)

      const after = handle.hub.snapshot('thread-approval-reject')
      expect(after.approvals.pending).toHaveLength(0)
      expect(after.approvals.results[0]?.outcome, JSON.stringify(after.approvals.results)).toBe(
        'rejected'
      )
    } finally {
      await handle.stop()
      await closeServer(stub.server)
      cleanupFile(target)
    }
  }, 180_000)

  it('HTTP 面：/chat SSE + /api/kernel/interactions 挂起 + POST respond 闭环', async () => {
    const target = join(tmpdir(), `kyclaw-approval-http-${String(Date.now())}.txt`)
    const stub = await startToolStub(approvalTool(target))
    const dataDir = mkdtempSync(join(tmpdir(), 'kyclaw-approval-http-data-'))
    const previousFlag = process.env.KYCLAW_KERNEL_PORT
    process.env.KYCLAW_KERNEL_PORT = '1'
    let server: Awaited<ReturnType<typeof startAgentServer>> | undefined
    try {
      server = await startAgentServer({
        dataDir,
        kernel: {
          electronExecutable: ELECTRON,
          asarPath: VERSION_DIR as string,
          extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl }
        }
      })
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
      const threadId = 'thread-http-approval'
      const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '写一个文件到工作区外' }] }],
          memory: { thread: threadId }
        })
      })
      expect(response.status).toBe(200)

      // E1：等挂起（超时就拿 SSE 全文做诊断）
      const deadline = Date.now() + 30_000
      let pending: Array<Record<string, unknown>> = []
      while (Date.now() < deadline) {
        const snapshot = (await (
          await fetch(`${server.baseUrl}/kernel/interactions?threadId=${encodeURIComponent(threadId)}`, {
            headers
          })
        ).json()) as { approvals?: { pending?: Array<Record<string, unknown>> } }
        pending = snapshot.approvals?.pending ?? []
        if (pending.length > 0) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (pending.length === 0) {
        const body = await response.text()
        throw new Error(`E1 未触发审批（HTTP）：SSE=${body.slice(0, 1200)}`)
      }
      expect(pending.some((item) => item.toolName === 'write')).toBe(true)
      const waterfall = pending.find((item) => item.source === 'waterfall')
      expect(waterfall, `HTTP 挂起里应有可应答 waterfall 项：${JSON.stringify(pending)}`).toBeTruthy()
      const eventId = String(waterfall?.id ?? '')

      // E2：应答通道
      const respond = await fetch(
        `${server.baseUrl}/api/kernel/interactions/${encodeURIComponent(eventId)}/respond`,
        { method: 'POST', headers, body: JSON.stringify({ kind: 'approval', outcome: 'allowed-once' }) }
      )
      const respondBody = (await respond.json()) as Record<string, unknown>
      expect(respond.status, JSON.stringify(respondBody)).toBe(200)
      expect(respondBody.status).toBe('responded')

      // 同一 eventId 重复提交 → 409（语义：已结算）
      const again = await fetch(
        `${server.baseUrl}/api/kernel/interactions/${encodeURIComponent(eventId)}/respond`,
        { method: 'POST', headers, body: JSON.stringify({ kind: 'approval', outcome: 'allowed-once' }) }
      )
      expect(again.status).toBe(409)

      const sse = await response.text()
      const frames = parseSse(sse)
      const types = frames.map((frame) => String(frame.type))
      expect(types).toContain('tool-output-available')
      const text = frames
        .flatMap((frame) => (frame.type === 'text-delta' && typeof frame.delta === 'string' ? [frame.delta] : []))
        .join('')
      expect(text).toBe('工具已完成。')
      expect(existsSync(target), 'HTTP 链路允许后文件应真实存在').toBe(true)

      const final = (await (
        await fetch(`${server.baseUrl}/kernel/interactions?threadId=${encodeURIComponent(threadId)}`, {
          headers
        })
      ).json()) as { approvals?: { pending?: unknown[]; results?: Array<{ outcome?: string }> } }
      expect(final.approvals?.pending ?? []).toHaveLength(0)
      expect(final.approvals?.results?.[0]?.outcome).toBe('allowed-once')
    } finally {
      await server?.stop()
      if (previousFlag === undefined) delete process.env.KYCLAW_KERNEL_PORT
      else process.env.KYCLAW_KERNEL_PORT = previousFlag
      await closeServer(stub.server)
      cleanupFile(target)
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // 忽略
      }
    }
  }, 240_000)
})

describe.runIf(ENABLED && VERSION_DIR !== null && PROBE)('PB-021/WaveB · Step 0 触发探针（诊断用）', () => {
  it('探 commands/list 与 /permission（找确定性审批入口）', async () => {
    const handle = await startRealAdapter()
    try {
      const commands = await handle.adapter.listCommands()
      console.log('[approval-probe] commands', JSON.stringify(commands))
      for (const line of ['/permission', '/permission read-only', '/permission', '/permission workspace-write']) {
        try {
          const result = await handle.adapter.executeCommand(line)
          console.log(`[approval-probe] ${line} ->`, JSON.stringify(result))
        } catch (error) {
          console.log(`[approval-probe] ${line} ERR`, String(error))
        }
      }
      expect(commands.some((command) => command.name === 'permission')).toBe(true)
    } finally {
      await handle.stop()
    }
  }, 180_000)
})
