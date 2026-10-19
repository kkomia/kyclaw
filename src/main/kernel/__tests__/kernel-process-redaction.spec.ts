// @vitest-environment node
/**
 * H1（Eve 验收 A1）：内核 stderr 进 Error.message 前必须脱敏。
 *
 * - 纯函数：token / dsh-auth cookie / Authorization / Cookie 都变成 `<redacted>`；
 * - 路径级：造一个"假内核"（node 脚本）打印含 token 的 stderr 后退出，断言
 *   `startKernelProcess` 抛出的错误里**有 `<redacted>`、没有原始 token**。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactKernelDiagnostics, startKernelProcess } from '../kernel-process'

const SECRET = 'SECRET_TOKEN_1234567890'
const COOKIE_SECRET = 'v1.COOKIE_SECRET_PAYLOAD'

describe('H1：内核诊断脱敏', () => {
  it('redactKernelDiagnostics 覆盖 token / dsh-auth cookie / Authorization / Cookie', () => {
    const raw = [
      `dsh web: http://127.0.0.1:4321/?token=${SECRET}`,
      `set-cookie: dsh-auth-abc123=${COOKIE_SECRET}; Path=/`,
      'Authorization: Bearer BEARER_SECRET_XYZ',
      `Cookie: dsh-auth-abc123=${COOKIE_SECRET}`
    ].join('\n')
    const redacted = redactKernelDiagnostics(raw)
    expect(redacted).toContain('<redacted>')
    expect(redacted).not.toContain(SECRET)
    expect(redacted).not.toContain(COOKIE_SECRET)
    expect(redacted).not.toContain('BEARER_SECRET_XYZ')
  })

  it('启动失败时 Error.message 已脱敏（路径级：假内核打印带 token 的 stderr 后退出）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-h1-'))
    const scriptDir = join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(scriptDir, { recursive: true })
    writeFileSync(
      join(scriptDir, 'bin.js'),
      [
        "process.stderr.write('kernel boot failed: see http://127.0.0.1:1/?token=" +
          SECRET +
          "\\n')",
        "process.stderr.write('set-cookie: dsh-auth-abc=" + COOKIE_SECRET + "; Path=/\\n')",
        'process.exit(1)'
      ].join('\n'),
      'utf8'
    )
    try {
      const failure = await startKernelProcess({
        electronExecutable: process.execPath,
        asarPath: dir,
        dshHome: join(dir, 'home'),
        readyTimeoutMs: 10_000
      }).then(
        () => null,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain('<redacted>')
      expect(message).not.toContain(SECRET)
      expect(message).not.toContain(COOKIE_SECRET)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 30_000)
})
