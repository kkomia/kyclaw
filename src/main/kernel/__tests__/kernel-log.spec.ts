// @vitest-environment node
/**
 * B4 / 验收④：内核启动日志（`<userData>/logs/kernel.log`）。
 * 钉格式（可检索）、追加、超限滚动 `.1`，以及"日志写失败不挡启动"的兜底口径。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KERNEL_LOG_MAX_BYTES, createKernelLog, formatKernelLogLine } from '../kernel-log'

const created: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-kernel-log-'))
  created.push(dir)
  return join(dir, 'logs', 'kernel.log')
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

describe('formatKernelLogLine：单行、ISO 时间、事件名 + JSON 详情', () => {
  it('格式可检索；换行被 JSON 转义（一条事件一行）', () => {
    const line = formatKernelLogLine(new Date('2026-10-19T11:20:00.000Z'), 'kernel.failed', {
      code: 'KERNEL_EXITED',
      reason: 'first line\nsecond line'
    })
    expect(line.startsWith('2026-10-19T11:20:00.000Z kernel.failed ')).toBe(true)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2)
    expect(line).toContain('"code":"KERNEL_EXITED"')
    expect(line).toContain('first line\\nsecond line')
  })
})

describe('createKernelLog：追加写 + 自动建目录 + 超限滚动', () => {
  it('目录不存在也能写；多条事件按顺序追加', () => {
    const file = tempFile()
    const log = createKernelLog(file)
    log.event('kernel.start', { root: 'C:\\app\\resources\\kernel' })
    log.event('kernel.ready', { port: 12345, sessionId: 's1', elapsedMs: 3456 })
    const text = readFileSync(file, 'utf8')
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('kernel.start')
    expect(lines[1]).toContain('kernel.ready')
    expect(lines[1]).toContain('"port":12345')
  })

  it('超过上限先滚成 .1，再继续追加（不无限长）', () => {
    const file = tempFile()
    const log = createKernelLog(file)
    log.event('kernel.start', { root: 'C:\\x' })
    // 把日志撑到上限以上（直接写大文件，避免真的写 4 MiB 日志）
    writeFileSync(file, 'x'.repeat(KERNEL_LOG_MAX_BYTES + 1), 'utf8')
    log.event('kernel.ready', { port: 1 })
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(statSync(`${file}.1`).size).toBe(KERNEL_LOG_MAX_BYTES + 1)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('kernel.ready')
    expect(text.length).toBeLessThan(1024)
  })
})
