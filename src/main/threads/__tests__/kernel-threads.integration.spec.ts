// @vitest-environment node
/**
 * PB-024 真机集成（默认 skip，`KYCLAW_KERNEL_E2E=1` 才跑）：
 * - 起真内核（新布局 resources/kernel/rc.2）+ 本地 Anthropic stub，跑一轮真实 prompt；
 * - 覆盖 R3：workspace cwd 的 thread 发第一条消息成功；
 * - 覆盖 R1：adapter 自己建 + 真跑一轮 → messages 返回 1 user + 1 assistant；
 * - 覆盖 R2：adapter 的 defaultSessionId 不出现在 GET /；
 * - 覆盖 list/create/rename/compact/archive 的 9 端点接线。
 *
 * 开启：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='F:\deepseekharness\DeepSeek Harness.exe'
 *   $env:KYCLAW_KERNEL_ASAR='E:\gitlab\kyclaw\resources\kernel\rc.2'
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { maybeStartKernelAdapter } from '../../kernel/kernel-bootstrap'
import type { KernelAdapter } from '../../kernel/kernel-adapter'
import { createKernelSessionOpsForAdapter } from '../../kernel/kernel-session-ops'
import { createKernelThreadsRouter } from '../kernel-threads'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'E:\\gitlab\\kyclaw\\resources\\kernel\\rc.2'
const POC_TEXT = 'POC-OK：内核 RPC 与事件流可用。'

/** 本地 Anthropic Messages 兼容 stub（只监听回环；离线） */
function startStub(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url ?? '')) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_b24_stub',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 }
        }
      })
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: POC_TEXT }
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 8 }
      })
      send('message_stop', { type: 'message_stop' })
      res.end()
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

describe.runIf(ENABLED)('PB-024 kernel threads 真机集成', () => {
  it('workspace cwd 首轮 + 历史读取 + 幽灵会话过滤', async () => {
    const stub = await startStub()
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-b24-'))
    const workspace = join(root, 'workspace')
    const appData = join(root, 'appdata')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(appData, { recursive: true })
    let adapter: KernelAdapter | undefined
    try {
      adapter = await maybeStartKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir: appData,
        dshHome: join(root, 'dsh-home'),
        resolveCwd: (threadId) => (threadId === undefined ? appData : workspace),
        extraEnv: {
          DEEPSEEK_API_KEY: 'test',
          DEEPSEEK_BASE_URL: stub.baseUrl
        },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 60_000
      })
      const live = adapter
      const ops = createKernelSessionOpsForAdapter(live)
      const app = createKernelThreadsRouter({
        ops,
        defaultCwd: workspace,
        defaultSessionId: live.defaultSessionId,
        cwdOf: () => workspace
      })
      const threadId = `b24-${String(Date.now())}`

      const created = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, title: 'B24 真机会话' })
      })
      expect(created.status).toBe(200)
      await expect(created.json()).resolves.toMatchObject({ id: threadId, title: 'B24 真机会话' })

      // R3：同一 thread 的 startTurn 必须用 workspace cwd，不能 session/conflict
      const turn = await live.startTurn('say hi', { threadId })
      expect(turn.text).toBe(POC_TEXT)

      const list = await app.request('/')
      expect(list.status).toBe(200)
      const listBody = (await list.json()) as { threads: Array<{ id: string }> }
      const ids = listBody.threads.map((thread) => thread.id)
      expect(ids).toContain(threadId)
      // R2：adapter 启动时自建的默认会话不能当线程
      expect(ids).not.toContain(live.defaultSessionId)

      const renamed = await app.request(`/${threadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'B24 改名后' })
      })
      expect(renamed.status).toBe(200)
      await expect(renamed.json()).resolves.toMatchObject({ id: threadId, title: 'B24 改名后' })

      // R1：真跑一轮后必须能读到 1 user + 1 assistant
      const messages = await app.request(`/${threadId}/messages`)
      expect(messages.status).toBe(200)
      const messageBody = (await messages.json()) as {
        messages: Array<{ role: string }>
      }
      expect(messageBody.messages.map((message) => message.role)).toEqual(['user', 'assistant'])

      const compacted = await app.request(`/${threadId}/compact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
      expect(compacted.status).toBe(200)
      await expect(compacted.json()).resolves.toHaveProperty('compacted')

      const archived = await app.request(`/${threadId}`, { method: 'DELETE' })
      expect(archived.status).toBe(200)
      await expect(archived.json()).resolves.toEqual({ ok: true })

      const afterArchive = await app.request('/')
      const afterBody = (await afterArchive.json()) as { threads: Array<{ id: string }> }
      expect(afterBody.threads.map((thread) => thread.id)).not.toContain(threadId)
    } finally {
      await adapter?.stop()
      await new Promise<void>((resolve) => {
        stub.server.close(() => resolve())
      })
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] b24 integration cleanup deferred', root)
      }
    }
  }, 180_000)
})
