// @vitest-environment node
/**
 * git 工具（round28 模块 1）：真在临时目录里 init 一个仓库，跑 status / diff / log / add / commit；
 * 边界（非仓库目录、越界路径、仓库目录缺省与多工作区）与审批 gate（读档放行 / 写档默认问 /
 * full 与规则生效）。
 *
 * 本机没装 git 时整组跳过（产品上 bash/git 能力本来就以 Git for Windows 为前提）；
 * git 可执行文件的探测链用注入假件单独测（不依赖本机）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGitTools,
  findGit,
  GIT_MISSING,
  gitExecutable,
  resetGitExecutableCache,
  type GitToolset
} from '../git'
import { callTool, createBed, type TestBed } from './helpers'

const realGit = gitExecutable()
const hasGit = realGit !== null

/** 建一个临时 git 仓库（identity 配在 repo 本地，不碰用户全局配置） */
function initRepo(path: string): void {
  run(path, ['init'])
  run(path, ['config', 'user.email', 'kyclaw-test@example.com'])
  run(path, ['config', 'user.name', 'kyclaw test'])
}

function run(cwd: string, args: string[]): void {
  const result = spawnSync(realGit as string, ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（${result.status}）：${result.stderr}`)
  }
}

describe('findGit：探测链（注入假件）', () => {
  it('PATH 上找到 git 就用它', () => {
    const expected = join('C:\\Tools', 'git.exe')
    expect(
      findGit({
        platform: 'win32',
        env: { PATH: 'C:\\A;C:\\Tools' },
        exists: (path) => path === expected
      })
    ).toBe(expected)
  })

  it('PATH 上没有：由 Git Bash 安装位推导（<root>\\bin\\bash.exe → <root>\\cmd\\git.exe）', () => {
    const bash = join('D:\\Qt\\Git', 'bin', 'bash.exe')
    const expected = join('D:\\Qt\\Git', 'cmd', 'git.exe')
    expect(
      findGit({
        platform: 'win32',
        env: { KYCLAW_GIT_BASH: bash },
        exists: (path) => path === expected || path === bash
      })
    ).toBe(expected)
  })

  it('都没有 → null（不硬编码路径）', () => {
    expect(findGit({ platform: 'win32', env: {}, exists: () => false })).toBeNull()
  })

  it('探测成功会缓存（reset 后正常重探）', () => {
    resetGitExecutableCache()
    const first = gitExecutable()
    if (first !== null) expect(gitExecutable()).toBe(first)
    resetGitExecutableCache()
  })
})

describe.runIf(hasGit)('git：真仓库用例', () => {
  let bed: TestBed
  let tools: GitToolset

  beforeEach(async () => {
    bed = createBed()
    initRepo(bed.root)
    tools = await createGitTools(bed.ctx)
  })

  afterEach(() => {
    bed.dispose()
  })

  it('git_status：分支行 + 变更清单（含未跟踪文件）', async () => {
    writeFileSync(join(bed.root, 'a.txt'), 'x')
    const out = String(await callTool(tools.git_status, {}))

    expect(out).toContain('##')
    expect(out).toContain('a.txt')
    expect(out).toContain('[退出码 0]')
  })

  it('git_add → git_commit → git_log 走通一遍，回执都在', async () => {
    writeFileSync(join(bed.root, 'a.txt'), 'hello')

    const added = String(await callTool(tools.git_add, { paths: ['.'] }))
    expect(added).toContain('已暂存：.')
    expect(String(await callTool(tools.git_status, {}))).toContain('A  a.txt')

    const committed = String(await callTool(tools.git_commit, { message: '首次提交 · 中文' }))
    expect(committed).toContain('首次提交 · 中文')

    const log = String(await callTool(tools.git_log, {}))
    expect(log).toContain('首次提交 · 中文')
    expect(log).toContain('[退出码 0]')
  })

  it('git_diff：缺省看未暂存；staged=true 看已暂存；file 只筛一个路径', async () => {
    writeFileSync(join(bed.root, 'a.txt'), 'old-line\n')
    run(bed.root, ['add', '.'])
    run(bed.root, ['commit', '-m', 'base'])

    writeFileSync(join(bed.root, 'a.txt'), 'new-line\n')
    const unstaged = String(await callTool(tools.git_diff, {}))
    expect(unstaged).toContain('-old-line')
    expect(unstaged).toContain('+new-line')

    run(bed.root, ['add', '.'])
    const staged = String(await callTool(tools.git_diff, { staged: true }))
    expect(staged).toContain('+new-line')

    writeFileSync(join(bed.root, 'b.txt'), 'other\n')
    const filtered = String(await callTool(tools.git_diff, { file: 'a.txt' }))
    expect(filtered).not.toContain('b.txt')
  })

  it('git_log 的 limit 生效', async () => {
    writeFileSync(join(bed.root, 'a.txt'), '1')
    run(bed.root, ['add', '.'])
    run(bed.root, ['commit', '-m', '第一条'])
    writeFileSync(join(bed.root, 'a.txt'), '2')
    run(bed.root, ['add', '.'])
    run(bed.root, ['commit', '-m', '第二条'])

    const one = String(await callTool(tools.git_log, { limit: 1 }))
    expect(one).toContain('第二条')
    expect(one).not.toContain('第一条')
  })

  it('非仓库目录：git 的输出 + 退出码原样带回（不抛错）', async () => {
    // 工作区内的另一个目录（不是仓库、也不在仓库里）：把它并进授权列表再查
    const plain = createBed()
    bed.roots.push({ path: plain.root, mode: 'ask' })
    try {
      const out = String(await callTool(tools.git_status, { path: plain.root }))
      expect(out).toContain('not a git repository')
      expect(out).toContain('[退出码 128]')
    } finally {
      bed.roots.pop()
      plain.dispose()
    }
  })

  it('git_add 的路径越界：拒绝（fail closed），仓库没动静', async () => {
    await expect(callTool(tools.git_add, { paths: [join(bed.outside, 'x.txt')] })).rejects.toThrow(
      /路径不在仓库内/
    )
  })

  it('git_commit 的 message 为空：schema 拦下（返回校验错误，不执行 git）', async () => {
    const result = (await callTool(tools.git_commit, { message: '' })) as { error?: unknown }
    expect(result.error).toBe(true)
  })

  it('多个工作区且没给 path：要求显式指定', async () => {
    const second = createBed()
    bed.roots.push({ path: second.root, mode: 'ask' })
    try {
      await expect(callTool(tools.git_status, {})).rejects.toThrow(/多个授权工作区/)
    } finally {
      second.dispose()
    }
  })

  it('审批 gate：read 档放行；写档默认问、full 放行、规则放行', async () => {
    const statusGate = tools.git_status.requireApproval as unknown as (input: unknown) => boolean
    expect(statusGate({})).toBe(false)

    const addGate = tools.git_add.requireApproval as unknown as (input: {
      paths: string[]
    }) => boolean
    const commitGate = tools.git_commit.requireApproval as unknown as (input: {
      message: string
    }) => boolean

    expect(addGate({ paths: ['.'] })).toBe(true)
    expect(commitGate({ message: 'x' })).toBe(true)

    bed.roots[0].mode = 'full'
    expect(addGate({ paths: ['.'] })).toBe(false)
    bed.roots[0].mode = 'ask'

    bed.rules.push({ tool: 'git_commit', workspace: bed.root, mode: 'allow' })
    expect(commitGate({ message: 'x' })).toBe(false)
  })

  it('git 可执行文件找不到：中文错误（测试注入空解析器）', async () => {
    const missing = await createGitTools(bed.ctx, { resolveGit: () => null })
    await expect(callTool(missing.git_status, {})).rejects.toThrow(GIT_MISSING)
  })

  it('git_commit 之后：工作区文件内容原样、git_log 里能看到提交', async () => {
    writeFileSync(join(bed.root, 'note.md'), '# 笔记\n')
    await callTool(tools.git_add, { paths: ['note.md'] })
    await callTool(tools.git_commit, { message: '笔记' })

    expect(readFileSync(join(bed.root, 'note.md'), 'utf8')).toBe('# 笔记\n')
    expect(String(await callTool(tools.git_log, {}))).toContain('笔记')
  })
})
