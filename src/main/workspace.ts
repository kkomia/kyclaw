/**
 * 工作区（授权目录）管理：列表操作是纯函数，路径校验在**落盘之前**把住。
 *
 * 存储位置就是 settings.json 的 workspaces 字段（唯一事实来源，schema 在 shared/settings.ts），
 * 所以这里不另建文件、不缓存。校验只做"能不能作为工作区"这件事：存在、是目录、非 UNC；
 * 真正的访问判定（每个文件路径是否落在工作区里）在 permission/realpath.ts。
 *
 * 归一：新增路径经 `checkWorkspacePath` 过 realpath 之后再进列表 —— 大小写/分隔符/链接写法
 * 不同不该变成两条授权。列表里已有的条目，其 path 就是权威写法：`setWorkspaceMode` 只改
 * mode、不采纳调用方给的字符串（渲染端不该有能力改写授权表里的路径写法）。
 *
 * 加与切模式分开（T13）：`addWorkspace` 只以 ask 新增；`setWorkspaceMode` 只认已授权路径。
 * 这样"完全访问"必须是对已有目录的一次显式切换（设置页里带确认），不能随添加静默生效。
 */
import { realpathSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { Workspace, WorkspaceMode } from '../shared/settings'
import { isUncPath } from './permission/realpath'

export type WorkspacePathCheck = { ok: true; path: string } | { ok: false; reason: string }

/** 进授权列表前的校验：存在 + 是目录 + 非 UNC；通过就回 realpath 归一后的路径 */
export function checkWorkspacePath(input: string): WorkspacePathCheck {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: false, reason: '路径为空' }
  if (isUncPath(trimmed)) return { ok: false, reason: '不支持 UNC / 网络路径' }

  let real: string
  try {
    real = realpathSync.native(trimmed)
  } catch {
    return { ok: false, reason: '路径不存在或不可访问' }
  }

  try {
    if (!statSync(real).isDirectory()) return { ok: false, reason: '不是文件夹' }
  } catch {
    return { ok: false, reason: '路径不存在或不可访问' }
  }
  return { ok: true, path: real }
}

/**
 * workspace:add 的实现：列表里没有就**以 ask 新增**；已经在列表里就保持它的模式与写法不动
 * （重选同一个目录不该把用户开过的 full 悄悄降级，也不该把新目录直接当 full 收进来 ——
 * full 只能经 setWorkspaceMode 的显式切换，见下）。
 * `path` 由调用方保证是 `checkWorkspacePath` 归一过的（IPC handler 就是那么做的）。
 */
export function addWorkspace(workspaces: readonly Workspace[], path: string): Workspace[] {
  const index = workspaces.findIndex((workspace) => samePath(workspace.path, path))
  if (index < 0) return [...workspaces, { path, mode: 'ask' }]
  return [...workspaces]
}

/**
 * workspace:set-mode 的实现：**只认已在授权列表里的路径**（T13 收紧 full 入口）。
 * 不在列表里回 null，调用方抛错 —— "切模式"不能变成"加一个 full 工作区"的捷径。
 * 命中的那条**保留列表里的原 path 与写法**，只改 mode：切模式不重写授权表里的路径
 * （调用方给的是匹配用的字符串，可能只是大小写/分隔符不同的另一种写法）。
 */
export function setWorkspaceMode(
  workspaces: readonly Workspace[],
  path: string,
  mode: WorkspaceMode
): Workspace[] | null {
  const index = workspaces.findIndex((workspace) => samePath(workspace.path, path))
  if (index < 0) return null
  return workspaces.map((workspace, at) =>
    at === index ? { path: workspace.path, mode } : workspace
  )
}

export function removeWorkspace(workspaces: readonly Workspace[], path: string): Workspace[] {
  return workspaces.filter((workspace) => !samePath(workspace.path, path))
}

/** 同一个路径的两种写法（Windows：大小写不敏感、分隔符等价）—— path.relative 归一后为空的即同一条 */
function samePath(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === ''
}
