// @vitest-environment node
/**
 * PB-017（Eve 在 PB-005 实测崩溃）：`KYCLAW_KERNEL_PORT=1` 但没注入 `options.kernel` 时，
 * `service.ts` 兜底成空串 `<empty>`，`spawn('')` 抛**同步 TypeError**（ERR_INVALID_ARG_VALUE），
 * 三套 spec 直接崩。
 *
 * 这里钉两条口径（红→绿证据）：
 *   1. **flag 开 + 未配置**：必须在 spawn 之前 fail fast，给「内核入口未配置」+ 配置来源的
 *      可诊断错误（`code=KERNEL_NOT_CONFIGURED`），而不是 TypeError；
 *   2. **内核进程层**同样兜底：即使有人绕过 bootstrap 直接调 `startKernelProcess`，
 *      空可执行文件/空内核根也不得抛 TypeError。
 *
 * flag 关的路径字节级不变由既有 `kernel-bootstrap.spec.ts` 钉住（这里不重复）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { maybeStartKernelAdapter } from '../kernel-bootstrap'
import { startKernelProcess } from '../kernel-process'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kyclaw-pb017-'))
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

describe('PB-017：flag 开但内核入口未配置 → 可诊断错误（不是 TypeError）', () => {
  it('未注入 options.kernel（两个路径都空）：fail fast，给 KERNEL_NOT_CONFIGURED', async () => {
    const dir = tempDir()
    try {
      const failure = await maybeStartKernelAdapter({
        electronExecutable: '',
        asarPath: '',
        appDataDir: dir,
        env: { KYCLAW_KERNEL_PORT: '1' }
      }).then(
        () => null,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(TypeError)
      expect((failure as Error).message).toContain('内核入口未配置')
      expect((failure as Error).message).toContain('KYCLAW_KERNEL_PORT=1')
      // 期望配置来源要说清（谁注入、内核快照在哪）
      expect((failure as Error).message).toContain('kernel')
      expect(codeOf(failure)).toBe('KERNEL_NOT_CONFIGURED')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })

  it('只空了内核根（electronExecutable 有值）：同样 KERNEL_NOT_CONFIGURED，且指出缺的是内核路径', async () => {
    const dir = tempDir()
    try {
      const failure = await maybeStartKernelAdapter({
        electronExecutable: process.execPath,
        asarPath: '',
        appDataDir: dir,
        env: { KYCLAW_KERNEL_PORT: '1' }
      }).then(
        () => null,
        (error: unknown) => error
      )
      expect(failure).not.toBeInstanceOf(TypeError)
      expect((failure as Error).message).toContain('内核入口未配置')
      expect((failure as Error).message).toContain('内核目录')
      expect(codeOf(failure)).toBe('KERNEL_NOT_CONFIGURED')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })

  it('内核进程层兜底：空可执行文件不得抛 TypeError', async () => {
    const dir = tempDir()
    try {
      const failure = await startKernelProcess({
        electronExecutable: '',
        asarPath: '',
        dshHome: join(dir, 'home'),
        readyTimeoutMs: 1_000
      }).then(
        () => null,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(TypeError)
      expect((failure as Error).message).toContain('内核入口未配置')
      expect(codeOf(failure)).toBe('KERNEL_NOT_CONFIGURED')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
})
