import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * projects 通道 handler（T18）：建 / 删 / 两个料（基底与文件夹选择器）。
 * 重点：① 路径与授权目录同源校验（没过 `checkWorkspacePath` 的东西进不了清单）；
 * ② 建项目 = 建目录（空白项目）+ 入清单 + **以 ask 进授权列表**（不得免手势给 full）；
 * ③ 同一文件夹不重复建；④ 删项目只摘清单（磁盘与授权列表不动）。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>(),
    dialog: vi.fn(),
    openPath: vi.fn(async () => ''),
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
  dialog: { showOpenDialog: mocks.dialog },
  shell: { openPath: mocks.openPath }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { readSettings, settingsPath, updateSettings } from '../../settings'
import { registerProjectsIpc } from '../projects'

const EVENT = { sender: { id: 1 } }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

function dialogPicks(path?: string): void {
  mocks.dialog.mockResolvedValue(
    path === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] }
  )
}

let dir: string
let existing: string
let realExisting: string

beforeEach(() => {
  mocks.handlers.clear()
  mocks.dialog.mockReset()
  mocks.openPath.mockReset()
  mocks.openPath.mockResolvedValue('')
  mocks.window = null
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kyclaw-projects-ipc-')))
  existing = join(dir, '现有项目')
  mkdirSync(existing, { recursive: true })
  realExisting = existing
  registerProjectsIpc(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const settings = (): ReturnType<typeof readSettings> => readSettings(settingsPath(dir))

describe('projects 通道 handler：注册与入参闸门', () => {
  it('六条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'projects:base',
      'projects:create',
      'projects:open-in-explorer',
      'projects:pick-folder',
      'projects:remove',
      'projects:rename'
    ])
  })

  it('入参先过闸门（非法调用不碰磁盘）', async () => {
    const create = handlerOf(IPC_CHANNELS.projects.create)
    for (const args of [
      [],
      [''],
      [{ name: 'x' }],
      [{ path: 'x' }],
      [{ name: '', path: 'x' }],
      ['x'],
      [{ name: 'x', path: 'y', mode: 'full' }]
    ]) {
      expect(() => create(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    const remove = handlerOf(IPC_CHANNELS.projects.remove)
    for (const args of [[], [''], [1], ['id', 'x']]) {
      expect(() => remove(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    const rename = handlerOf(IPC_CHANNELS.projects.rename)
    for (const args of [[], [''], [{ id: 'x' }], [{ name: 'y' }], [{ id: 'x', name: '' }], [1]]) {
      expect(() => rename(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    const openInExplorer = handlerOf(IPC_CHANNELS.projects.openInExplorer)
    await expect(openInExplorer(EVENT)).rejects.toThrow(IpcInputError)
    await expect(openInExplorer(EVENT, 1)).rejects.toThrow(IpcInputError)

    // base 是同步 handler；pickFolder 是异步（原生选择器）
    expect(() => handlerOf(IPC_CHANNELS.projects.base)(EVENT, 'x')).toThrow(IpcInputError)
    await expect(handlerOf(IPC_CHANNELS.projects.pickFolder)(EVENT, 'x')).rejects.toThrow(
      IpcInputError
    )

    expect(existsSync(settingsPath(dir))).toBe(false)
  })
})

describe('projects:base（创建对话框的默认基底）', () => {
  it('没指认默认工作区 → userData/workspaces；指认了就用它', () => {
    const base = (handlerOf(IPC_CHANNELS.projects.base)(EVENT) as { base: string }).base
    expect(base).toBe(join(dir, 'workspaces'))

    handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name: '甲', path: existing })
    // 手动指认默认工作区（走与 pick-default 同一条落盘路）
    updateSettings(settingsPath(dir), { defaultWorkspace: realExisting })

    expect((handlerOf(IPC_CHANNELS.projects.base)(EVENT) as { base: string }).base).toBe(
      realExisting
    )
  })
})

describe('projects:pick-folder', () => {
  it('选中目录 → 回归一后的路径（不落盘、不授权）', async () => {
    dialogPicks(existing)

    await expect(handlerOf(IPC_CHANNELS.projects.pickFolder)(EVENT)).resolves.toEqual({
      path: realExisting
    })
    expect(existsSync(settingsPath(dir))).toBe(false)
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory'] })
    )
  })

  it('取消 → { path: null }', async () => {
    dialogPicks()
    await expect(handlerOf(IPC_CHANNELS.projects.pickFolder)(EVENT)).resolves.toEqual({
      path: null
    })
  })

  it('回了一条不在的路径（或 UNC）→ 抛错，不给对话框一个假路径', async () => {
    dialogPicks(join(dir, '不存在'))
    await expect(handlerOf(IPC_CHANNELS.projects.pickFolder)(EVENT)).rejects.toThrow(/路径不存在/)

    dialogPicks('\\\\server\\share\\项目')
    await expect(handlerOf(IPC_CHANNELS.projects.pickFolder)(EVENT)).rejects.toThrow(/UNC/)
  })
})

describe('projects:create', () => {
  it('已存在的目录：入清单 + 以 ask 进授权列表，回吐合并后的设置', () => {
    const next = handlerOf(IPC_CHANNELS.projects.create)(EVENT, {
      name: ' 现有项目 ',
      path: existing
    }) as ReturnType<typeof readSettings>

    expect(next.projects).toHaveLength(1)
    expect(next.projects[0]).toMatchObject({ name: '现有项目', path: realExisting })
    expect(next.workspaces).toEqual([{ path: realExisting, mode: 'ask' }])
    expect(settings().projects).toEqual(next.projects)
  })

  it('路径不存在（空白项目）：自动建目录，再入清单', () => {
    const target = join(dir, 'workspaces', '新项目')

    const next = handlerOf(IPC_CHANNELS.projects.create)(EVENT, {
      name: '新项目',
      path: target
    }) as ReturnType<typeof readSettings>

    expect(existsSync(target)).toBe(true)
    expect(next.projects[0]?.path.toLowerCase()).toBe(target.toLowerCase())
    expect(next.workspaces).toHaveLength(1)
  })

  it('同一文件夹（大小写不同）不重复建：抛错且清单不变', () => {
    handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name: '甲', path: existing })

    expect(() =>
      handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name: '乙', path: existing.toUpperCase() })
    ).toThrow(/已经是一个项目/)

    expect(settings().projects).toHaveLength(1)
  })

  it('名称不合法（空 / 带分隔符）：抛错，不建目录也不落盘', () => {
    const target = join(dir, '不该被建出来')
    // 空名在闸门那层就被拦（min 1）；带分隔符的过闸门、由业务校验拦
    expect(() =>
      handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name: '', path: target })
    ).toThrow(IpcInputError)
    for (const name of ['   ', 'a/b', 'a\\b']) {
      expect(
        () => handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name, path: target }),
        name
      ).toThrow(/项目名称/)
    }
    expect(existsSync(target)).toBe(false)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('UNC 路径：抛错，不建目录（不给"自动建目录"绕开校验的口子）', () => {
    expect(() =>
      handlerOf(IPC_CHANNELS.projects.create)(EVENT, {
        name: 'x',
        path: '\\\\server\\share\\x'
      })
    ).toThrow(/UNC/)
  })

  it('已有 full 工作区时建项目：新项目那条仍是 ask（不得免手势给 full）', () => {
    const other = join(dir, '别的')
    mkdirSync(other)
    handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name: '甲', path: other })

    const next = handlerOf(IPC_CHANNELS.projects.create)(EVENT, {
      name: '乙',
      path: existing
    }) as ReturnType<typeof readSettings>

    expect(next.workspaces).toEqual([
      { path: other, mode: 'ask' },
      { path: realExisting, mode: 'ask' }
    ])
  })
})

describe('projects:remove', () => {
  it('只摘清单：磁盘还在、授权列表不动、会话映射的事不在这条路上', () => {
    const next = handlerOf(IPC_CHANNELS.projects.create)(EVENT, {
      name: '甲',
      path: existing
    }) as ReturnType<typeof readSettings>
    const id = next.projects[0]?.id ?? ''

    const after = handlerOf(IPC_CHANNELS.projects.remove)(EVENT, id) as ReturnType<
      typeof readSettings
    >

    expect(after.projects).toEqual([])
    expect(after.workspaces).toEqual([{ path: realExisting, mode: 'ask' }])
    expect(existsSync(existing)).toBe(true)
  })

  it('id 不存在：空操作', () => {
    handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name: '甲', path: existing })
    const after = handlerOf(IPC_CHANNELS.projects.remove)(EVENT, '不存在') as ReturnType<
      typeof readSettings
    >
    expect(after.projects).toHaveLength(1)
  })
})

describe('projects:rename（round 25）', () => {
  function createOne(): string {
    const next = handlerOf(IPC_CHANNELS.projects.create)(EVENT, {
      name: '甲',
      path: existing
    }) as ReturnType<typeof readSettings>
    return next.projects[0]?.id ?? ''
  }

  it('改名只动显示名：trim 后落盘，路径与其他项目不动', () => {
    const id = createOne()
    const other = join(dir, '别的')
    mkdirSync(other)
    handlerOf(IPC_CHANNELS.projects.create)(EVENT, { name: '乙', path: other })

    const next = handlerOf(IPC_CHANNELS.projects.rename)(EVENT, {
      id,
      name: ' 甲甲 '
    }) as ReturnType<typeof readSettings>

    expect(next.projects[0]).toMatchObject({ id, name: '甲甲', path: realExisting })
    expect(next.projects[1]?.name).toBe('乙')
    expect(settings().projects[0]?.name).toBe('甲甲')
  })

  it('名字不合法（空白 / 带分隔符）：抛错且清单不变', () => {
    const id = createOne()

    for (const name of ['   ', 'a/b', 'a\\b']) {
      expect(() => handlerOf(IPC_CHANNELS.projects.rename)(EVENT, { id, name }), name).toThrow(
        /项目名称/
      )
    }
    expect(settings().projects[0]?.name).toBe('甲')
  })

  it('id 不存在：抛「这个项目不在列表里」', () => {
    createOne()
    expect(() =>
      handlerOf(IPC_CHANNELS.projects.rename)(EVENT, { id: '不存在', name: '乙' })
    ).toThrow(/不在列表里/)
  })
})

describe('projects:open-in-explorer（round 25）', () => {
  function createOne(): string {
    const next = handlerOf(IPC_CHANNELS.projects.create)(EVENT, {
      name: '甲',
      path: existing
    }) as ReturnType<typeof readSettings>
    return next.projects[0]?.id ?? ''
  }

  it('按 id 解析路径交给 shell.openPath；成功回 { path }', async () => {
    const id = createOne()

    await expect(handlerOf(IPC_CHANNELS.projects.openInExplorer)(EVENT, id)).resolves.toEqual({
      path: realExisting
    })
    expect(mocks.openPath).toHaveBeenCalledWith(realExisting)
  })

  it('openPath 回非空（打不开）：抛人话「打不开这个文件夹：…」', async () => {
    const id = createOne()
    mocks.openPath.mockResolvedValueOnce('没有访问权限')

    await expect(handlerOf(IPC_CHANNELS.projects.openInExplorer)(EVENT, id)).rejects.toThrow(
      /打不开这个文件夹：没有访问权限/
    )
  })

  it('id 不存在：抛「这个项目不在列表里」（不碰 shell）', async () => {
    await expect(handlerOf(IPC_CHANNELS.projects.openInExplorer)(EVENT, '不存在')).rejects.toThrow(
      /不在列表里/
    )
    expect(mocks.openPath).not.toHaveBeenCalled()
  })
})

describe('默认工作区（workspace:pick-default 的落盘半边）', () => {
  it('与项目共用同一条校验/授权路：进列表（ask）+ 记授权列表里的写法', async () => {
    const { registerWorkspaceIpc } = await import('../workspace')
    mocks.handlers.clear()
    registerWorkspaceIpc(dir)

    dialogPicks(existing)
    const next = (await handlerOf(IPC_CHANNELS.workspace.pickDefault)(EVENT)) as ReturnType<
      typeof readSettings
    >

    expect(next.defaultWorkspace).toBe(realExisting)
    expect(next.workspaces).toEqual([{ path: realExisting, mode: 'ask' }])
    expect(settings().defaultWorkspace).toBe(realExisting)
  })

  it('取消：什么都不改，不落盘', async () => {
    const { registerWorkspaceIpc } = await import('../workspace')
    mocks.handlers.clear()
    registerWorkspaceIpc(dir)

    dialogPicks()
    const next = (await handlerOf(IPC_CHANNELS.workspace.pickDefault)(EVENT)) as ReturnType<
      typeof readSettings
    >

    expect(next).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('移除工作区时若它正是默认工作区：指认一并清空（不留悬空指认）', async () => {
    const { registerWorkspaceIpc } = await import('../workspace')
    mocks.handlers.clear()
    registerWorkspaceIpc(dir)

    dialogPicks(existing)
    await handlerOf(IPC_CHANNELS.workspace.pickDefault)(EVENT)

    const other = join(dir, '别的')
    mkdirSync(other)
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, other)

    const after = handlerOf(IPC_CHANNELS.workspace.remove)(EVENT, existing) as ReturnType<
      typeof readSettings
    >
    expect(after.defaultWorkspace).toBeNull()
    expect(after.workspaces).toEqual([{ path: other, mode: 'ask' }])
  })
})
