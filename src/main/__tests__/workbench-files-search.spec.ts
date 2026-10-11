import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SEARCH_FILE_MAX_BYTES,
  SEARCH_MATCHES_PER_FILE,
  SEARCH_PREVIEW_CHARS,
  SEARCH_RESULT_LIMIT,
  searchWorkspace
} from '../workbench-files'

/**
 * 搜索：按文件名 / 按文件内容。全部在 mkdtemp 的真目录树上跑（中文名、嵌套、二进制、
 * 大文件、被跳过的重型目录都在 fixtures 里），containment 与超时各有一条。
 */
let root: string
let outside: string

/** 一个含 NUL 的二进制文件（内容里带 query，用来证明"二进制不参与内容搜索"） */
function binaryWith(needle: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    Buffer.from(needle)
  ])
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-search-'))
  outside = mkdtempSync(join(tmpdir(), 'kyclaw-search-outside-'))

  writeFileSync(join(root, 'README.md'), '# 标题\n第二条\n')
  writeFileSync(join(root, 'a.md'), 'aaa\n')
  writeFileSync(join(root, 'b.md'), 'bbb\n')
  writeFileSync(join(root, 'c.md'), 'ccc\n')
  writeFileSync(join(root, 'd.md'), 'ddd\n')

  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1\n// TODO 搜索我\n')
  writeFileSync(join(root, 'src', 'deep', '中文名.txt'), '这里有一段中文\n')

  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'needle-in-node-modules\n')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), 'needle-in-git\n')

  writeFileSync(join(root, 'logo.bin'), binaryWith('needle-in-binary'))
  writeFileSync(join(root, 'long.txt'), `${'x'.repeat(SEARCH_PREVIEW_CHARS + 100)} needle\n`)
  writeFileSync(
    join(root, 'many.txt'),
    `${Array.from({ length: 30 }, () => 'needle line').join('\n')}\n`
  )
  // 超过单文件扫描上限：命中落在 1MB 之后（扫不到），但这一轮要如实标 truncated
  writeFileSync(
    join(root, 'big.txt'),
    `${'a'.repeat(SEARCH_FILE_MAX_BYTES + 1024)}needle-at-tail\n`
  )

  writeFileSync(join(outside, 'secret.txt'), 'needle-outside\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('按文件名（mode=name）', () => {
  it('递归 + 相对路径（正斜杠）+ 中文名 + 大小写不敏感', () => {
    const lower = searchWorkspace(root, { query: 'readme', mode: 'name' })
    expect(lower.results).toEqual([{ path: 'README.md', name: 'README.md' }])
    expect(searchWorkspace(root, { query: 'README', mode: 'name' }).results).toHaveLength(1)

    const nested = searchWorkspace(root, { query: 'index', mode: 'name' })
    expect(nested.results).toEqual([{ path: 'src/index.ts', name: 'index.ts' }])

    const chinese = searchWorkspace(root, { query: '中文名', mode: 'name' })
    expect(chinese.results).toEqual([{ path: 'src/deep/中文名.txt', name: '中文名.txt' }])
  })

  it('跳过 node_modules 与 .git（重型目录：本轮不给开关）', () => {
    expect(searchWorkspace(root, { query: 'index.js', mode: 'name' }).results).toEqual([])
    expect(searchWorkspace(root, { query: 'config', mode: 'name' }).results).toEqual([])
    // 跳过目录里的文件也不算"扫过"
    expect(searchWorkspace(root, { query: '没这个名字', mode: 'name' }).scanned).toBe(
      searchWorkspace(root, { query: 'x', mode: 'name' }).scanned
    )
  })

  it('空结果如实回空（不编、不抛）', () => {
    expect(searchWorkspace(root, { query: 'zzz-没有这个', mode: 'name' })).toEqual({
      results: [],
      truncated: false,
      scanned: expect.any(Number)
    })
  })

  it('条数到上限就停，并如实标 truncated', () => {
    const many = join(root, 'many-names')
    mkdirSync(many)
    for (let index = 0; index < SEARCH_RESULT_LIMIT + 5; index += 1) {
      writeFileSync(join(many, `match${String(index).padStart(4, '0')}.txt`), 'x\n')
    }

    const result = searchWorkspace(root, { query: 'match', mode: 'name' })
    expect(result.results).toHaveLength(SEARCH_RESULT_LIMIT)
    expect(result.truncated).toBe(true)
  })
})

describe('按文件内容（mode=content）', () => {
  it('行号（1 起）+ 该行预览；大小写不敏感', () => {
    expect(searchWorkspace(root, { query: 'todo', mode: 'content' }).results).toEqual([
      { path: 'src/index.ts', name: 'index.ts', line: 2, preview: '// TODO 搜索我' }
    ])
    expect(searchWorkspace(root, { query: 'EXPORT', mode: 'content' }).results).toEqual([
      { path: 'src/index.ts', name: 'index.ts', line: 1, preview: 'export const value = 1' }
    ])
    // 中文也按同一个口径（UTF-8 解码后逐行比）
    expect(searchWorkspace(root, { query: '有一段中文', mode: 'content' }).results).toEqual([
      { path: 'src/deep/中文名.txt', name: '中文名.txt', line: 1, preview: '这里有一段中文' }
    ])
  })

  it('二进制（有 NUL）不参与内容搜索：不吐乱码也不假装扫过', () => {
    expect(searchWorkspace(root, { query: 'needle-in-binary', mode: 'content' }).results).toEqual(
      []
    )
  })

  it('跳过目录里的命中同样搜不到', () => {
    const queries = ['needle-in-node-modules', 'needle-in-git']
    for (const query of queries) {
      expect(searchWorkspace(root, { query, mode: 'content' }).results, query).toEqual([])
    }
  })

  it('行预览截到 SEARCH_PREVIEW_CHARS 个字符', () => {
    const hit = searchWorkspace(root, { query: 'needle', mode: 'content' }).results.find(
      (item) => item.name === 'long.txt'
    )
    expect(hit?.preview).toHaveLength(SEARCH_PREVIEW_CHARS + 1) // 截断处一个省略号
    expect(hit?.preview?.endsWith('…')).toBe(true)
  })

  it('单个文件最多记 20 条命中，超了标 truncated', () => {
    const result = searchWorkspace(root, { query: 'needle line', mode: 'content' })
    const hits = result.results.filter((item) => item.name === 'many.txt')
    expect(hits).toHaveLength(SEARCH_MATCHES_PER_FILE)
    expect(hits[0]?.line).toBe(1)
    expect(hits[SEARCH_MATCHES_PER_FILE - 1]?.line).toBe(SEARCH_MATCHES_PER_FILE)
    expect(result.truncated).toBe(true)
  })

  it('超过单文件扫描上限的文件只扫前 1MB：命中在窗内没有，并如实标 truncated', () => {
    const result = searchWorkspace(root, { query: 'needle-at-tail', mode: 'content' })
    expect(result.results).toEqual([])
    expect(result.truncated).toBe(true) // big.txt 只扫了前 1MB —— 结果可能不全
  })
})

describe('时间预算与 containment', () => {
  it('到时间预算就回已收结果 + truncated（计时器可注入）', () => {
    const full = searchWorkspace(root, { query: 'md', mode: 'name' })
    expect(full.results.length).toBeGreaterThanOrEqual(5)
    expect(full.truncated).toBe(false)

    // 假表：每问一次走 1 秒 → 3 秒预算在第 4 次询问后到点（结果只收到一部分）
    let ticks = 0
    const now = (): number => (ticks += 1000)
    const partial = searchWorkspace(root, { query: 'md', mode: 'name', now })

    expect(partial.truncated).toBe(true)
    expect(partial.results.length).toBeLessThan(full.results.length)
  })

  it('根不存在：给人话错误（root 由主进程按会话根解析，越权到不了这里）', () => {
    expect(() => searchWorkspace(join(root, '没有这个目录'), { query: 'a', mode: 'name' })).toThrow(
      /路径不可用/
    )
    expect(() => searchWorkspace(outside, { query: 'needle', mode: 'name' })).not.toThrow()
  })

  it('符号链接不进结果（避免穿出根）', () => {
    try {
      symlinkSync(outside, join(root, '带毒链接'), 'junction')
    } catch {
      return // 造不出链接的环境跳过
    }
    expect(searchWorkspace(root, { query: 'secret', mode: 'name' }).results).toEqual([])
    expect(searchWorkspace(root, { query: 'needle-outside', mode: 'content' }).results).toEqual([])
  })
})
