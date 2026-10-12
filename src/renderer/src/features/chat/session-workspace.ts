import { normalizeWorkspacePath } from '@shared/permissions'
import { sessionDirOf } from '@shared/session-dir'
import type { AppSettings, Workspace } from '@shared/settings'

/**
 * 会话的根（round 55 起是**两条口径**，用途不同，别混用）：
 *
 *   1. `sessionWorkspaceOf` —— **权限 chip 专用**。它管的是"切哪条授权条目的 mode"：`workspace:set-mode`
 *      只认授权列表里的路径（主进程按那条条目的原样路径读写它的模式）。所以这里给的是**授权列表里的
 *      原条目**：无项目会话 = 默认工作区那条条目本身，**不是**它下面的会话子目录（子目录不在授权列表
 *      里，拿它去切模式会被主进程拒掉）。
 *
 *   2. `sessionRootPathOf` —— **真根**（路径数学口径），与主进程 `main/projects.ts` 的 sessionRoots
 *      同序同值：项目会话 = 项目目录（授权条目写法）；无项目 = 默认工作区下的**会话子目录**
 *      （`shared/session-dir.ts` 的 sessionDirOf 是路径规则的唯一出处）；否则唯一授权目录；
 *      多条并列又没指认默认 = 判不出。它决定**绝对路径的显示 / 复制**与附件"根内 → 相对路径"的判定
 *      （`absoluteOf` / `relativeInRoot`）—— 那些地方必须按主进程真正解析的根算，差一层目录就会把
 *      本该相对的文件显示成"根外的绝对路径"。
 *
 * 两套的差别只在一处：**无项目会话落在默认工作区下的子目录里时**，chip 要的是条目本身、真根要的是
 * 那个子目录。有项目的会话两者一致（都是项目目录）。
 *
 * 两条都只是**纯展示口径，不是安全边界**：真正的解析与 containment 在主进程，渲染端算出来的绝对路径
 * 不参与任何访问判定。权限切换只走既有的 `workspace:set-mode` 通道（主进程校验路径；full 在 UI 侧
 * 仍要确认）—— 这里不做任何写入，也不绕过审批语义（T13）。
 */

/** 目录名（Windows / POSIX 分隔符都认；给「引用上下文」的标签用） */
export function folderNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** 授权列表里与 path 同一条（归一后比较；没指认 / 不在列表里 = null） */
function authorizedOf(
  settings: Pick<AppSettings, 'workspaces'>,
  path: string | null | undefined
): Workspace | null {
  if (path === null || path === undefined || path === '') return null
  const normalized = normalizeWorkspacePath(path)
  return (
    settings.workspaces.find(
      (workspace) => normalizeWorkspacePath(workspace.path) === normalized
    ) ?? null
  )
}

/**
 * 指认过的默认工作区那条**授权条目**（指认过且还在授权列表里才有；与主进程同一套归一匹配）。
 * 无项目会话的根都从它派生（真根是它下面的会话子目录）。
 */
export function defaultWorkspaceEntryOf(
  settings: Pick<AppSettings, 'workspaces' | 'defaultWorkspace'>
): Workspace | null {
  return authorizedOf(settings, settings.defaultWorkspace)
}

/**
 * 当前会话在**授权列表里**的那条工作区 —— **权限 chip 专用**（见文件头注：它切的是条目的 mode，
 * 所以拿的是条目本身；无项目会话 = 默认工作区那条，不是会话子目录）。
 *
 * 取值顺序与 sessionRoots 一致：
 *   1. 会话属于某项目 → 项目目录对应的那条工作区；
 *   2. 否则默认工作区（设置了且还在授权列表里）；
 *   3. 否则：授权列表里**恰好一条**时用它；
 *   4. 判不出（没工作区 / 多条并列）→ null：调用方隐藏权限入口（别让用户以为在切一个说不清的范围）。
 */
export function sessionWorkspaceOf(input: {
  threadId: string | null
  settings: Pick<AppSettings, 'workspaces' | 'projects' | 'defaultWorkspace'>
  projectOf: (threadId: string | null) => string | null
}): Workspace | null {
  const { threadId, settings, projectOf } = input

  if (threadId !== null) {
    const projectId = projectOf(threadId)
    const project =
      projectId === null
        ? undefined
        : settings.projects.find((candidate) => candidate.id === projectId)
    const fromProject = authorizedOf(settings, project?.path)
    if (fromProject !== null) return fromProject
  }

  const fromDefault = defaultWorkspaceEntryOf(settings)
  if (fromDefault !== null) return fromDefault

  return settings.workspaces.length === 1 ? settings.workspaces[0] : null
}

/**
 * 当前会话的**真根绝对路径** —— 与主进程 `sessionRoots` 同序同值的只读镜像（见文件头注：
 * 复制路径 / 附件相对路径用它；**权限 chip 不用它**）。判不出唯一根时 null（调用方隐藏入口）。
 *
 * 无项目会话的根是**默认工作区下的会话子目录**（每会话一个，文件区 / 终端都落这里）；拿不到
 * threadId（还没载出会话）时退回默认工作区条目本身 —— 与主进程同一分支（那边也要求 threadId
 * 才收窄到子目录），两边算出的路径因此永远一致。
 */
export function sessionRootPathOf(input: {
  threadId: string | null
  settings: Pick<AppSettings, 'workspaces' | 'projects' | 'defaultWorkspace'>
  projectOf: (threadId: string | null) => string | null
}): string | null {
  const { threadId, settings, projectOf } = input
  const thread = threadId === null || threadId === '' ? null : threadId

  if (thread !== null) {
    const projectId = projectOf(thread)
    const project =
      projectId === null
        ? undefined
        : settings.projects.find((candidate) => candidate.id === projectId)
    const fromProject = authorizedOf(settings, project?.path)
    if (fromProject !== null) return fromProject.path
  }

  const fromDefault = defaultWorkspaceEntryOf(settings)
  if (fromDefault !== null) {
    return thread === null ? fromDefault.path : sessionDirOf(fromDefault.path, thread)
  }

  return settings.workspaces.length === 1 ? settings.workspaces[0].path : null
}
