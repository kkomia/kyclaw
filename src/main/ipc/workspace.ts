/**
 * workspace 通道的 handler（IPC 契约的"服务端"）：授权工作区的增 / 删 / 切模式。
 * 与 settings 通道同一套范式（入参闸门 → 动作 → 回吐合并后的完整设置），
 * 区别是写授权列表前**必须过 checkWorkspacePath**：路径要真的存在、是目录、非 UNC。
 *
 * pick 走原生选择器（`dialog.showOpenDialog`）：选中的目录直接进列表（默认 ask 模式），
 * 用户取消就是"什么都没发生"。渲染端永远拿不到"不校验就写授权列表"的能力。
 */
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  workspaceAddArgsSchema,
  workspaceRemoveArgsSchema
} from '../../shared/ipc'
import type { AppSettings, WorkspaceMode } from '../../shared/settings'
import { readSettings, settingsPath, updateSettings } from '../settings'
import { checkWorkspacePath, removeWorkspace, upsertWorkspace } from '../workspace'

export function registerWorkspaceIpc(userDataDir: string): void {
  const file = settingsPath(userDataDir)

  ipcMain.handle(IPC_CHANNELS.workspace.pick, async (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.workspace.pick)
    const options: OpenDialogOptions = {
      title: '选择工作区文件夹',
      properties: ['openDirectory']
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)

    const picked = result.canceled ? undefined : result.filePaths[0]
    if (picked === undefined) return readSettings(file)
    return saveWorkspace(file, picked, 'ask')
  })

  ipcMain.handle(IPC_CHANNELS.workspace.add, (_event, ...args) => {
    const [path, mode] = parseIpcArgs(workspaceAddArgsSchema, args, IPC_CHANNELS.workspace.add)
    return saveWorkspace(file, path, mode)
  })

  ipcMain.handle(IPC_CHANNELS.workspace.remove, (_event, ...args) => {
    const [path] = parseIpcArgs(workspaceRemoveArgsSchema, args, IPC_CHANNELS.workspace.remove)
    const current = readSettings(file)
    return updateSettings(file, { workspaces: removeWorkspace(current.workspaces, path) })
  })
}

/** 校验路径 → 合并进列表落盘。校验不过就把原因抛给渲染端（设置页行内显示），绝不写进授权列表 */
function saveWorkspace(file: string, path: string, mode: WorkspaceMode): AppSettings {
  const checked = checkWorkspacePath(path)
  if (!checked.ok) throw new Error(checked.reason)

  const current = readSettings(file)
  return updateSettings(file, {
    workspaces: upsertWorkspace(current.workspaces, checked.path, mode)
  })
}
