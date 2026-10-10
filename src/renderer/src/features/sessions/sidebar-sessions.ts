/**
 * 侧栏会话的分组（T18）：把服务端会话列表按"项目 / 无项目"分桶。
 *
 * 纯函数（可单测）：输入会话列表 + 当前会话 + 会话→项目映射 + 现存项目集合，输出两个桶：
 *   - `byProject[projectId]`：这个项目名下的会话（含"还没发过消息的草稿"）；
 *   - `ungrouped`：没有项目的会话（含草稿）——去侧栏的「今天 / 更早」区。
 * 映射指向一个**已经删掉**的项目时按"没有项目"处理（映射清理由 store 尽力做，这里兜底）。
 *
 * 排序沿用服务端给的顺序（updatedAt DESC）；草稿永远排在自己那个桶的最前。
 */
import type { ThreadSummary } from '@shared/threads'
import type { SessionListEntry } from '../sessions/SessionList'

export interface SidebarSessionsInput {
  threads: readonly ThreadSummary[]
  /** 当前会话 id（可能是还没落成线程的草稿） */
  activeId: string | null
  /** 会话 → 项目 id（没有 = null） */
  projectOf: (threadId: string) => string | null
  /** 现存项目的 id 集合（映射指向已删项目 → 当没有项目） */
  projectIds: ReadonlySet<string>
}

export interface SidebarSessions {
  byProject: Record<string, SessionListEntry[]>
  ungrouped: SessionListEntry[]
}

export function composeSidebarSessions(input: SidebarSessionsInput): SidebarSessions {
  const { threads, activeId, projectOf, projectIds } = input
  const byProject: Record<string, SessionListEntry[]> = {}
  const ungrouped: SessionListEntry[] = []

  const draft: SessionListEntry | null =
    activeId !== null && !threads.some((thread) => thread.id === activeId)
      ? { id: activeId, title: null, updatedAt: new Date().toISOString(), draft: true }
      : null

  for (const entry of draft === null ? threads : [draft, ...threads]) {
    const projectId = projectOf(entry.id)
    if (projectId !== null && projectIds.has(projectId)) {
      ;(byProject[projectId] ??= []).push(entry)
    } else {
      ungrouped.push(entry)
    }
  }

  return { byProject, ungrouped }
}
