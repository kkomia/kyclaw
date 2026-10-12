import { describe, expect, it } from 'vitest'
import {
  defaultWorkspaceEntryOf,
  folderNameOf,
  sessionRootPathOf,
  sessionWorkspaceOf
} from '../session-workspace'
import type { AppSettings, Workspace } from '@shared/settings'
import type { Project } from '@shared/projects'
import { sessionDirOf } from '@shared/session-dir'

/**
 * 会话的根（纯函数，round 55 分两条口径 —— 见 session-workspace.ts 头注）：
 *   - sessionWorkspaceOf：**权限 chip 专用**，给授权列表里那条**条目**（无项目 = 默认工作区那条）；
 *   - sessionRootPathOf：**真根**，与 main/projects.ts 的 sessionRoots 同序同值（项目 → 默认工作区下的
 *     会话子目录 → 恰好一条），判不出一律 null。
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

  it('无项目 + 默认工作区命中 → 给的是**条目本身**（不是会话子目录：那不在授权列表里）', () => {
    const shared = {
      workspaces: [WS_A, WS_B],
      defaultWorkspace: WS_A.path
    }
    const of = { threadId: 't1', settings: settings(shared), projectOf: () => null }

    expect(sessionWorkspaceOf(of)).toEqual(WS_A)
    // 对照真根那一路：同一个输入，路径数学那边给的是子目录
    expect(sessionRootPathOf(of)).toBe(sessionDirOf(WS_A.path, 't1'))
  })
})

describe('sessionRootPathOf（真根：复制路径 / 附件相对路径用）', () => {
  const THREAD = 'a1b2c3d4-eeee-4444-8888-000000000000'

  it('有项目的会话 → 项目目录（授权条目写法），默认工作区不参与', () => {
    expect(
      sessionRootPathOf({
        threadId: THREAD,
        settings: settings({
          workspaces: [WS_A, WS_B],
          projects: [PROJECT],
          defaultWorkspace: WS_B.path
        }),
        projectOf: () => 'p1'
      })
    ).toBe(WS_A.path)
  })

  it('无项目 + 默认工作区命中 → 默认工作区下的会话子目录（与主进程同一份路径数学）', () => {
    const result = sessionRootPathOf({
      threadId: THREAD,
      settings: settings({ workspaces: [WS_A, WS_B], defaultWorkspace: 'd:/项目a' }),
      projectOf: () => null
    })

    // 默认工作区那一条的写法（授权条目）当基底；归一后命中（大小写 / 分隔符不敏感）
    expect(result).toBe(sessionDirOf(WS_A.path, THREAD))
    expect(result).toContain('tasks')
  })

  it('多条授权又没指认默认 / 默认不在列表里 → null（判不出，不猜）', () => {
    expect(
      sessionRootPathOf({
        threadId: THREAD,
        settings: settings({ workspaces: [WS_A, WS_B] }),
        projectOf: () => null
      })
    ).toBeNull()
    expect(
      sessionRootPathOf({
        threadId: THREAD,
        settings: settings({ workspaces: [WS_A, WS_B], defaultWorkspace: 'F:\\不在列表' }),
        projectOf: () => null
      })
    ).toBeNull()
  })

  it('还没载出会话（threadId null）：退回默认工作区条目本身（与主进程同一分支）', () => {
    expect(
      sessionRootPathOf({
        threadId: null,
        settings: settings({ workspaces: [WS_A, WS_B], defaultWorkspace: WS_A.path }),
        projectOf: () => null
      })
    ).toBe(WS_A.path)
  })

  it('没指认默认 → 恰好一条授权目录兜底；项目路径不在授权列表里 → 落到下一档', () => {
    expect(
      sessionRootPathOf({
        threadId: THREAD,
        settings: settings({ workspaces: [WS_A] }),
        projectOf: () => null
      })
    ).toBe(WS_A.path)
    expect(
      sessionRootPathOf({
        threadId: THREAD,
        // 项目目录（D:\项目A）不在授权列表里 → 跳过项目档，落唯一那条
        settings: settings({ workspaces: [WS_B], projects: [PROJECT] }),
        projectOf: () => 'p1'
      })
    ).toBe(WS_B.path)
  })
})

describe('defaultWorkspaceEntryOf', () => {
  it('指认过且还在授权列表里才给条目（归一匹配）；没指认 / 不在列表 → null', () => {
    expect(
      defaultWorkspaceEntryOf(settings({ workspaces: [WS_A, WS_B], defaultWorkspace: 'd:/项目a' }))
    ).toEqual(WS_A)
    expect(defaultWorkspaceEntryOf(settings({ workspaces: [WS_A] }))).toBeNull()
    expect(
      defaultWorkspaceEntryOf(settings({ workspaces: [WS_A], defaultWorkspace: 'F:\\不在列表' }))
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
