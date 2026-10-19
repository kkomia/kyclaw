// @vitest-environment node
/**
 * PB-024 真机集成（默认 skip）：
 * - 起真内核（新布局 resources/kernel/rc.2；Bao/Kai 的 PB-006 落地后可用）
 * - 用 createKernelSessionOpsForAdapter 走 list/create/rename/page/archive/compact
 * - 只验 HTTP 9 端点的内核接线，不跑模型轮次（无密钥/无 stub，避免把模型问题混进来）
 *
 * 开启：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='F:\deepseekharness\DeepSeek Harness.exe'
 *   $env:KYCLAW_KERNEL_ASAR='E:\gitlab\kyclaw\resources\kernel\rc.2'
 */
import { mkdtempSync, rmSync } from 'node:fs'
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

describe.runIf(ENABLED)('PB-024 kernel threads 真机集成', () => {
  it('create/list/rename/messages/archive/compact 走真内核', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-b24-'))
    const workspace = join(root, 'workspace')
    let adapter: KernelAdapter | null = null
    try {
      adapter = await maybeStartKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir: join(root, 'appdata'),
        dshHome: join(root, 'dsh-home'),
        env: { ...process.env, KYCLAW_KERNEL_PORT: '1' },
        readyTimeoutMs: 30_000
      })
      expect(adapter).not.toBeNull()
      const live = adapter as KernelAdapter
      const ops = createKernelSessionOpsForAdapter(live)
      const app = createKernelThreadsRouter({
        ops,
        defaultCwd: workspace,
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

      const list = await app.request('/')
      expect(list.status).toBe(200)
      const listBody = (await list.json()) as { threads: Array<{ id: string }> }
      expect(listBody.threads.map((thread) => thread.id)).toContain(threadId)

      const renamed = await app.request(`/${threadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'B24 改名后' })
      })
      expect(renamed.status).toBe(200)
      await expect(renamed.json()).resolves.toMatchObject({ id: threadId, title: 'B24 改名后' })

      const messages = await app.request(`/${threadId}/messages`)
      expect(messages.status).toBe(200)
      await expect(messages.json()).resolves.toMatchObject({ messages: [] })

      const compacted = await app.request(`/${threadId}/compact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
      expect(compacted.status).toBe(200)
      await expect(compacted.json()).resolves.toMatchObject({ compacted: false, compaction: null })

      const archived = await app.request(`/${threadId}`, { method: 'DELETE' })
      expect(archived.status).toBe(200)
      await expect(archived.json()).resolves.toEqual({ ok: true })
    } finally {
      await adapter?.stop()
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] b24 integration cleanup deferred', root)
      }
    }
  }, 120_000)
})
