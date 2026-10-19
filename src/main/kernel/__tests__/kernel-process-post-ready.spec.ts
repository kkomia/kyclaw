// @vitest-environment node
/**
 * P3（Eve 验收建议）：内核 ready **之后**的 child 'error' 不能把主进程带崩。
 *
 * 真实子进程的 post-ready 'error'（EPERM/EACCES 一类）在黑盒里不好稳定触发，所以这里用
 * 假 spawn（EventEmitter）钉两件事：ready 之后 `error` 事件被 log-only 监听接住、不会抛未捕获异常。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ child: null as unknown }))

vi.mock('node:child_process', () => ({
  spawn: () => hoisted.child
}))

import { startKernelProcess } from '../kernel-process'

const created: string[] = []

function tempKernelRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-post-ready-'))
  created.push(dir)
  const bin = join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(bin, '..'), { recursive: true })
  writeFileSync(bin, '// fake\n', 'utf8')
  return dir
}

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  signalCode: string | null
  stdout: EventEmitter & { destroy: () => void }
  stderr: EventEmitter & { destroy: () => void }
  kill: () => boolean
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.stdout = Object.assign(new EventEmitter(), { destroy: (): void => {} })
  child.stderr = Object.assign(new EventEmitter(), { destroy: (): void => {} })
  child.kill = (): boolean => {
    setImmediate(() => child.emit('exit', 0, null))
    return true
  }
  return child
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

describe('P3：ready 之后保留永久 error（log-only）监听', () => {
  it('ready 后的 child error 只记日志，不抛未捕获异常', async () => {
    const child = fakeChild()
    hoisted.child = child
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = startKernelProcess({
      electronExecutable: process.execPath,
      asarPath: tempKernelRoot(),
      dshHome: tempKernelRoot(),
      readyTimeoutMs: 5_000
    })
    // startKernelProcess 在第一个 await 之前已挂好 stdout/stderr/exit 监听：这里同步触发 ready
    child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:4321/?token=secret-token\n'))
    const handle = await pending
    expect(handle.baseUrl).toBe('http://127.0.0.1:4321')
    expect(handle.token).toBe('secret-token')
    // ready 后再来一个 error：没有永久监听的话 EventEmitter 会 throw（测试会红）
    expect(() => child.emit('error', new Error('EPERM after ready'))).not.toThrow()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('内核进程运行期错误'),
        expect.any(Error)
      )
    })
    await handle.stop()
    warn.mockRestore()
  })
})
