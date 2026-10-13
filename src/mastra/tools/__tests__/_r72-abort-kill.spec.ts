// @vitest-environment node
/**
 * 探针（round 72）：停止键真的把在跑的命令停掉。
 *
 * 两条判据都必须落在**真进程**上，不看中间态：
 *   A) 中止信号打过来后，命令树里的子孙进程真的消失（tasklist / pidAlive 双证）；
 *   B) 应用退出时统一清账 killAllRunning() 能把在途子进程收掉，且只收自己起的。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitBashPath } from '../bash'
import { createBashTool } from '../bash'
import { killAllRunning, runningProcessCount } from '../exec'
import { createBed, type TestBed } from './helpers'

const realBash = gitBashPath()
const hasBash = realBash !== null

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** tasklist 原始输出里是否还能查到该 pid（Windows 上的第二份证据） */
function tasklistRow(pid: number): string {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true
    }).trim()
  } catch (error) {
    return `<tasklist 失败：${String(error)}>`
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await delay(100)
  }
  return check()
}

/**
 * 工具 execute 的调用器（与 helpers.callTool 同口径，多带一个 abortSignal）：
 * 类型按 Tool 的宽松面断言 —— 真实 agent 循环给的 context 就是 mastra 那一份
 * （`{ agent: { threadId }, abortSignal }`），这里复刻的就是它。
 */
function runTool(tool: unknown, input: unknown, controller?: AbortController): Promise<string> {
  const callable = tool as {
    execute(input: unknown, context: unknown): Promise<unknown>
  }
  return callable
    .execute(input, { agent: { threadId: 'session-1' }, abortSignal: controller?.signal })
    .then((value) => String(value))
    .catch((error: unknown) => `THREW:${String(error)}`)
}

const dead: number[] = []
async function reap(): Promise<void> {
  while (dead.length > 0) {
    const pid = dead.pop() as number
    if (pidAlive(pid)) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        // 已经死了
      }
    }
  }
}

describe.runIf(hasBash)('探针：停止键真的停（round 72）', () => {
  let bed: TestBed

  beforeEach(() => {
    bed = createBed()
  })

  afterEach(async () => {
    await reap()
    bed.dispose()
  })

  it('A) sleep 30 在跑时 abort：命令被中止，子进程真的死掉（不掉进超时）', async () => {
    const tool = await createBashTool(bed.ctx)
    const childScript = join(bed.tmp, 'abort-child.mjs')
    const pidFile = join(bed.tmp, 'abort-child.pid')
    writeFileSync(
      childScript,
      "import { writeFileSync } from 'node:fs'\n" +
        'writeFileSync(process.argv[2], String(process.pid))\n' +
        'setTimeout(() => {}, 30000)\n'
    )

    const controller = new AbortController()
    const started = Date.now()
    const call = runTool(
      tool,
      {
        command: `"${process.execPath}" "${childScript}" "${pidFile}" & wait`,
        timeout_ms: 600_000
      },
      controller
    )

    // 等命令真的跑起来（子进程 pid 落盘）再按停止 —— 这才是用户点停止的那一刻
    const up = await waitUntil(() => existsSync(pidFile), 15_000)
    expect(up).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    dead.push(childPid)
    expect(Number.isInteger(childPid)).toBe(true)
    const before = tasklistRow(childPid)

    controller.abort()

    // 旧代码下这里读不到任何东西（signal 没人接），15s 后返回哨兵值 —— 就是"红"
    const out = await Promise.race([call, delay(15_000).then(() => 'NOT-ABORTED')])
    const elapsed = Date.now() - started

    process.stdout.write(`\n[A] tasklist(中止前)= ${before}\n`)
    process.stdout.write(`[A] elapsed=${elapsed}ms\n[A] 回执:\n${out}\n`)
    process.stdout.write(`[A] tasklist(中止后)= ${tasklistRow(childPid)}\n`)

    expect(out).not.toBe('NOT-ABORTED')
    expect(out).toContain('已被用户中止')
    expect(elapsed).toBeLessThan(15_000)
    expect(await waitUntil(() => !pidAlive(childPid), 10_000)).toBe(true)
    expect(tasklistRow(childPid)).not.toContain(String(childPid))
  }, 60_000)

  it('B1) 退出清账：killAllRunning 把在途命令树收掉（整棵，不只树根）', async () => {
    const tool = await createBashTool(bed.ctx)
    const childScript = join(bed.tmp, 'ledger-child.mjs')
    const pidFile = join(bed.tmp, 'ledger-child.pid')
    writeFileSync(
      childScript,
      "import { writeFileSync } from 'node:fs'\n" +
        'writeFileSync(process.argv[2], String(process.pid))\n' +
        'setTimeout(() => {}, 60000)\n'
    )

    const before = runningProcessCount()
    const call = runTool(tool, {
      command: `"${process.execPath}" "${childScript}" "${pidFile}" & wait`,
      timeout_ms: 600_000
    })

    expect(await waitUntil(() => existsSync(pidFile), 15_000)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    dead.push(childPid)
    expect(runningProcessCount()).toBeGreaterThan(before)
    const alive = tasklistRow(childPid)

    // 应用退出路径调的就是这一句
    const killed = killAllRunning()

    const out = await Promise.race([call, delay(20_000).then(() => 'STILL-WAITING')])
    process.stdout.write(`\n[B1] tasklist(清账前)= ${alive}\n`)
    process.stdout.write(`[B1] killAllRunning() = ${killed}\n`)
    process.stdout.write(`[B1] tasklist(清账后)= ${tasklistRow(childPid)}\n`)
    process.stdout.write(`[B1] 调用结果：${out}\n`)

    expect(killed).toBeGreaterThanOrEqual(1)
    expect(out).not.toBe('STILL-WAITING')
    expect(await waitUntil(() => !pidAlive(childPid), 10_000)).toBe(true)
    expect(tasklistRow(childPid)).not.toContain(String(childPid))
    expect(await waitUntil(() => runningProcessCount() === before, 5_000)).toBe(true)
  }, 60_000)

  it('B2) 只清自己起的：账本之外的进程一根毫毛都不动', async () => {
    const tool = await createBashTool(bed.ctx)
    const sleeper = join(bed.tmp, 'sleeper.mjs')
    writeFileSync(
      sleeper,
      "import { writeFileSync } from 'node:fs'\n" +
        'writeFileSync(process.argv[2], String(process.pid))\n' +
        'setTimeout(() => {}, 30000)\n'
    )

    // "用户自己的进程"：不由 runProcess 拉起，所以不在账本里
    const foreign = join(bed.tmp, 'foreign.pid')
    const { spawn } = await import('node:child_process')
    const foreignProc = spawn(process.execPath, [sleeper, foreign], {
      stdio: 'ignore',
      windowsHide: true
    })
    expect(await waitUntil(() => existsSync(foreign), 15_000)).toBe(true)
    const foreignPid = Number(readFileSync(foreign, 'utf8').trim())
    dead.push(foreignPid)

    // 同时在途一条自己的命令
    const ownPidFile = join(bed.tmp, 'own.pid')
    const call = runTool(tool, {
      command: `"${process.execPath}" "${sleeper}" "${ownPidFile}" & wait`,
      timeout_ms: 600_000
    })
    expect(await waitUntil(() => existsSync(ownPidFile), 15_000)).toBe(true)
    const ownPid = Number(readFileSync(ownPidFile, 'utf8').trim())
    dead.push(ownPid)

    const killed = killAllRunning()
    await Promise.race([call, delay(20_000)])
    await delay(500)

    process.stdout.write(`\n[B2] killAllRunning() = ${killed}\n`)
    process.stdout.write(`[B2] 自己的 pid ${ownPid} 存活 = ${pidAlive(ownPid)}\n`)
    process.stdout.write(`[B2] 账本外的 pid ${foreignPid} 存活 = ${pidAlive(foreignPid)}\n`)

    expect(killed).toBeGreaterThanOrEqual(1)
    expect(await waitUntil(() => !pidAlive(ownPid), 10_000)).toBe(true)
    expect(pidAlive(foreignPid)).toBe(true)
    foreignProc.kill()
  }, 60_000)

  // 信号在命令起来之前就响了：不该留下任何副作用（"停止"最不该有的结果就是命令照样跑了）
  it('C) 中止发生在启动前：不拉起进程，命令的副作用一点都不落地', async () => {
    const tool = await createBashTool(bed.ctx)
    const marker = join(bed.tmp, 'should-not-exist.txt')
    const controller = new AbortController()
    controller.abort()

    const out = await runTool(
      tool,
      { command: `echo boom > "${marker.split('\\').join('/')}"`, timeout_ms: 600_000 },
      controller
    )

    process.stdout.write(`\n[C] 回执:\n${out}\n[C] marker 存在 = ${existsSync(marker)}\n`)

    expect(out).toContain('已被用户中止')
    expect(existsSync(marker)).toBe(false)
    expect(runningProcessCount()).toBe(0)
  }, 30_000)
})
