/**
 * PB-019/PB-024：thread → cwd 的唯一解析器（宿主侧，不依赖旧 Mastra store）。
 *
 * 现在 service 注入 `sessionProjects.get` / `projectsFor`；Kai 在 PB-020 删旧 store 时，
 * 只要换成新映射源（同样是 `projectIdOf` + `projects`）即可，不需要再改 threads/adapter。
 */
export interface ThreadCwdProject {
  id: string
  path: string
}

export interface ThreadCwdDeps {
  /** thread 所属 project id；没有映射回 null */
  projectIdOf: (threadId: string) => string | null
  projects: () => readonly ThreadCwdProject[]
  /** 默认工作区；没有配置回 null/undefined */
  defaultWorkspace: () => string | null | undefined
  /** 默认工作区也没有时的兜底（生产 = userData） */
  fallback: string
  /**
   * 0.2.2：内核里**已经存在**的会话 cwd（同步读 adapter 的内存映射；未知 = undefined）。
   *
   * 有值就以它为准：会话一旦在内核落盘，cwd 就是既成事实——项目被删/改名、或会话建在
   * 项目目录之外时，不能再用配置覆盖它（否则 adapter 的 create/reuse 冲突预检会判
   * `session/conflict`，删项目后的旧会话发消息必炸）。
   */
  knownCwdOf?: (threadId: string) => string | undefined
}

export type ThreadCwdResolver = (threadId?: string) => string

export function createThreadCwdResolver(deps: ThreadCwdDeps): ThreadCwdResolver {
  return (threadId?: string): string => {
    if (threadId !== undefined && threadId !== '') {
      // 0.2.2：已存在的内核会话以它自己的 cwd 为准（见 knownCwdOf 的注释）
      const known = deps.knownCwdOf?.(threadId)
      if (known !== undefined && known.trim() !== '') return known
      const projectId = deps.projectIdOf(threadId)
      if (projectId !== null) {
        const project = deps.projects().find((item) => item.id === projectId)
        if (project !== undefined && project.path.trim() !== '') return project.path
      }
    }
    return deps.defaultWorkspace() ?? deps.fallback
  }
}
