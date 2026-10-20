import { describe, expect, it } from 'vitest'
import {
  deriveProjectMappings,
  normalizeCwdPath,
  projectIdForCwd,
  type CwdProject
} from '../project-cwd'

/**
 * 0.2.2：内核 session cwd → 项目归组的纯函数口径（侧栏「项目」区，旧映射 API 501 之后
 * 会话归属不再走映射表，而是拿 cwd 反查 settings.projects 的路径包含关系）。
 *
 * 钉住四件事：分隔符/大小写归一、路径边界（前缀不是字符串前缀）、嵌套项目取最长路径、
 * 没有 cwd 的线程不当成"无项目之外的任何东西"（不猜）。
 */
const PROJECTS: CwdProject[] = [
  { id: 'p1', path: 'D:\\ws\\插件' },
  { id: 'p2', path: 'D:\\ws\\插件\\子项目' },
  { id: 'posix', path: '/home/me/repo' }
]

describe('normalizeCwdPath：Windows 口径归一', () => {
  it('统一分隔符、去掉尾分隔符、盘符大小写不敏感', () => {
    expect(normalizeCwdPath('D:/ws/插件/')).toBe('d:\\ws\\插件')
    expect(normalizeCwdPath('d:\\WS\\插件')).toBe('d:\\ws\\插件')
    expect(normalizeCwdPath('  D:\\ws\\插件\\\\  ')).toBe('d:\\ws\\插件')
  })

  it('POSIX 路径大小写敏感、只去尾斜杠', () => {
    expect(normalizeCwdPath('/home/me/repo/')).toBe('/home/me/repo')
    expect(normalizeCwdPath('/Home/Me/Repo')).toBe('/Home/Me/Repo')
  })

  it('空串回空串（不把空白当路径）', () => {
    expect(normalizeCwdPath('   ')).toBe('')
  })
})

describe('projectIdForCwd：路径包含 + 最长匹配', () => {
  it('cwd 恰是项目目录 / 在项目目录下：都归这个项目', () => {
    expect(projectIdForCwd('D:\\ws\\插件', PROJECTS)).toBe('p1')
    expect(projectIdForCwd('D:\\ws\\插件\\src\\index.ts', PROJECTS)).toBe('p1')
    expect(projectIdForCwd('D:/ws/插件/src', PROJECTS)).toBe('p1')
  })

  it('Windows 大小写不敏感：盘符、目录名大小写不同也算同一个项目', () => {
    expect(projectIdForCwd('d:\\WS\\插件\\SRC', PROJECTS)).toBe('p1')
  })

  it('路径边界：D:\\ws\\插件-旧 不是 D:\\ws\\插件 的子目录', () => {
    expect(projectIdForCwd('D:\\ws\\插件-旧\\x', PROJECTS)).toBeNull()
    expect(projectIdForCwd('D:\\ws', PROJECTS)).toBeNull()
  })

  it('嵌套项目：取路径最长的那个（最具体的项目）', () => {
    expect(projectIdForCwd('D:\\ws\\插件\\子项目\\src', PROJECTS)).toBe('p2')
    // 上级项目自己的目录仍归上级（不是被更长的兄弟路径抢走）
    expect(projectIdForCwd('D:\\ws\\插件\\src', PROJECTS)).toBe('p1')
  })

  it('POSIX 路径：大小写不同不算同一条，/home/me/repo-x 也不在内', () => {
    expect(projectIdForCwd('/home/me/repo/src', PROJECTS)).toBe('posix')
    expect(projectIdForCwd('/Home/me/repo', PROJECTS)).toBeNull()
    expect(projectIdForCwd('/home/me/repo-x', PROJECTS)).toBeNull()
  })

  it('没有命中 / cwd 为空 / 项目路径为空：回 null（不猜、不兜底默认工作区）', () => {
    expect(projectIdForCwd('E:\\别的盘\\项目', PROJECTS)).toBeNull()
    expect(projectIdForCwd('', PROJECTS)).toBeNull()
    expect(projectIdForCwd('D:\\ws\\插件', [{ id: 'empty', path: '   ' }])).toBeNull()
    expect(projectIdForCwd('D:\\ws\\插件', [])).toBeNull()
  })
})

describe('deriveProjectMappings：线程列表 → 会话归属', () => {
  it('只收 cwd 能归到现有项目的线程；没 cwd / 落在项目外 = 无项目', () => {
    const mappings = deriveProjectMappings(
      [
        { id: 't1', cwd: 'D:\\ws\\插件' },
        { id: 't2', cwd: 'D:\\ws\\插件\\子项目\\src' },
        { id: 't3', cwd: 'E:\\外部目录' },
        { id: 't4' },
        { id: 't5', cwd: '   ' }
      ],
      PROJECTS
    )
    expect(mappings).toEqual({ t1: 'p1', t2: 'p2' })
  })
})
