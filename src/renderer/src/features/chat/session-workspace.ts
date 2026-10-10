import { normalizeWorkspacePath } from '@shared/permissions'
import type { AppSettings, Workspace } from '@shared/settings'

/**
 * 当前会话的"工作区根"（round 7：composer 权限 chip 显示/切换的目标）——**纯展示口径，不是安全边界**。
 *
 * 取值顺序与 `main/projects.ts` 的 sessionRoots 一致（那边是执行口径，这里是它的只读镜像）：
 *   1. 会话属于某项目 → 项目目录对应的那条工作区；
 *   2. 否则默认工作区（设置了且还在授权列表里）；
 *   3. 否则：授权列表里**恰好一条**时用它；
 *   4. 判不出（没工作区 / 多条并列）→ null：调用方隐藏权限入口（别让用户以为在切一个说不清的范围）。
 *
 * 切换权限只走既有的 `workspace:set-mode` 通道（主进程校验路径；full 在 UI 侧仍要确认）——
 * 这里不做任何写入，也不绕过审批语义（T13）。
 */
/** 目录名（Windows / POSIX 分隔符都认；给「引用上下文」的标签用） */
export function folderNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

export function sessionWorkspaceOf(input: {
  threadId: string | null
  settings: Pick<AppSettings, 'workspaces' | 'projects' | 'defaultWorkspace'>
  projectOf: (threadId: string | null) => string | null
}): Workspace | null {
  const { threadId, settings, projectOf } = input

  const byPath = (path: string | null | undefined): Workspace | null => {
    if (path === null || path === undefined || path === '') return null
    const normalized = normalizeWorkspacePath(path)
    return (
      settings.workspaces.find(
        (workspace) => normalizeWorkspacePath(workspace.path) === normalized
      ) ?? null
    )
  }

  if (threadId !== null) {
    const projectId = projectOf(threadId)
    const project =
      projectId === null
        ? undefined
        : settings.projects.find((candidate) => candidate.id === projectId)
    const fromProject = byPath(project?.path)
    if (fromProject !== null) return fromProject
  }

  const fromDefault = byPath(settings.defaultWorkspace)
  if (fromDefault !== null) return fromDefault

  return settings.workspaces.length === 1 ? settings.workspaces[0] : null
}
