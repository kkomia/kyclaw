import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { PluginsNavItem } from '../plugins/PluginsNavItem'
import { ProjectsSection } from '../projects/ProjectsSection'
import { useProjectsStore } from '../projects/projects-store'
import { NewSessionButton } from './NewSessionButton'
import { SessionList } from './SessionList'
import { composeSidebarSessions } from './sidebar-sessions'
import { useSessionsStore } from './sessions-store'

/**
 * 侧栏会话区（T9 起，T18 补项目区，round 20 补置顶/归档；round 24 会话动作抽到公共实现）：
 * 把 sessions-store 接到 SessionList / NewSessionButton 上。
 *
 * 三件事在这里做：
 *   1. 首屏拉一次会话列表（与对话页共用 ensureLoaded，重复调用会去重）；
 *   2. 中部插一段「项目」区（ProjectsSection，T18）——项目名下的会话在那边渲染；
 *   3. 维护"平铺区"的列表：**没有项目的会话**（含草稿）走「今天 / 更早」（口径见
 *      sidebar-sessions.composeSidebarSessions）；项目名下的会话不在这儿重复出现；
 *      归档的（settings.archivedThreads）不出现，置顶的（settings.pinnedThreads）排前。
 *
 * round 24：行尾 ⋯ 的菜单、重命名/删除对话框与动作接线（置顶/移至项目/文件资源管理器/归档）
 * 都搬进了 **SessionActionsMenu + useSessionActions**（对话页顶部栏共用同一份）——
 * 这里只把失败的一句话接到就地错误行（`session-action-error`），不再自己实现动作。
 *
 * 滚动：整个导航区（项目 + 平铺列表）共用一个滚动容器（Kimi 的侧栏也是整块滚）；
 * 「新建会话」固定在顶部不随滚动走。
 *
 * 列表加载失败不炸侧栏：错误行 + 重试（R11 的"顶部状态条"是后续任务，这里先就地）。
 */
export function SessionsController(): React.JSX.Element {
  const ensureLoaded = useSessionsStore((state) => state.ensureLoaded)
  const refresh = useSessionsStore((state) => state.refresh)
  const threads = useSessionsStore((state) => state.threads)
  const activeId = useSessionsStore((state) => state.activeId)
  const notices = useSessionsStore((state) => state.notices)
  const error = useSessionsStore((state) => state.error)
  const select = useSessionsStore((state) => state.select)
  const startNew = useSessionsStore((state) => state.startNew)

  const mappings = useProjectsStore((state) => state.mappings)
  const projects = useSettingsStore((state) => state.settings.projects)
  const archivedThreads = useSettingsStore((state) => state.settings.archivedThreads)
  const pinnedThreads = useSettingsStore((state) => state.settings.pinnedThreads)

  /** round 20：行动作失败的一行提示（与 project-error 同口径：显示原因，不静默） */
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const projectOf = useMemo(
    () => (threadId: string | null) => (threadId === null ? null : (mappings[threadId] ?? null)),
    [mappings]
  )
  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const archivedIds = useMemo(
    () => new Set(archivedThreads.map((entry) => entry.threadId)),
    [archivedThreads]
  )
  const pinnedIds = useMemo(() => new Set(pinnedThreads), [pinnedThreads])
  const sessions = useMemo(
    () =>
      composeSidebarSessions({ threads, activeId, projectOf, projectIds, archivedIds, pinnedIds })
        .ungrouped,
    [threads, activeId, projectOf, projectIds, archivedIds, pinnedIds]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NewSessionButton onNew={() => startNew(projectOf(activeId))} />
      <PluginsNavItem />
      {error !== null ? (
        <p data-testid="session-load-error" className="px-4 pb-1 text-c1 text-danger">
          会话列表加载失败
          <Button
            size="sm"
            variant="ghost"
            data-testid="session-load-retry"
            className="ml-1"
            onClick={() => {
              void refresh()
            }}
          >
            重试
          </Button>
        </p>
      ) : null}
      {actionError === null ? null : (
        <p data-testid="session-action-error" className="px-4 pb-1 text-c1 text-danger">
          {actionError}
        </p>
      )}
      {/* 整块导航共用一个滚动容器：项目区与平铺列表一起滚（列表自己的滚动关掉） */}
      <div data-testid="sidebar-nav-scroll" className="min-h-0 flex-1 overflow-y-auto">
        <ProjectsSection />
        <SessionList
          sessions={sessions}
          activeId={activeId}
          notices={notices}
          listClassName="min-h-0 overflow-visible"
          onSelect={select}
          pinnedIds={pinnedIds}
          onActionError={(message) => setActionError(message)}
        />
      </div>
    </div>
  )
}
