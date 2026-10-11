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
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  workspaceAddArgsSchema,
  workspaceListFilesArgsSchema,
  workspaceOpenInExplorerArgsSchema,
  workspaceRemoveArgsSchema,
  workspaceSetModeArgsSchema
} from '../../shared/ipc'
import type { AppSettings, WorkspaceMode } from '../../shared/settings'
import { defaultWorkspaceAfterRemoval, defaultWorkspacePatch, sessionRoots } from '../projects'
import { readSettings, settingsPath, updateSettings } from '../settings'
import { addWorkspace, checkWorkspacePath, removeWorkspace, setWorkspaceMode } from '../workspace'
import { listWorkspaceFiles } from '../workspace-files'

/** round 15：threadId → 项目 id（agent 服务的 session_projects 内存镜像；缺省 = 没有映射） */
export type ProjectIdOf = (threadId: string) => string | null

export function registerWorkspaceIpc(userDataDir: string, projectIdOf?: ProjectIdOf): void {
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

  ipcMain.handle(IPC_CHANNELS.workspace.listFiles, (_event, ...args) => {
    const [threadId] = parseIpcArgs(
      workspaceListFilesArgsSchema,
      args,
      IPC_CHANNELS.workspace.listFiles
    )
    return listFilesForThread(file, threadId, projectIdOf)
  })

  // round 20：在文件资源管理器里打开会话根（读类：入参闸门同步抛，同 list-files；
  // 打开失败走 openInExplorerForThread 的 rejection，渲染端 catch 后露一行）
  ipcMain.handle(IPC_CHANNELS.workspace.openInExplorer, (_event, ...args) => {
    const [threadId] = parseIpcArgs(
      workspaceOpenInExplorerArgsSchema,
      args,
      IPC_CHANNELS.workspace.openInExplorer
    )
    return openInExplorerForThread(file, threadId, projectIdOf)
  })
}

/** 会话根解析的公共半边：按 sessionRoots 口径（项目 → 默认工作区 → 唯一授权目录）取根列表 */
function rootsForThread(
  file: string,
  threadId: string,
  projectIdOf?: ProjectIdOf
): readonly { path: string }[] {
  const current = readSettings(file)
  return sessionRoots({
    workspaces: current.workspaces,
    defaultWorkspace: current.defaultWorkspace,
    projects: current.projects,
    projectId: projectIdOf?.(threadId) ?? null
  })
}

/**
 * 会话根 → 文件清单（round 15）：解析口径与文件工具一致（`sessionRoots`：项目 → 默认工作区 →
 * 唯一的授权目录）。**会话根不唯一**（多条授权且没指认默认）时抛人话——@ 的相对路径得有唯一基准；
 * 渲染端只给 threadId，路径解析全在主进程。读不了/不存在由 `listWorkspaceFiles` 的人话兜底。
 */
export function listFilesForThread(
  file: string,
  threadId: string,
  projectIdOf?: ProjectIdOf
): { files: string[] } {
  const roots = rootsForThread(file, threadId, projectIdOf)
  if (roots.length === 0) {
    throw new Error('这个会话还没有工作区：先在设置里添加一个文件夹，再用 @ 引用文件')
  }
  if (roots.length > 1) {
    throw new Error('这个会话的工作区不唯一：指认默认工作区（或给会话选一个项目）后再用 @')
  }
  return { files: listWorkspaceFiles(roots[0].path) }
}

/**
 * 会话根 → 系统文件资源管理器（round 20）。同样的唯一根口径：
 *   - 没有工作区 / 多条并列 → 人话错误（渲染端本来会禁用入口，这里是第二道）；
 *   - `shell.openPath` 回非空字符串 = 没打开成（回的就是原因）→ 转人话错误。
 * 测试可注入 opener（缺省 = electron 的 shell.openPath）。
 */
export async function openInExplorerForThread(
  file: string,
  threadId: string,
  projectIdOf?: ProjectIdOf,
  openPath: (path: string) => Promise<string> = (path) => shell.openPath(path)
): Promise<{ path: string }> {
  const roots = rootsForThread(file, threadId, projectIdOf)
  if (roots.length === 0) {
    throw new Error('这个会话还没有工作区：先在设置里添加一个文件夹')
  }
  if (roots.length > 1) {
    throw new Error('这个会话的工作区不唯一：指认默认工作区（或给会话选一个项目）后再试')
  }
  const target = roots[0].path
  const problem = await openPath(target)
  if (problem !== '') {
    throw new Error(`打不开这个文件夹：${problem}`)
  }
  return { path: target }
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
