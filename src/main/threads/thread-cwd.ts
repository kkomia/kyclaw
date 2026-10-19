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
}

export type ThreadCwdResolver = (threadId?: string) => string

export function createThreadCwdResolver(deps: ThreadCwdDeps): ThreadCwdResolver {
  return (threadId?: string): string => {
    if (threadId !== undefined && threadId !== '') {
      const projectId = deps.projectIdOf(threadId)
      if (projectId !== null) {
        const project = deps.projects().find((item) => item.id === projectId)
        if (project !== undefined && project.path.trim() !== '') return project.path
      }
    }
    return deps.defaultWorkspace() ?? deps.fallback
  }
}
