// @vitest-environment node
/**
 * bash 工具（round28 模块 1）：Git Bash 探测链（注入假件）、真进程执行（退出码 / 合并顺序 /
 * UTF-8 / cwd / 超时杀进程树 / 输出截断）、审批 gate。
 *
 * 探测链与握手解析用假件测（不依赖本机装了什么）；真进程用例在探测不到 Git Bash 时整组跳过
 * —— Windows 上"装了 Git 才有这个能力"是产品口径，不是测试要掩盖的失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBashTool,
  findGitBash,
  findGitOnPath,
  GIT_BASH_MISSING,
  gitBashPath,
  parseHandshake,
  resetGitBashCache,
  stripHandshake
} from '../bash'
import { callTool, createBed, type TestBed } from './helpers'

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

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

describe('findGitBash：探测链（注入假件，不碰真实系统）', () => {
  it('KYCLAW_GIT_BASH 显式指定优先', () => {
    const explicit = join('D:', 'custom', 'bash.exe')
    const found = findGitBash({
      platform: 'win32',
      env: { KYCLAW_GIT_BASH: explicit, ProgramFiles: 'C:\\PF' },
      exists: (path) => path === explicit,
      findGit: () => null
    })
    expect(found).toBe(explicit)
  })

  it('Windows 常见安装位：Program Files → Program Files (x86) → LOCALAPPDATA\\Programs', () => {
    const x86 = join('C:\\PFX', 'Git', 'bin', 'bash.exe')
    const local = join('C:\\Local', 'Programs', 'Git', 'bin', 'bash.exe')
    expect(
      findGitBash({
        platform: 'win32',
        env: { 'ProgramFiles(x86)': 'C:\\PFX', LOCALAPPDATA: 'C:\\Local' },
        exists: (path) => path === x86 || path === local,
        findGit: () => null
      })
    ).toBe(x86)
    expect(
      findGitBash({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Local' },
        exists: (path) => path === local,
        findGit: () => null
      })
    ).toBe(local)
  })

  it('PATH 上 git 推导：mingw64\\bin 布局 → 上两级 bin\\bash.exe（本机 D:\\Git 走这条）', () => {
    const git = join('D:\\Git', 'mingw64', 'bin', 'git.exe')
    const expected = join('D:\\Git', 'bin', 'bash.exe')
    expect(
      findGitBash({
        platform: 'win32',
        env: {},
        exists: (path) => path === expected,
        findGit: () => git
      })
    ).toBe(expected)
  })

  it('PATH 上 git 推导：cmd 布局 → 上一级 bin\\bash.exe', () => {
    const git = join('C:\\Git', 'cmd', 'git.exe')
    const expected = join('C:\\Git', 'bin', 'bash.exe')
    expect(
      findGitBash({
        platform: 'win32',
        env: {},
        exists: (path) => path === expected,
        findGit: () => git
      })
    ).toBe(expected)
  })

  it('非 Windows：用 /bin/bash', () => {
    expect(
      findGitBash({
        platform: 'linux',
        env: {},
        exists: (path) => path === '/bin/bash',
        findGit: () => null
      })
    ).toBe('/bin/bash')
  })

  it('一个都找不到 → null（不回落 cmd / PowerShell）', () => {
    expect(
      findGitBash({ platform: 'win32', env: {}, exists: () => false, findGit: () => null })
    ).toBeNull()
  })

  it('探测成功会缓存（缓存命中后不再重探）', () => {
    resetGitBashCache()
    try {
      const first = gitBashPath()
      if (first === null) return // 本机没装 Git：这条无从验证，跳过
      const probing = gitBashPath({
        exists: () => {
          throw new Error('缓存命中时不该再探测')
        }
      })
      expect(probing).toBe(first)
    } finally {
      resetGitBashCache()
    }
  })
})

describe('findGitOnPath：PATH 扫描', () => {
  it('Windows 按 `;` 分隔（盘符里的冒号不会被切开）', () => {
    const expected = join('D:\\Git\\cmd', 'git.exe')
    expect(findGitOnPath('C:\\A;D:\\Git\\cmd;C:\\B', 'win32', (path) => path === expected)).toBe(
      expected
    )
  })

  it('非 Windows 按 `:` 分隔；带引号的目录也能剥出来', () => {
    const expected = join('/usr/bin', 'git')
    expect(findGitOnPath('"/opt/tools":/usr/bin', 'linux', (path) => path === expected)).toBe(
      expected
    )
  })
})

describe('握手行解析', () => {
  const marker = 'kyclaw-pid-abc123:'

  it('parseHandshake：认标记 + 数字 pid/pgid；pgid 缺了也能认', () => {
    expect(parseHandshake(`${marker}7616:7616`, marker)).toEqual({ pid: '7616', pgid: '7616' })
    expect(parseHandshake(`${marker}42:`, marker)).toEqual({ pid: '42', pgid: '' })
    expect(parseHandshake(`别的输出`, marker)).toBeNull()
    expect(parseHandshake(`${marker}abc:1`, marker)).toBeNull()
  })

  it('stripHandshake：去掉第一行（标记不匹配时原样返回）', () => {
    expect(stripHandshake(`${marker}1:1\nhello\n`, marker)).toBe('hello\n')
    expect(stripHandshake(`${marker}1:1`, marker)).toBe('')
    expect(stripHandshake('hello\n', marker)).toBe('hello\n')
  })
})

describe.runIf(hasBash)('bash：真进程执行', () => {
  let bed: TestBed

  beforeEach(() => {
    bed = createBed()
  })

  afterEach(() => {
    bed.dispose()
  })

  it('基本执行：回显命令与 cwd，输出 + 退出码 0；默认 cwd = 工作区', async () => {
    const tool = await createBashTool(bed.ctx)
    const out = String(await callTool(tool, { command: 'echo hello-kyclaw' }))

    expect(out).toContain('$ echo hello-kyclaw')
    expect(out).toContain(`[cwd: ${bed.root}]`)
    expect(out).toContain('hello-kyclaw')
    expect(out).toContain('[退出码 0]')
  })

  it('退出码透传（非零不是工具错误，模型看得到）', async () => {
    const tool = await createBashTool(bed.ctx)
    const out = String(await callTool(tool, { command: 'exit 7' }))
    expect(out).toContain('[退出码 7]')
  })

  it('stdout / stderr 合并且保持真实交错顺序', async () => {
    const tool = await createBashTool(bed.ctx)
    const out = String(await callTool(tool, { command: 'echo AAA; echo BBB >&2; echo CCC' }))
    // 只看正文段（回显的命令行里也有这三个词，按 first-index 判会被回显带偏）
    const body = out.split(`[cwd: ${bed.root}]\n\n`)[1]?.split('\n\n[退出码')[0] ?? ''
    expect(body.split('\n').filter((line) => line !== '')).toEqual(['AAA', 'BBB', 'CCC'])
  })

  it('UTF-8 中文 / emoji 原样回传（无 U+FFFD）', async () => {
    const tool = await createBashTool(bed.ctx)
    const out = String(await callTool(tool, { command: "printf '中文😀 %s\\n' done" }))
    expect(out).toContain('中文😀 done')
    expect(out).not.toContain('\uFFFD')
  })

  it('空输出明确标注（不是空白的假象）', async () => {
    const tool = await createBashTool(bed.ctx)
    const out = String(await callTool(tool, { command: 'true' }))
    expect(out).toContain('（无输出）')
  })

  it('cwd 相对工作区：在子目录里跑；绝对路径可指向工作区之外', async () => {
    const tool = await createBashTool(bed.ctx)
    mkdirSync(join(bed.root, 'sub'))

    const inner = String(await callTool(tool, { command: 'pwd', cwd: 'sub' }))
    expect(inner).toContain(`[cwd: ${join(bed.root, 'sub')}]`)

    const outside = String(await callTool(tool, { command: 'pwd', cwd: bed.outside }))
    expect(outside).toContain(`[cwd: ${bed.outside}]`)
    expect(outside).toContain('[退出码 0]')
  })

  it('cwd 不存在：中文错误（不是 spawn 的英文报错）', async () => {
    const tool = await createBashTool(bed.ctx)
    await expect(callTool(tool, { command: 'pwd', cwd: '没这个目录' })).rejects.toThrow(
      /cwd 不存在或不是目录/
    )
  })

  it('多个工作区且没给 cwd：要求显式指定（与 scanRoot 同口径）', async () => {
    const tool = await createBashTool(bed.ctx)
    const second = createBed()
    bed.roots.push({ path: second.root, mode: 'ask' })
    try {
      await expect(callTool(tool, { command: 'pwd' })).rejects.toThrow(/多个授权工作区/)
    } finally {
      second.dispose()
    }
  })

  it('超过 64KB：首尾保留 + 截断说明（中间行不在）', async () => {
    const tool = await createBashTool(bed.ctx)
    const out = String(
      await callTool(tool, {
        command: 'awk \'BEGIN { for (i = 1; i <= 20000; i++) print "line-" i }\''
      })
    )
    expect(out).toContain('line-1\n')
    expect(out).toContain('line-20000')
    expect(out).not.toContain('line-10000')
    expect(out).toMatch(/\[输出已截断：共 \d+ 字节，仅保留前 32768 字节与后 32768 字节\]/)
  })

  it('超时：终止整个进程树（fork 出的孙进程也不留）', async () => {
    const tool = await createBashTool(bed.ctx)
    const childScript = join(bed.tmp, 'child.mjs')
    const pidFile = join(bed.tmp, 'child.pid')
    writeFileSync(
      childScript,
      "import { writeFileSync } from 'node:fs'\n" +
        'writeFileSync(process.argv[2], String(process.pid))\n' +
        'setTimeout(() => {}, 60000)\n'
    )

    const command = `"${process.execPath}" "${childScript}" "${pidFile}" & wait`
    const started = Date.now()
    const out = String(await callTool(tool, { command, timeout_ms: 1500 }))
    const elapsed = Date.now() - started

    expect(out).toContain('[已超时：超过 1.5 秒，已终止进程]')
    expect(elapsed).toBeLessThan(20_000)
    expect(await waitUntil(() => existsSync(pidFile), 8000)).toBe(true)

    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(Number.isInteger(childPid)).toBe(true)
    // 关键判据：超时返回后，fork 出去的孙进程在宽限期内真的死掉（不是只杀了 shell）
    expect(await waitUntil(() => !pidAlive(childPid), 8000)).toBe(true)
  }, 40_000)

  it('审批 gate：默认问；命中"永久允许"规则放行；full 不豁免', async () => {
    const tool = await createBashTool(bed.ctx)
    const gate = tool.requireApproval as unknown as (input: { command: string }) => boolean

    expect(gate({ command: 'echo hi' })).toBe(true)
    bed.roots[0].mode = 'full'
    expect(gate({ command: 'echo hi' })).toBe(true)
    bed.roots[0].mode = 'ask'
    bed.rules.push({ tool: 'bash', workspace: bed.root, mode: 'allow' })
    expect(gate({ command: 'echo hi' })).toBe(false)
  })
})

describe('bash：找不到 Git Bash', () => {
  let bed: TestBed

  beforeEach(() => {
    bed = createBed()
  })

  afterEach(() => {
    bed.dispose()
  })

  it('不静默回落：给中文错误（提示装 Git）', async () => {
    const tool = await createBashTool(bed.ctx, { resolveBash: () => null })
    await expect(callTool(tool, { command: 'echo hi' })).rejects.toThrow(GIT_BASH_MISSING)
    await expect(callTool(tool, { command: 'echo hi' })).rejects.toThrow(/Git Bash/)
  })
})
