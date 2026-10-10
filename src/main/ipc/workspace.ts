/**
 * workspace 通道的 handler（IPC 契约的"服务端"）：授权工作区的增 / 删 / 切模式。
 * 与 settings 通道同一套范式（入参闸门 → 动作 → 回吐合并后的完整设置），
 * 区别是写授权列表前**必须过 checkWorkspacePath**：路径要真的存在、是目录、非 UNC。
 *
 * pick 走原生选择器（`dialog.showOpenDialog`）：选中的目录直接进列表（默认 ask 模式），
 * 用户取消就是"什么都没发生"。渲染端永远拿不到"不校验就写授权列表"的能力。
 *
 * 加与切模式分开（T13）：`add` 不收入参里的 mode（一律 ask），`setMode` 只认已授权路径 ——
 * "完全访问"是设置页里对已有目录的显式切换（带确认），不再有"顺手加一个 full"的口子。
 */
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  workspaceAddArgsSchema,
  workspaceRemoveArgsSchema,
  workspaceSetModeArgsSchema
} from '../../shared/ipc'
import type { AppSettings, WorkspaceMode } from '../../shared/settings'
import { defaultWorkspaceAfterRemoval, defaultWorkspacePatch } from '../projects'
import { readSettings, settingsPath, updateSettings } from '../settings'
import { addWorkspace, checkWorkspacePath, removeWorkspace, setWorkspaceMode } from '../workspace'

export function registerWorkspaceIpc(userDataDir: string): void {
  const file = settingsPath(userDataDir)

  ipcMain.handle(IPC_CHANNELS.workspace.pick, async (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.workspace.pick)
    const picked = await pickDirectory(event, {
      title: '选择工作区文件夹',
      properties: ['openDirectory']
    })
    if (picked === undefined) return readSettings(file)
    return saveNewWorkspace(file, picked)
  })

  ipcMain.handle(IPC_CHANNELS.workspace.pickDefault, async (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.workspace.pickDefault)
    const picked = await pickDirectory(event, {
      title: '选择默认工作区文件夹',
      properties: ['openDirectory']
    })
    if (picked === undefined) return readSettings(file)
    return saveDefaultWorkspace(file, picked)
  })

  ipcMain.handle(IPC_CHANNELS.workspace.add, (_event, ...args) => {
    const [path] = parseIpcArgs(workspaceAddArgsSchema, args, IPC_CHANNELS.workspace.add)
    return saveNewWorkspace(file, path)
  })

  ipcMain.handle(IPC_CHANNELS.workspace.setMode, (_event, ...args) => {
    const [path, mode] = parseIpcArgs(
      workspaceSetModeArgsSchema,
      args,
      IPC_CHANNELS.workspace.setMode
    )
    return switchWorkspaceMode(file, path, mode)
  })

  ipcMain.handle(IPC_CHANNELS.workspace.remove, (_event, ...args) => {
    const [path] = parseIpcArgs(workspaceRemoveArgsSchema, args, IPC_CHANNELS.workspace.remove)
    const current = readSettings(file)
    // 被移除的那条正好是默认工作区 → 指认一并清空（别留一个不在授权列表里的默认工作区）
    return updateSettings(file, {
      workspaces: removeWorkspace(current.workspaces, path),
      defaultWorkspace: defaultWorkspaceAfterRemoval(current, path)
    })
  })
}

/** 原生选择器（有父窗口走模态，没有也能开）；取消回 undefined */
async function pickDirectory(
  event: IpcMainInvokeEvent,
  options: OpenDialogOptions
): Promise<string | undefined> {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? undefined : result.filePaths[0]
}

/** 校验路径（存在、是目录、非 UNC）→ 以 ask 加进列表落盘。校验不过就带原因抛给渲染端 */
function saveNewWorkspace(file: string, path: string): AppSettings {
  const checked = checkWorkspacePath(path)
  if (!checked.ok) throw new Error(checked.reason)

  const current = readSettings(file)
  return updateSettings(file, { workspaces: addWorkspace(current.workspaces, checked.path) })
}

/** 切一个**已授权**目录的访问模式；不在列表里就抛（渲染端行内显示这句原因） */
function switchWorkspaceMode(file: string, path: string, mode: WorkspaceMode): AppSettings {
  const current = readSettings(file)
  const next = setWorkspaceMode(current.workspaces, path, mode)
  if (next === null) throw new Error('这个文件夹不在授权列表里：请先添加它，再切换访问模式')
  return updateSettings(file, { workspaces: next })
}

/**
 * 指认默认工作区（T18）：校验路径（存在、是目录、非 UNC）→ 以 ask 并进授权列表 →
 * `defaultWorkspace` 记授权列表里的写法。full 不在这条路上（仍然只能对已授权目录显式切换）。
 */
function saveDefaultWorkspace(file: string, path: string): AppSettings {
  const checked = checkWorkspacePath(path)
  if (!checked.ok) throw new Error(checked.reason)
  return updateSettings(file, defaultWorkspacePatch(readSettings(file), checked.path))
}
