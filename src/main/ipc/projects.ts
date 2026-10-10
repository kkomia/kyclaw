/**
 * projects 通道的 handler（T18）：项目的建 / 删 + 创建对话框要的两块料。
 *
 * 与 workspace 通道同一套范式（入参闸门 → 路径校验 → 动作 → 回吐合并后的完整设置）：
 *   - 创建项目：名称校验（main/projects.ts 的 projectNameProblem）→ 路径缺失就**建目录**
 *     （空白项目的默认路径 = 默认工作区基底下的同名子目录）→ `checkWorkspacePath` 归一
 *     （存在、是目录、非 UNC）→ 去重（同一文件夹不建第二个项目）→ 落 settings 的 projects，
 *     同时把项目路径**并进授权列表**（`addWorkspace`，模式一律 ask —— full 只能由用户在设置页
 *     对已授权目录显式切换，T13 收紧的口径不变）。
 *   - 删除项目：只摘 `projects` 清单，**不动磁盘、也不动授权列表** —— 目录与它作为工作区的授权
 *     都是用户的东西，删项目不该顺手删其中任何一个（会话映射由渲染端清掉，见 features/projects）。
 *   - `pick-folder` 只回路径（不落盘、不授权）：对话框要先拿到路径、按"保存"才真建项目。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  projectCreateArgsSchema,
  projectRemoveArgsSchema
} from '../../shared/ipc'
import type { AppSettings } from '../../shared/settings'
import { isUncPath } from '../permission/realpath'
import { addProject, findProjectByPath, projectNameProblem, removeProject } from '../projects'
import { readSettings, settingsPath, updateSettings } from '../settings'
import { addWorkspace, checkWorkspacePath } from '../workspace'

/** 没指认默认工作区时，空白项目的兜底基底（应用数据目录下的 workspaces/，对应 Kimi 的 KimiData 目录） */
export const PROJECTS_FALLBACK_DIR = 'workspaces'

/** 兜底基底：userData/workspaces（目录本身等到真建项目时随 mkdir 一起出现） */
export function projectsBase(userDataDir: string, defaultWorkspace: string | null): string {
  return defaultWorkspace ?? join(userDataDir, PROJECTS_FALLBACK_DIR)
}

/** 目录不存在就建（父级一起补）；已存在且不是目录时抛（checkWorkspacePath 也会兜） */
function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true })
  } catch {
    throw new Error('没法创建这个文件夹：请换一个路径')
  }
}

/** 创建项目：校验 + 建目录 + 入清单 + 进授权列表（ask），返回合并后的完整设置 */
function createProject(file: string, input: { name: string; path: string }): AppSettings {
  const problem = projectNameProblem(input.name)
  if (problem !== null) throw new Error(problem)
  // UNC 先拦：空白项目要"自动建目录"，不能让它变成一条绕开校验的通道
  if (isUncPath(input.path)) throw new Error('不支持 UNC / 网络路径')

  if (!existsSync(input.path)) ensureDirectory(input.path)
  const checked = checkWorkspacePath(input.path)
  if (!checked.ok) throw new Error(checked.reason)

  const current = readSettings(file)
  const existing = findProjectByPath(current.projects, checked.path)
  if (existing !== null) throw new Error(`这个文件夹已经是一个项目：${existing.name}`)

  const project = {
    id: randomUUID(),
    name: input.name.trim(),
    path: checked.path,
    createdAt: new Date().toISOString()
  }

  return updateSettings(file, {
    projects: addProject(current.projects, project),
    workspaces: addWorkspace(current.workspaces, checked.path)
  })
}

export function registerProjectsIpc(userDataDir: string): void {
  const file = settingsPath(userDataDir)

  ipcMain.handle(IPC_CHANNELS.projects.base, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.projects.base)
    const current = readSettings(file)
    return { base: projectsBase(userDataDir, current.defaultWorkspace) }
  })

  ipcMain.handle(IPC_CHANNELS.projects.pickFolder, async (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.projects.pickFolder)
    const options: OpenDialogOptions = {
      title: '选择项目文件夹',
      properties: ['openDirectory']
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)

    const picked = result.canceled ? undefined : result.filePaths[0]
    if (picked === undefined) return { path: null }

    const checked = checkWorkspacePath(picked)
    if (!checked.ok) throw new Error(checked.reason)
    return { path: checked.path }
  })

  ipcMain.handle(IPC_CHANNELS.projects.create, (_event, ...args) => {
    const [input] = parseIpcArgs(projectCreateArgsSchema, args, IPC_CHANNELS.projects.create)
    return createProject(file, input)
  })

  ipcMain.handle(IPC_CHANNELS.projects.remove, (_event, ...args) => {
    const [id] = parseIpcArgs(projectRemoveArgsSchema, args, IPC_CHANNELS.projects.remove)
    const current = readSettings(file)
    return updateSettings(file, { projects: removeProject(current.projects, id) })
  })
}
