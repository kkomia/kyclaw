import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitExecutable } from '../git-bash'
import {
  classify,
  gitLog,
  gitOverview,
  gitShow,
  parseGraphLog,
  parseNumstat,
  parsePorcelain
} from '../workbench-git'

/**
 * Git 读侧：解析器（porcelain / --graph / --numstat）逐条钉死，再在**真仓库**上跑一遍，
 * 结果与命令行逐项对照（分支名、变更、提交数、单提交统计）。
 */
describe('parsePorcelain：status --porcelain=v1 -z', () => {
  it('普通条目：XY + 路径；staged 看第一列', () => {
    expect(parsePorcelain(' M src/a.ts\0?? 新文件.txt\0A  b.md\0')).toEqual([
      { path: 'src/a.ts', status: 'modified', staged: false },
      { path: '新文件.txt', status: 'untracked', staged: false },
      { path: 'b.md', status: 'added', staged: true }
    ])
  })

  it('重命名：保留新路径，跳过后面那条原路径', () => {
    expect(parsePorcelain('R  new.ts\0old.ts\0')).toEqual([
      { path: 'new.ts', status: 'renamed', staged: true }
    ])
  })

  it('冲突组合各一档；被删除用 deleted', () => {
    expect(parsePorcelain('UU a.txt\0DU b.txt\0DD c.txt\0D  d.txt\0')).toEqual([
      { path: 'a.txt', status: 'conflicted', staged: false },
      { path: 'b.txt', status: 'conflicted', staged: false },
      { path: 'c.txt', status: 'conflicted', staged: false },
      { path: 'd.txt', status: 'deleted', staged: true }
    ])
  })

  it('classify：两字母码到归类', () => {
    expect(classify('?', '?')).toBe('untracked')
    expect(classify(' ', 'M')).toBe('modified')
    expect(classify('M', ' ')).toBe('modified')
    expect(classify('C', ' ')).toBe('copied')
    expect(classify('T', ' ')).toBe('typechange')
    expect(classify('U', 'U')).toBe('conflicted')
  })
})

describe('parseGraphLog：--graph + 自定义 format', () => {
  it('取 \\x1e 之前当图形列、之后按 \\x1f 切字段；纯图形连接行不产出条目', () => {
    const F = '\x1f'
    const text = [
      `* \x1e${'a'.repeat(40)}${F}aaaaaaa${F}张三${F}2026-10-11T10:00:00+08:00${F}HEAD -> main${F}第一个提交`,
      '|\\',
      `| * \x1e${'b'.repeat(40)}${F}bbbbbbb${F}李四${F}2026-10-11T09:00:00+08:00${F}${F}别人的提交`
    ].join('\n')

    const commits = parseGraphLog(text)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual({
      sha: 'a'.repeat(40),
      short: 'aaaaaaa',
      graph: '* ',
      refs: 'HEAD -> main',
      subject: '第一个提交',
      author: '张三',
      date: '2026-10-11T10:00:00+08:00'
    })
    expect(commits[1]?.graph).toBe('| * ')
    expect(commits[1]?.refs).toBe('')
  })
})

describe('parseNumstat', () => {
  it('新增/删除两列；二进制是 `-`（给 null）', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n\n')).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'logo.png', additions: null, deletions: null }
    ])
  })
})

describe('注入的 runner：管道逻辑（不依赖真 git）', () => {
  const run = (
    answers: Record<string, string>
  ): ((args: readonly string[]) => Promise<{
    text: string
    exitCode: number | null
    failed: boolean
    spawnError: null
  }>) => {
    return async (args) => {
      const key = args.join(' ')
      for (const [prefix, text] of Object.entries(answers)) {
        if (key.startsWith(prefix)) {
          // 以 fatal 开头的假输出当作非零退出（gitShow 的失败路径用）
          const failed = text.startsWith('fatal')
          return { text, exitCode: failed ? 128 : 0, failed, spawnError: null }
        }
      }
      return { text: '', exitCode: 128, failed: true, spawnError: null }
    }
  }

  it('不是仓库：只问一次 is-inside-work-tree 就回 isRepo:false', async () => {
    const result = await gitOverview('/nowhere', {
      run: run({ 'rev-parse --is-inside-work-tree': 'false\n' })
    })
    expect(result).toEqual({ isRepo: false, empty: false, branch: null, changes: [] })
  })

  it('空仓库：HEAD 不存在 → empty:true，分支走 symbolic-ref 兜底', async () => {
    const result = await gitOverview('/nowhere', {
      run: run({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse --abbrev-ref': '',
        'symbolic-ref --short --quiet HEAD': 'main\n',
        'rev-parse --verify --quiet HEAD': '',
        'status --porcelain=v1': '?? a.txt\0'
      })
    })
    expect(result).toEqual({
      isRepo: true,
      empty: true,
      branch: 'main',
      changes: [{ path: 'a.txt', status: 'untracked', staged: false }]
    })
  })

  it('gitShow 失败给人话错误（含 git 自己的输出）', async () => {
    await expect(
      gitShow('/nowhere', 'badsha', {
        run: run({ 'show -s': 'fatal: bad revision\n' })
      })
    ).rejects.toThrow(/看不了这条提交：fatal: bad revision/)
  })
})

/* ── 真仓库（与命令行对照） ─────────────────────────────────────────────── */

const git = gitExecutable()
const hasGit = git !== null
const args = [
  '-c',
  'core.quotepath=false',
  '-c',
  'user.name=测试',
  '-c',
  'user.email=t@example.com'
]

function runGit(cwd: string, command: string[]): string {
  return execFileSync(git as string, [...args, '-C', cwd, ...command], { encoding: 'utf8' }).trim()
}

describe.runIf(hasGit)('真仓库：与命令行对照', () => {
  let repo: string
  let plain: string
  let empty: string
  let firstSha: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-git-'))
    plain = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-plain-'))
    empty = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-empty-'))

    runGit(repo, ['init'])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    runGit(repo, ['add', 'a.txt'])
    runGit(repo, ['commit', '-m', '第一个提交'])
    firstSha = runGit(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'b.txt'), 'bee\n')
    runGit(repo, ['add', 'a.txt', 'b.txt'])
    runGit(repo, ['commit', '-m', '第二个提交'])
    // 工作区留下：一个已修改（未暂存）+ 一个未跟踪
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(repo, 'c.txt'), 'see\n')

    runGit(empty, ['init'])
  })

  afterEach(() => {
    for (const dir of [repo, plain, empty]) rmSync(dir, { recursive: true, force: true })
  })

  it('总览：分支 / 未提交变更 与 `git status` 命令行一致', async () => {
    const overview = await gitOverview(repo)

    expect(overview.isRepo).toBe(true)
    expect(overview.empty).toBe(false)
    expect(overview.branch).toBe(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']))

    const cli = runGit(repo, ['status', '--porcelain=v1']).split('\n')
    expect(overview.changes.map((change) => `${change.status}:${change.path}`)).toEqual([
      'modified:a.txt',
      'untracked:c.txt'
    ])
    expect(cli).toHaveLength(2)
    expect(cli[0]?.endsWith('a.txt')).toBe(true)
  })

  it('历史：条数、顺序、短号、图形列与 `git log --graph` 一致', async () => {
    const commits = await gitLog(repo, 10)

    expect(commits).toHaveLength(2)
    expect(commits[0]?.subject).toBe('第二个提交')
    expect(commits[1]?.subject).toBe('第一个提交')
    expect(commits[1]?.sha).toBe(firstSha)
    expect(commits[1]?.short).toBe(firstSha.slice(0, 7))
    // 图形列的字符集只该是 * | \ / 与空格（monospace 原样画）
    expect(commits.every((commit) => /^[ *|\\/]*$/.test(commit.graph))).toBe(true)
    // refs 与命令行同源：HEAD 指向当前分支
    expect(commits[0]?.refs).toContain('HEAD')
    expect(runGit(repo, ['log', '--graph', '--oneline', '-n1'])).toContain('第二个提交')
  })

  it('单提交详情：完整 message + 变更文件统计与 `git show --numstat` 一致', async () => {
    const detail = await gitShow(repo, firstSha)

    expect(detail.sha).toBe(firstSha)
    expect(detail.message).toBe('第一个提交')
    expect(detail.author).toBe('测试')
    expect(detail.files).toEqual([{ path: 'a.txt', additions: 1, deletions: 0 }])

    const cliNumstat = runGit(repo, ['show', '--numstat', '--format=', '--first-parent', firstSha])
    expect(cliNumstat.split('\n')).toHaveLength(1)
    expect(cliNumstat).toContain('a.txt')
  })

  it('空仓库 / 非仓库：isRepo 与 empty 表达，不抛', async () => {
    const blank = await gitOverview(empty)
    expect(blank.isRepo).toBe(true)
    expect(blank.empty).toBe(true)
    expect(blank.branch).not.toBeNull()

    const outside = await gitOverview(plain)
    expect(outside).toEqual({ isRepo: false, empty: false, branch: null, changes: [] })
    expect(await gitLog(plain, 10)).toEqual([])
  })
})

describe('没有 git 可执行文件时的表现', () => {
  it('resolveGit 回 null → 抛中文错误（同一句给三处用）', async () => {
    mkdirSync(join(tmpdir(), 'kyclaw-workbench-nogit-'), { recursive: true })
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-nogit-'))
    try {
      await expect(gitOverview(dir, { resolveGit: () => null })).rejects.toThrow(/找不到 git/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
