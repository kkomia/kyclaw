// @vitest-environment node
/**
 * 探针（round 73）：**停止键对 git / render_ppt / fetch 也真的停**。
 *
 * 上一轮（round 72）只把 `context.abortSignal` 接到了 bash；这三类调用照样跑到底。
 * 本探针逐类钉两件事：
 *   A) 信号在调用**之前**就响了 → 不留任何副作用（不拉起进程 / 不发请求 / 不写页图）；
 *   B) 调用**在途中**收到信号 → 子进程真的被收掉、请求真的取消，回执明说"已被用户中止"。
 *
 * 用的都是可控的真链路：git 走真仓库 + 一个会 sleep 的 pre-commit 钩子；
 * render_ppt 走真 runProcess（把"随包 LibreOffice 的 CLI"换成会 sleep 的假件，只换可执行文件、
 * 不换代码路径）；fetch 打本机桩服务。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from '@mastra/core/tools'
import { renderPptx } from '../ppt'
import { createFetchTool, type FetchInput } from '../fetch'
import { createGitTools, gitExecutable, type GitToolset } from '../git'
import { createRenderPptTool } from '../render-ppt'
import { createBed, type TestBed } from './helpers'

const realGit = gitExecutable()
const hasGit = realGit !== null

/** 工具 execute 的调用器：复刻 mastra 交给工具的那份 context（含 abortSignal） */
function runTool(tool: unknown, input: unknown, controller?: AbortController): Promise<string> {
  const callable = tool as { execute(input: unknown, context: unknown): Promise<unknown> }
  return callable
    .execute(input, { agent: { threadId: 'session-1' }, abortSignal: controller?.signal })
    .then((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .catch((error: unknown) => `THREW:${error instanceof Error ? error.message : String(error)}`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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

const dead: number[] = []
afterEach(() => {
  while (dead.length > 0) {
    const pid = dead.pop() as number
    if (!pidAlive(pid)) continue
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      // 已经死了
    }
  }
})

describe.runIf(hasGit)('停止键：git（round 73）', () => {
  let bed: TestBed
  let tools: GitToolset

  beforeEach(async () => {
    bed = createBed()
    tools = await createGitTools(bed.ctx, { resolveGit: () => realGit as string })
    git(bed.root, ['init'])
    git(bed.root, ['config', 'user.email', 'kyclaw-test@example.com'])
    git(bed.root, ['config', 'user.name', 'kyclaw test'])
  })

  afterEach(() => {
    bed.dispose()
  })

  function git(cwd: string, args: string[]): string {
    const result = spawnSync(realGit as string, ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
    return String(result.stdout)
  }

  /** 提交历史（空仓库还没有 HEAD，git log 会非零退出 —— 那就是"没有提交"，不是错误） */
  function logOf(cwd: string): string {
    const result = spawnSync(realGit as string, ['-C', cwd, 'log', '--oneline'], {
      encoding: 'utf8',
      windowsHide: true
    })
    return result.status === 0 ? String(result.stdout).trim() : ''
  }

  it('A) 启动前就中止：git_add 不落地（文件没被暂存）', async () => {
    writeFileSync(join(bed.root, 'a.txt'), 'hello\n')
    const controller = new AbortController()
    controller.abort()

    const out = await runTool(tools.git_add, { paths: ['.'] }, controller)
    const status = git(bed.root, ['status', '--porcelain'])

    process.stdout.write(`\n[git-A] 回执:\n${out}\n[git-A] status=${JSON.stringify(status)}\n`)
    expect(out).toContain('已被用户中止')
    // 仍然只是未跟踪（`??`）—— 没有被 git add 收进暂存区（`A  a.txt` 才是"落了地"）
    expect(status.trim().startsWith('A')).toBe(false)
  })

  it('B) 在途中止：commit 卡在钩子里时点停止 —— 命令树被收掉、提交没落地', async () => {
    writeFileSync(join(bed.root, 'b.txt'), 'hello\n')
    git(bed.root, ['add', 'b.txt'])

    // 真仓库 + 一个会 sleep 的 pre-commit 钩子：git 进程会一直等到它退出
    const marker = join(bed.tmp, 'hook-started.txt')
    writeFileSync(
      join(bed.root, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\ntouch "${marker.split('\\').join('/')}"\nsleep 30\nexit 0\n`
    )

    const controller = new AbortController()
    const started = Date.now()
    const call = runTool(tools.git_commit, { message: '不该落地' }, controller)

    expect(await waitUntil(() => existsSync(marker), 20_000)).toBe(true)
    controller.abort()

    const out = await Promise.race([call, delay(15_000).then(() => 'NOT-ABORTED')])
    const elapsed = Date.now() - started
    const log = logOf(bed.root)

    process.stdout.write(
      `\n[git-B] elapsed=${elapsed}ms\n[git-B] 回执:\n${out}\n[git-B] log=${JSON.stringify(log)}\n`
    )
    expect(out).not.toBe('NOT-ABORTED')
    expect(out).toContain('已被用户中止')
    expect(elapsed).toBeLessThan(15_000)
    // 中止发生在提交落地之前：历史里不该有任何提交
    expect(log).toBe('')
  }, 60_000)
})

describe('停止键：render_ppt（round 73）', () => {
  let bed: TestBed

  beforeEach(() => {
    bed = createBed({ mode: 'full' })
  })

  afterEach(() => {
    bed.dispose()
  })

  /** 一份真 pptx（用产出物自己的渲染器造，与 render-ppt.spec.ts 同一手法） */
  async function writeDeck(path: string): Promise<void> {
    const deck = await renderPptx({
      title: '自检',
      slides: [{ title: '一', bullets: ['内容'] }]
    })
    writeFileSync(path, deck.data)
  }

  it('A) 启动前就中止：渲染函数一次都没被调用，页图目录也不动', async () => {
    await writeDeck(join(bed.root, '自检.pptx'))

    let called = 0
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: async () => {
        called += 1
        return { ok: true, detail: '' }
      }
    })

    const controller = new AbortController()
    controller.abort()
    const out = await runTool(tool, { path: '自检.pptx' }, controller)

    process.stdout.write(`\n[ppt-A] 回执:\n${out}\n[ppt-A] render 被调用次数=${called}\n`)
    expect(called).toBe(0)
    expect(out).toContain('已被用户中止')
    expect(existsSync(join(bed.root, '自检_页图'))).toBe(false)
  }, 30_000)

  it('B) 在途中止：渲染子进程真的被收掉', async () => {
    await writeDeck(join(bed.root, '自检.pptx'))

    // "随包 LibreOffice 的 CLI" 的替身：写 pid 落盘、然后长眠（走的是真 runProcess 那条路）
    const pidFile = join(bed.tmp, 'kit-child.pid')
    const fakeCli = join(bed.tmp, 'fake-kit-cli.mjs')
    writeFileSync(
      fakeCli,
      "import { writeFileSync } from 'node:fs'\n" +
        `writeFileSync(${JSON.stringify(pidFile.split('\\').join('/'))}, String(process.pid))\n` +
        'setTimeout(() => {}, 60000)\n'
    )

    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'libreoffice',
      kitCli: fakeCli
    })

    const controller = new AbortController()
    const started = Date.now()
    const call = runTool(tool, { path: '自检.pptx' }, controller)

    expect(await waitUntil(() => existsSync(pidFile), 20_000)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    dead.push(childPid)
    controller.abort()

    const out = await Promise.race([call, delay(15_000).then(() => 'NOT-ABORTED')])
    const elapsed = Date.now() - started

    process.stdout.write(
      `\n[ppt-B] elapsed=${elapsed}ms\n[ppt-B] 回执:\n${out}\n[ppt-B] 子进程存活=${pidAlive(childPid)}\n`
    )
    expect(out).not.toBe('NOT-ABORTED')
    expect(out).toContain('已被用户中止')
    expect(elapsed).toBeLessThan(15_000)
    expect(await waitUntil(() => !pidAlive(childPid), 10_000)).toBe(true)
  }, 60_000)
})

describe('停止键：fetch（round 73）', () => {
  let bed: TestBed
  let server: Server
  let baseUrl = ''
  let hits = 0

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits += 1
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (path === '/slow') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('late')
        }, 30_000)
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('拿不到桩端口')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => {
    bed = createBed()
    hits = 0
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  afterEach(() => {
    bed.dispose()
  })

  /** 白名单注入缝：桩服务在本机，测试显式放行（就是用户白名单那条路） */
  const fetchTool = (): Promise<Tool<FetchInput, string>> =>
    createFetchTool(bed.ctx, {
      egress: { allowHosts: () => [`127.0.0.1:${new URL(baseUrl).port}`] }
    })

  it('A) 启动前就中止：请求一个字节都没发出去，回执说"已被用户中止"（不是失败）', async () => {
    const tool = await fetchTool()
    const controller = new AbortController()
    controller.abort()

    const out = await runTool(tool, { url: `${baseUrl}/text` }, controller)

    process.stdout.write(`\n[fetch-A] 回执:\n${out}\n[fetch-A] 服务端收到的请求数=${hits}\n`)
    expect(hits).toBe(0)
    expect(out).toContain('已被用户中止')
    expect(out.startsWith('THREW:')).toBe(false)
  }, 30_000)

  it('B) 在途中止：慢响应就地取消，回执说"已被用户中止"', async () => {
    const tool = await fetchTool()
    const controller = new AbortController()
    const started = Date.now()
    const call = runTool(tool, { url: `${baseUrl}/slow`, timeout_ms: 600_000 }, controller)

    await waitUntil(() => hits > 0, 10_000)
    controller.abort()

    const out = await Promise.race([call, delay(15_000).then(() => 'NOT-ABORTED')])
    const elapsed = Date.now() - started

    process.stdout.write(`\n[fetch-B] elapsed=${elapsed}ms\n[fetch-B] 回执:\n${out}\n`)
    expect(out).not.toBe('NOT-ABORTED')
    expect(out).toContain('已被用户中止')
    expect(out.startsWith('THREW:')).toBe(false)
    expect(elapsed).toBeLessThan(15_000)
  }, 60_000)
})
