/**
 * 项目工作区（T18）：项目清单的纯函数操作 + **会话根**的解析口径。
 *
 * 清单落 settings.json 的 `projects` 字段（形状在 shared/projects.ts），与 workspaces 同一套写法：
 *   1. **入清单前必过 `checkWorkspacePath`**（存在、是目录、非 UNC，回 realpath 归一后的写法）——
 *      与授权目录同源校验，见 main/ipc/projects.ts；
 *   2. 建项目时把项目路径**并进授权列表**（模式 ask，`addWorkspace` 的既有口径）——文件工具的
 *     边界判定（permission/realpath.ts）只认授权列表，项目路径不进列表就等于不能读写；
 *     模式一律 ask：full 仍然只能由用户在设置页里对已授权目录显式切换（T13 收紧的口径）。
 *
 * 会话根（`sessionRoots`）——"这个会话的文件工具能碰哪儿"：
 *   - 会话属于某项目（session_projects 映射）→ 就是那个项目的路径（那条授权条目本身）；
 *   - 没项目 → **默认工作区下的会话子目录**（round 55，对齐 Kimi Work 的 tasks/ 形态）：
 *     默认工作区只是"产房"，每个无项目会话在其中占一个自己的子目录（`shared/session-dir.ts`
 *     是路径规则的唯一出处），文件工具根 / 文件区 / 终端 / @ 清单都落这里；
 *     拿不到 threadId（纯函数调用、没有会话的通道）时退回默认工作区条目本身；
 *   - 默认工作区也没指认 → 整份授权列表（T10 既有口径，行为不变）。
 * 返回的是**授权列表的子集**（带它的 mode）：项目那条是列表里的原条目；无项目时是它的合成子条目
 * ——路径收窄到该条目之下、mode 原样继承（丢 mode 会让「完全访问」的工作区重新弹审批，
 * 见 tools/guard.ts 的 noTargetFullExempt）。模式/规则语义因此与全局一致 ——
 * 执行层用这个子集解析（fail closed），审批层用整份授权列表解析（超集，见 tools/guard.ts 的
 * needsApproval 头注：框架的 requireApproval 回调拿不到会话，取保守方向）。
 * 项目/默认工作区若已从授权列表里被移除（用户取消过授权）就在那一层不命中、继续往下兜底，
 * 一路兜不到才用整份授权列表 —— 无论哪条路，返回的都是授权列表的子集：**收窄不会越权**。
 */
import { join } from 'node:path'
import type { Project } from '../shared/projects'
import { sessionDirOf } from '../shared/session-dir'
import type { Workspace } from '../shared/settings'
import { addWorkspace, samePath } from './workspace'

/**
 * 项目名的问题（为 null = 可用）：非空 + 不能带路径分隔符/Windows 保留字符 —— 它会同时当
 * 显示名和"空白项目"的目录名用，带分隔符会让默认路径跑到别处去。
 */
export function projectNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return '项目名称不能为空'
  if (/[\\/:*?"<>|]/.test(trimmed)) return '项目名称不能包含 \\ / : * ? " < > | 这些字符'
  return null
}

/** 空白项目的默认目录：默认工作区基底（没指认时用兜底基底，来自 main/ipc/projects.ts）下的同名子目录 */
export function projectDefaultPath(base: string, name: string): string {
  return join(base, name.trim())
}

/** 按路径找项目（Windows：大小写/分隔符不敏感）——同一个文件夹不重复建项目 */
export function findProjectByPath(projects: readonly Project[], path: string): Project | null {
  return projects.find((project) => samePath(project.path, path)) ?? null
}

/** 追加一个项目（重复路径先经 findProjectByPath 拦下，这里只做纯追加） */
export function addProject(projects: readonly Project[], project: Project): Project[] {
  return [...projects, project]
}

/** 移除一个项目（id 不存在就是空操作）；**不动磁盘、也不动授权列表**——项目目录与它的授权都是用户的 */
export function removeProject(projects: readonly Project[], id: string): Project[] {
  return projects.filter((project) => project.id !== id)
}

/**
 * 指认默认工作区（workspace:pick-default 的实现，调用方已过 `checkWorkspacePath`）：
 * 选中目录以 ask 并进授权列表，再写 `defaultWorkspace` —— 记的是**授权列表里那条的写法**
 * （重选同一个目录的不同写法不该在设置里变成另一个字符串）。返回的是要落盘的补丁。
 */
export function defaultWorkspacePatch(
  current: { workspaces: readonly Workspace[]; defaultWorkspace: string | null },
  path: string
): { workspaces: Workspace[]; defaultWorkspace: string } {
  const workspaces = addWorkspace(current.workspaces, path)
  const entry = workspaces.find((candidate) => samePath(candidate.path, path))
  return { workspaces, defaultWorkspace: entry?.path ?? path }
}

/**
 * 移除一个工作区时应一并做的善后：被移除的那条就是默认工作区 → 一并清空指认
 * （否则设置里留一个已不在授权列表里的默认工作区，会话根会静默回退到整份列表，说不清）。
 */
export function defaultWorkspaceAfterRemoval(
  current: { defaultWorkspace: string | null },
  path: string
): string | null {
  if (current.defaultWorkspace === null) return null
  return samePath(current.defaultWorkspace, path) ? null : current.defaultWorkspace
}

/** 会话根解析的输入（全部现读：设置与映射中途变，下一轮工具调用就跟着变） */
export interface SessionRootsInput {
  workspaces: readonly Workspace[]
  defaultWorkspace: string | null
  projects: readonly Project[]
  /** 会话所属项目 id（session_projects 映射；没有映射 = null） */
  projectId: string | null | undefined
  /** 会话（agent 线程）id：无项目会话的根是它算出来的子目录（见 shared/session-dir.ts） */
  threadId?: string | null
}

/** 解析的副作用开关（缺省全无 —— 不传就是纯函数，单测按纯函数用） */
export interface SessionRootsOptions {
  /**
   * 建出会话子目录。只在"无项目会话落在默认工作区下的子目录"这条分支上调用一次：
   * 引擎（permission/realpath.ts 的 realRoot）要求根本身存在且是目录，不先建出来所有文件工具
   * 都会报"工作区不存在或不是目录"。生产传 main/workspace.ts 的 ensureSessionDir（同步、幂等）。
   */
  ensureDir?: (path: string) => void
}

/**
 * 会话的可写根（见文件头注）。项目/默认工作区都必须在授权列表里才生效——列表是授权边界的
 * 唯一事实来源；命中不了就继续往下兜底，一路兜不到就用整份授权列表。
 */
export function sessionRoots(
  input: SessionRootsInput,
  options?: SessionRootsOptions
): readonly Workspace[] {
  const { workspaces, defaultWorkspace, projects, projectId, threadId } = input

  if (typeof projectId === 'string' && projectId !== '') {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (project !== undefined) {
      const workspace = workspaces.find((candidate) => samePath(candidate.path, project.path))
      if (workspace !== undefined) return [workspace]
    }
  }

  if (typeof defaultWorkspace === 'string' && defaultWorkspace !== '') {
    const workspace = workspaces.find((candidate) => samePath(candidate.path, defaultWorkspace))
    if (workspace !== undefined) {
      // 无项目会话（round 55）：根 = 该条目下的会话子目录。合成条目**继承条目的 mode** ——
      // 收窄的是路径，不是访问模式（full 的工作区不该因为多了 tasks/ 这一层就重新弹审批）
      if (typeof threadId === 'string' && threadId !== '') {
        const path = sessionDirOf(workspace.path, threadId)
        options?.ensureDir?.(path)
        return [{ path, mode: workspace.mode }]
      }
      return [workspace]
    }
  }

  return workspaces
}
