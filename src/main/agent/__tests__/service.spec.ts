// @vitest-environment node
/**
 * PB-020 B：`startAgentServer` 的启动闸门（旧 Mastra loop 的 HTTP/chat/端口用例已删）。
 *
 * 覆盖迁移：
 * - 401/token、`/api/tasks` 501、`/api/kernel/*`：`b3-1b` / `feature-disabled.spec` / e2e 覆盖；
 * - 端口占用/stop：旧实现依赖旧 chat 连接，已随旧 loop 删除；打包态由发布验证兜底。
 * 这里只钉「内核必启」的失败面：配置缺失/路径不存在都必须是可诊断的 KernelStartupError。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer } from '../service'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-agent-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('startAgentServer：内核必启', () => {
  it('内核入口空 → KERNEL_NOT_CONFIGURED（fail fast，不 spawn）', async () => {
    await expect(
      startAgentServer({
        dataDir: dir,
        kernel: { electronExecutable: '', asarPath: '' }
      })
    ).rejects.toMatchObject({ code: 'KERNEL_NOT_CONFIGURED' })
  })

  it('内核路径不存在 → 统一 KernelStartupError（不裸抛 ENOENT）', async () => {
    await expect(
      startAgentServer({
        dataDir: dir,
        kernel: {
          electronExecutable: process.execPath,
          asarPath: 'Z:\\does\\not\\exist\\kernel'
        }
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/^KERNEL_/) })
  })
})
