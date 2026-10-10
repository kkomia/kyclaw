import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * workspace 通道 handler：pick 走原生选择器（mock 掉 electron 的 dialog），
 * add / remove 读写这个 userData 目录下的 settings.json。
 * 重点看两件事：① 只有**校验过的目录**能进授权列表；② 入参先过闸门。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>(),
    dialog: vi.fn(),
    /** BrowserWindow.fromWebContents 的返回值：null = 没有父窗口 */
    window: null as unknown
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: () => mocks.window },
  dialog: { showOpenDialog: mocks.dialog }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { DEFAULT_SETTINGS, type Workspace } from '../../../shared/settings'
import { readSettings, settingsPath } from '../../settings'
import { registerWorkspaceIpc } from '../workspace'

const EVENT = { sender: { id: 1 } }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

/** 原生选择器回一个目录 / 取消 */
function dialogPicks(path?: string): void {
  mocks.dialog.mockResolvedValue(
    path === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] }
  )
}

let dir: string
let project: string
let realProject: string

beforeEach(() => {
  mocks.handlers.clear()
  mocks.dialog.mockReset()
  mocks.window = null
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-workspace-ipc-'))
  project = join(dir, '工作区')
  mkdirSync(join(project, '子目录'), { recursive: true })
  // 归一后的期待值：mkdtemp 在 Windows 上给的是真实大小写的临时目录，直接拿它拼
  realProject = project
  registerWorkspaceIpc(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const workspaces = (): Workspace[] => readSettings(settingsPath(dir)).workspaces

describe('workspace 通道 handler：注册与入参闸门', () => {
  it('四条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'workspace:add',
      'workspace:pick',
      'workspace:remove',
      'workspace:set-mode'
    ])
  })

  it('workspace:pick 不收入参（异步 handler：拒绝而不是同步抛）', async () => {
    await expect(handlerOf(IPC_CHANNELS.workspace.pick)(EVENT, { path: 'x' })).rejects.toThrow(
      IpcInputError
    )
  })

  it('workspace:add / set-mode / remove 的入参先过闸门（非法调用不碰磁盘）', () => {
    const add = handlerOf(IPC_CHANNELS.workspace.add)
    // add 只收 [path]：带 mode 的旧调用形状直接拒（full 不能再从这条路进来）
    for (const args of [[], [''], [project, 'full'], [project, 'ask'], [1], [project, 'x']]) {
      expect(() => add(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    const setMode = handlerOf(IPC_CHANNELS.workspace.setMode)
    for (const args of [[], ['', 'ask'], [project], [project, 'always'], [project, 'full', 'x']]) {
      expect(() => setMode(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    const remove = handlerOf(IPC_CHANNELS.workspace.remove)
    for (const args of [[], [''], [1], [project, 'x']]) {
      expect(() => remove(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    expect(existsSync(settingsPath(dir))).toBe(false)
  })
})

describe('workspace:pick（原生选择器）', () => {
  it('选中目录 → 以 ask 模式落盘，回吐合并后的设置', async () => {
    dialogPicks(project)

    const next = await handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)

    expect(next).toEqual({ ...DEFAULT_SETTINGS, workspaces: [{ path: realProject, mode: 'ask' }] })
    expect(workspaces()).toEqual([{ path: realProject, mode: 'ask' }])
  })

  it('有父窗口时把窗口交给对话框（模态），没有父窗口也能开（兜底分支）', async () => {
    const parent = { id: 'window' }
    mocks.window = parent
    dialogPicks(project)

    await handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)

    expect(mocks.dialog).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({ properties: ['openDirectory'] })
    )

    mocks.window = null
    mocks.dialog.mockClear()
    dialogPicks(project)
    await handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory'] })
    )
  })

  it('取消（或没选任何目录）→ 什么都不改，也不落盘', async () => {
    dialogPicks()

    const next = await handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)

    expect(next).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('选择器回了一条不在的路径（或 UNC）：抛错，授权列表不进这种条目', async () => {
    dialogPicks(join(dir, '不存在'))
    await expect(handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)).rejects.toThrow(/路径不存在/)

    dialogPicks('\\\\server\\share\\项目')
    await expect(handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)).rejects.toThrow(/UNC/)

    expect(workspaces()).toEqual([])
  })

  it('重复选同一个目录（大小写不同）不会变成两条', async () => {
    dialogPicks(project)
    await handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)

    dialogPicks(project.toUpperCase())
    const next = (await handlerOf(IPC_CHANNELS.workspace.pick)(EVENT)) as {
      workspaces: Workspace[]
    }

    expect(next.workspaces).toHaveLength(1)
    expect(workspaces()).toHaveLength(1)
  })
})

describe('workspace:add（新增，一律 ask）', () => {
  it('新路径：以 ask 落盘（不收入参 mode，full 走 set-mode）', () => {
    const next = handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)

    expect(next).toEqual({ ...DEFAULT_SETTINGS, workspaces: [{ path: realProject, mode: 'ask' }] })
    expect(workspaces()).toEqual([{ path: realProject, mode: 'ask' }])
  })

  it('已在列表里（已是 full）：幂等，不把模式降级也不多出一行', () => {
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)
    handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, project, 'full')

    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)

    expect(workspaces()).toEqual([{ path: realProject, mode: 'full' }])
  })

  it('不是目录 / 不吃 UNC：抛错，已落盘的授权列表保持原样', async () => {
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)

    expect(() => handlerOf(IPC_CHANNELS.workspace.add)(EVENT, join(dir, '无'))).toThrow(
      /路径不存在/
    )
    expect(() => handlerOf(IPC_CHANNELS.workspace.add)(EVENT, '\\\\srv\\share')).toThrow(/UNC/)

    expect(workspaces()).toEqual([{ path: realProject, mode: 'ask' }])
  })

  it('落盘失败照样抛（不吞掉用户的改动）', () => {
    const blocked = join(dir, 'blocked')
    mkdirSync(blocked)
    // 把 settings.json 的位置让给一个目录 → 写必失败
    mkdirSync(settingsPath(blocked))
    mocks.handlers.clear()
    registerWorkspaceIpc(blocked)

    expect(() => handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)).toThrow()
  })
})

describe('workspace:set-mode（切模式：只认已授权路径）', () => {
  it('已授权路径：切到 full 落盘并回吐', () => {
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)

    const next = handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, project, 'full')

    expect(next).toEqual({ ...DEFAULT_SETTINGS, workspaces: [{ path: realProject, mode: 'full' }] })
    expect(workspaces()).toEqual([{ path: realProject, mode: 'full' }])
  })

  it('不在授权列表里的路径：抛错，不落盘、不新增', () => {
    expect(() => handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, project, 'full')).toThrow(
      /不在授权列表/
    )

    expect(workspaces()).toEqual([])
  })

  it('切回 ask 同样只认已授权路径', () => {
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)
    handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, project, 'full')

    expect(handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, project, 'ask')).toEqual({
      ...DEFAULT_SETTINGS,
      workspaces: [{ path: realProject, mode: 'ask' }]
    })
  })
})

describe('workspace:remove', () => {
  it('移除后回吐剩下的列表（其余条目不动）', () => {
    const other = join(dir, '另一个')
    mkdirSync(other)
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)
    handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, project, 'full')
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, other)

    const next = handlerOf(IPC_CHANNELS.workspace.remove)(EVENT, project)

    expect(next).toEqual({ ...DEFAULT_SETTINGS, workspaces: [{ path: other, mode: 'ask' }] })
    expect(workspaces()).toEqual([{ path: other, mode: 'ask' }])
  })

  it('移一个不在列表里的路径：空操作，不抛', () => {
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)

    expect(handlerOf(IPC_CHANNELS.workspace.remove)(EVENT, join(dir, '无'))).toEqual({
      ...DEFAULT_SETTINGS,
      workspaces: [{ path: realProject, mode: 'ask' }]
    })
  })

  it('移除不需要路径此刻仍然存在（用户先删了文件夹也要能把它从列表里去掉）', () => {
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, project)
    rmSync(project, { recursive: true, force: true })

    expect(handlerOf(IPC_CHANNELS.workspace.remove)(EVENT, project)).toEqual(DEFAULT_SETTINGS)
  })
})
