// @vitest-environment node
/**
 * T18 Step 1：项目清单的纯函数 + 会话根解析。
 *
 * 审查点：① 名称校验（空/保留字符）；② 路径去重与大小写/分隔符等价；③ 会话根的三层口径
 * （项目 → 默认工作区 → 整份授权列表）与"项目/默认工作区必须仍在授权列表里"这条收紧。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../shared/projects'
import type { Workspace } from '../../shared/settings'
import {
  addProject,
  findProjectByPath,
  projectDefaultPath,
  projectNameProblem,
  removeProject,
  sessionRoots
} from '../projects'

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: '插件',
  path: 'D:\\work\\插件',
  createdAt: '2026-10-11T00:00:00.000Z',
  ...overrides
})

const ws = (path: string, mode: Workspace['mode'] = 'ask'): Workspace => ({ path, mode })

describe('projectNameProblem：项目名的可用性', () => {
  it('空/纯空白不行；正常名字可以', () => {
    expect(projectNameProblem('')).toContain('不能为空')
    expect(projectNameProblem('   ')).toContain('不能为空')
    expect(projectNameProblem('插件')).toBeNull()
    expect(projectNameProblem('  plugins-2 ')).toBeNull()
  })

  it('带路径分隔符或 Windows 保留字符不行（它同时要当目录名用）', () => {
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(projectNameProblem(bad), bad).not.toBeNull()
    }
  })
})

describe('projectDefaultPath：空白项目的默认目录', () => {
  it('基底 + 同名子目录（名字首尾空白先 trim）', () => {
    expect(projectDefaultPath('D:\\ws', ' 插件 ')).toBe(join('D:\\ws', '插件'))
    expect(projectDefaultPath('D:\\ws', '插件')).toBe('D:\\ws\\插件')
  })
})

describe('findProjectByPath / addProject / removeProject', () => {
  it('按路径找（大小写与分隔符等价）；找不到回 null', () => {
    const projects = [project()]
    expect(findProjectByPath(projects, 'd:/WORK/插件')?.id).toBe('p1')
    expect(findProjectByPath(projects, 'D:\\work\\别的')).toBeNull()
  })

  it('追加不修改入参；移除按 id、不存在是空操作', () => {
    const projects = [project()]
    const next = addProject(projects, project({ id: 'p2', path: 'D:\\work\\别的' }))
    expect(projects).toHaveLength(1)
    expect(next.map((p) => p.id)).toEqual(['p1', 'p2'])

    const removed = removeProject(next, 'p1')
    expect(removed.map((p) => p.id)).toEqual(['p2'])
    expect(removeProject(removed, '不存在').map((p) => p.id)).toEqual(['p2'])
  })
})

describe('sessionRoots：会话能碰的根', () => {
  const root = 'D:\\work\\插件'
  const other = 'D:\\work\\资料'
  const fallback = 'D:\\work\\默认'
  const workspaces = [ws(other), ws(root), ws(fallback, 'full')]
  const projects = [project({ path: root })]

  it('会话属于某项目 → 只有那个项目（取授权列表里的条目，带它的 mode）', () => {
    expect(sessionRoots({ workspaces, defaultWorkspace: null, projects, projectId: 'p1' })).toEqual(
      [ws(root)]
    )
  })

  it('项目路径与授权列表里的写法不同（大小写/分隔符）也能命中', () => {
    expect(
      sessionRoots({
        workspaces,
        defaultWorkspace: null,
        projects: [project({ path: 'd:/WORK/插件' })],
        projectId: 'p1'
      })
    ).toEqual([ws(root)])
  })

  it('没有项目 → 默认工作区；没指认默认工作区 → 整份授权列表（T10 既有口径）', () => {
    expect(
      sessionRoots({ workspaces, defaultWorkspace: fallback, projects, projectId: null })
    ).toEqual([ws(fallback, 'full')])
    expect(
      sessionRoots({ workspaces, defaultWorkspace: null, projects, projectId: undefined })
    ).toEqual(workspaces)
  })

  it('项目 id 找不到（项目已删 / 映射过期）→ 退回默认工作区', () => {
    expect(
      sessionRoots({ workspaces, defaultWorkspace: fallback, projects, projectId: '不存在' })
    ).toEqual([ws(fallback, 'full')])
    expect(
      sessionRoots({
        workspaces,
        defaultWorkspace: null,
        projects: [project({ id: 'p2', path: 'D:\\work\\别的' })],
        projectId: 'p1'
      })
    ).toEqual(workspaces)
  })

  it('项目/默认工作区已从授权列表移除 → 不停在那一层，继续往下兜底（用户取消过授权）', () => {
    const onlyOther = [ws(other)]
    expect(
      sessionRoots({ workspaces: onlyOther, defaultWorkspace: fallback, projects, projectId: 'p1' })
    ).toEqual(onlyOther)
    expect(
      sessionRoots({ workspaces: onlyOther, defaultWorkspace: fallback, projects, projectId: null })
    ).toEqual(onlyOther)
  })

  it('一条授权都没有 → 空根（文件工具会明确报"先去设置里添加"）', () => {
    expect(
      sessionRoots({ workspaces: [], defaultWorkspace: fallback, projects, projectId: 'p1' })
    ).toEqual([])
  })
})
