import { describe, expect, it } from 'vitest'
import {
  detectTrigger,
  fileRows,
  filterFiles,
  flattenGroups,
  nameOfPath,
  slashGroups
} from '@renderer/features/chat/suggestion-model'

/**
 * 建议浮窗的纯逻辑（round 15）：`@` 文件 / `/` 插件·技能的触发、过滤与选中行。
 * 触发按词边界（邮箱 / 路径里的符号不触发）。
 */
describe('detectTrigger · 词边界触发', () => {
  it('@ 在词首（行首 / 空白后）：给出替换区间与过滤词', () => {
    expect(detectTrigger('@ab', 3)).toEqual({ kind: 'file', start: 0, query: 'ab' })
    expect(detectTrigger('看这个 @sr', 7)).toEqual({ kind: 'file', start: 4, query: 'sr' })
    expect(detectTrigger('@', 1)).toEqual({ kind: 'file', start: 0, query: '' })
  })

  it('/ 同理；词中出现的符号不触发（邮箱、路径）', () => {
    expect(detectTrigger('看 /插件', 5)).toEqual({ kind: 'slash', start: 2, query: '插件' })
    expect(detectTrigger('a@b', 3)).toBeNull()
    expect(detectTrigger('邮箱是 a@b.com', 10)).toBeNull()
    expect(detectTrigger('src/main', 8)).toBeNull()
    expect(detectTrigger('D:/notes/x', 10)).toBeNull()
  })

  it('触发词被空格结束 / 触发符被删掉：不再触发', () => {
    expect(detectTrigger('@ab cd', 6)).toBeNull()
    expect(detectTrigger('@ab', 0)).toBeNull()
    expect(detectTrigger('普通文本', 4)).toBeNull()
  })

  it('光标在词中：区间到光标为止（替换 [start, caret)）', () => {
    expect(detectTrigger('@abc', 2)).toEqual({ kind: 'file', start: 0, query: 'a' })
  })
})

describe('filterFiles / fileRows · 文件过滤', () => {
  const FILES = ['src/main.ts', 'src/App.tsx', 'docs/top.md', 'a/top.txt', 'README.md']

  it('大小写不敏感、路径子串；文件名命中排在只命中目录段的前面', () => {
    expect(filterFiles(FILES, 'app')).toEqual(['src/App.tsx'])
    // 'top' 命中四个：文件名含 top 的两个（top.md / top.txt）在前，目录段含 top 的在后
    expect(filterFiles(FILES, 'src')).toEqual(['src/main.ts', 'src/App.tsx'])
    expect(filterFiles(['top-level/x.txt', 'a/top.txt'], 'top')).toEqual([
      'a/top.txt',
      'top-level/x.txt'
    ])
  })

  it('空关键词 = 前若干条（原序）；到限即截', () => {
    expect(filterFiles(FILES, '')).toEqual(FILES)
    expect(filterFiles(FILES, '', 2)).toEqual(['src/main.ts', 'src/App.tsx'])
    expect(filterFiles(FILES, 'src', 1)).toEqual(['src/main.ts'])
  })

  it('fileRows：主行 = 文件名，次要 = 相对路径；引用 label = 相对路径', () => {
    expect(nameOfPath('src/renderer/main.tsx')).toBe('main.tsx')
    expect(nameOfPath('plain.md')).toBe('plain.md')
    expect(fileRows(['src/main.ts'], 'main')).toEqual([
      {
        id: 'file:src/main.ts',
        label: 'main.ts',
        hint: 'src/main.ts',
        reference: { kind: '文件', label: 'src/main.ts' }
      }
    ])
  })
})

describe('slashGroups · 命令 / 插件 / 技能分区', () => {
  const INPUTS = {
    plugins: [
      { id: 'mcp-1', name: '知识库' },
      { id: 'mcp-2', name: '天气' }
    ],
    skills: [{ dir: 'demo-p1-s1', name: '整理笔记' }]
  }

  it('分区只在非空时出现；顺序 命令 → 插件 → 技能；选中行带引用 label', () => {
    const groups = slashGroups(INPUTS, '')
    expect(groups.map((group) => group.title)).toEqual(['命令', '插件', '技能'])
    expect(flattenGroups(groups).map((row) => row.label)).toEqual([
      '压缩上下文',
      '知识库',
      '天气',
      '整理笔记'
    ])
    expect(flattenGroups(groups)[1].reference).toEqual({ kind: '插件', label: '知识库' })
    expect(flattenGroups(groups)[3].reference).toEqual({ kind: '技能', label: '整理笔记' })
  })

  it('过滤（大小写不敏感）：命中为零的分区整组不出现', () => {
    const onlySkills = slashGroups(INPUTS, '笔记')
    expect(onlySkills.map((group) => group.title)).toEqual(['技能'])

    const none = slashGroups(INPUTS, 'zzz')
    expect(none).toEqual([])

    const caseInsensitive = slashGroups(
      { plugins: [{ id: 'p', name: 'Weather' }], skills: [] },
      'we'
    )
    expect(caseInsensitive[0].rows.map((row) => row.label)).toEqual(['Weather'])
  })

  it('命令分区（round 19）：首条「压缩上下文」= command 行（不插引用标记）', () => {
    const groups = slashGroups(
      { plugins: [], skills: [], command: { percent: 24, busy: false, disabled: false } },
      ''
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.title).toBe('命令')
    expect(groups[0]?.rows[0]).toEqual({
      id: 'command:compact',
      label: '压缩上下文',
      hint: '已使用 24%',
      disabled: false,
      command: 'compact'
    })
    // 关键词过滤：'压缩' 命中的仍是命令行
    expect(
      slashGroups(
        { plugins: [], skills: [], command: { percent: 24, busy: false, disabled: false } },
        '压缩'
      )[0]?.rows
    ).toHaveLength(1)
    // 使用率取不到：不显示数值（不假装 0%）
    expect(
      slashGroups(
        { plugins: [], skills: [], command: { percent: null, busy: false, disabled: false } },
        ''
      )[0]?.rows[0]?.hint
    ).toBeUndefined()
  })

  it('命令分区：压缩中显示「压缩中…」并禁用；流式/等审批（disabled）也禁用', () => {
    const busy = slashGroups(
      { plugins: [], skills: [], command: { percent: 24, busy: true, disabled: false } },
      ''
    )
    expect(busy[0]?.rows[0]).toMatchObject({ hint: '压缩中…', disabled: true })

    const blocked = slashGroups(
      { plugins: [], skills: [], command: { percent: 24, busy: false, disabled: true } },
      ''
    )
    expect(blocked[0]?.rows[0]).toMatchObject({ disabled: true })
  })
})
