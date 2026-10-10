import { describe, expect, it } from 'vitest'
import { folderNameOf, sessionWorkspaceOf } from '../session-workspace'
import type { AppSettings, Workspace } from '@shared/settings'
import type { Project } from '@shared/projects'

/**
 * 会话工作区根（round 7 权限 chip 的显示口径，纯函数）：
 * 与 main/projects.ts 的 sessionRoots 同一顺序（项目 → 默认 → 恰好一条），判不出一律 null。
 */
function settings(
  patch: Partial<AppSettings>
): Pick<AppSettings, 'workspaces' | 'projects' | 'defaultWorkspace'> {
  return {
    workspaces: [],
    projects: [],
    defaultWorkspace: null,
    ...patch
  }
}

const WS_A: Workspace = { path: 'D:\\项目A', mode: 'ask' }
const WS_B: Workspace = { path: 'E:\\项目B', mode: 'full' }
const PROJECT: Project = {
  id: 'p1',
  name: '项目A',
  path: 'D:\\项目A',
  createdAt: '2026-10-11T00:00:00.000Z'
}

describe('sessionWorkspaceOf', () => {
  it('会话属于项目 → 项目目录对应的那条工作区（路径归一后匹配）', () => {
    const result = sessionWorkspaceOf({
      threadId: 't1',
      settings: settings({
        workspaces: [WS_A, WS_B],
        projects: [PROJECT],
        defaultWorkspace: WS_B.path
      }),
      projectOf: () => 'p1'
    })

    expect(result).toEqual(WS_A)
  })

  it('没有项目映射 → 默认工作区；默认不在授权列表里就跳过', () => {
    expect(
      sessionWorkspaceOf({
        threadId: 't1',
        settings: settings({ workspaces: [WS_A, WS_B], defaultWorkspace: 'e:/项目b' }),
        projectOf: () => null
      })
    ).toEqual(WS_B) // 归一后命中（大小写/分隔符不敏感）

    expect(
      sessionWorkspaceOf({
        threadId: 't1',
        settings: settings({ workspaces: [WS_A, WS_B], defaultWorkspace: 'F:\\不在列表' }),
        projectOf: () => null
      })
    ).toBeNull() // 默认不在列表里就跳过；多条并列判不出 → null (不猜)
  })

  it('恰好一条授权工作区时用它兜底；多条并列判不出 → null（不猜）', () => {
    expect(
      sessionWorkspaceOf({
        threadId: 't1',
        settings: settings({ workspaces: [WS_A] }),
        projectOf: () => null
      })
    ).toEqual(WS_A)

    expect(
      sessionWorkspaceOf({
        threadId: 't1',
        settings: settings({ workspaces: [WS_A, WS_B] }),
        projectOf: () => null
      })
    ).toBeNull()
  })

  it('项目路径不在授权列表里：跳过项目档，落到下一档', () => {
    expect(
      sessionWorkspaceOf({
        threadId: 't1',
        settings: settings({ workspaces: [WS_B], projects: [PROJECT] }),
        projectOf: () => 'p1'
      })
    ).toEqual(WS_B) // 唯一一条 → 兜底
  })

  it('没有工作区 → null（调用方据此隐藏权限入口）', () => {
    expect(
      sessionWorkspaceOf({ threadId: 't1', settings: settings({}), projectOf: () => 'p1' })
    ).toBeNull()
  })
})

describe('folderNameOf', () => {
  it('Windows / POSIX 分隔符都认，尾部分隔符不吃进名字', () => {
    expect(folderNameOf('D:\\kyclaw\\工作区-默认')).toBe('工作区-默认')
    expect(folderNameOf('D:\\kyclaw\\工作区-默认\\')).toBe('工作区-默认')
    expect(folderNameOf('/home/user/project')).toBe('project')
    expect(folderNameOf('relative')).toBe('relative')
  })
})
