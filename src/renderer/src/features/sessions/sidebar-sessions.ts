/**
 * 侧栏会话的分组（T18；round 20 加归档过滤与置顶排序）：把服务端会话列表按"项目 / 无项目"分桶。
 *
 * 纯函数（可单测）：输入会话列表 + 当前会话 + 会话→项目映射 + 现存项目集合，输出两个桶：
 *   - `byProject[projectId]`：这个项目名下的会话（含"还没发过消息的草稿"）；
 *   - `ungrouped`：没有项目的会话（含草稿）——去侧栏的「今天 / 更早」区。
 * 映射指向一个**已经删掉**的项目时按"没有项目"处理（映射清理由 store 尽力做，这里兜底）。
 *
 * round 20 两条口径：
 *   - `archivedIds` 里的会话**整个不出现**（归档 = 从侧栏移除；数据不删，见 settings.archivedThreads）；
 *   - `pinnedIds` 里的会话在各自桶里**排最前**（相对顺序保持稳定）——平铺区由 SessionList
 *     把它们单独提在最上面（时间分组之上），项目桶里则是桶内前缀。
 *
 * 排序沿用服务端给的顺序（updatedAt DESC）；草稿永远排在自己那个桶的最前（置顶的排草稿后面）。
 * round 26：草稿的显示标题从 `draftTitle` 进来（就地重命名改的是它；服务端物化后由服务端标题接管）。
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
  /** round 20：已归档的会话 id（整条不出现；缺省 = 没有归档） */
  archivedIds?: ReadonlySet<string>
  /** round 20：置顶的会话 id（桶内排最前；缺省 = 没有置顶） */
  pinnedIds?: ReadonlySet<string>
  /** round 26：草稿的本地标题（"就地重命名"改的就是它；缺省 = 列表回落"新会话"占位） */
  draftTitle?: string | null
}

export interface SidebarSessions {
  byProject: Record<string, SessionListEntry[]>
  ungrouped: SessionListEntry[]
}

export function composeSidebarSessions(input: SidebarSessionsInput): SidebarSessions {
  const { threads, activeId, projectOf, projectIds } = input
  const archivedIds = input.archivedIds ?? new Set<string>()
  const pinnedIds = input.pinnedIds ?? new Set<string>()
  const byProject: Record<string, SessionListEntry[]> = {}
  const ungrouped: SessionListEntry[] = []

  const draft: SessionListEntry | null =
    activeId !== null && !threads.some((thread) => thread.id === activeId)
      ? {
          id: activeId,
          // round 26：草稿被就地重命名过就显示本地标题（draftTitle），否则回落"新会话"占位
          title: input.draftTitle ?? null,
          updatedAt: new Date().toISOString(),
          draft: true
        }
      : null

  const entries: SessionListEntry[] = draft === null ? [...threads] : [draft, ...threads]
  const visible = entries.filter((entry) => !archivedIds.has(entry.id))

  // 顺序：草稿最前（T18 口径不动）→ 置顶（stable：保持服务端 updatedAt DESC）→ 其余
  const ordered = [
    ...visible.filter((entry) => entry.draft === true),
    ...visible.filter((entry) => entry.draft !== true && pinnedIds.has(entry.id)),
    ...visible.filter((entry) => entry.draft !== true && !pinnedIds.has(entry.id))
  ]

  for (const entry of ordered) {
    const projectId = projectOf(entry.id)
    if (projectId !== null && projectIds.has(projectId)) {
      ;(byProject[projectId] ??= []).push(entry)
    } else {
      ungrouped.push(entry)
    }
  }

  return { byProject, ungrouped }
}
