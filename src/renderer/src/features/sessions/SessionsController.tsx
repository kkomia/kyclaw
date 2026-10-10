import { useEffect, useMemo } from 'react'
import { Button } from '../../components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { ProjectsSection } from '../projects/ProjectsSection'
import { useProjectsStore } from '../projects/projects-store'
import { NewSessionButton } from './NewSessionButton'
import { SessionList } from './SessionList'
import { composeSidebarSessions } from './sidebar-sessions'
import { useSessionsStore } from './sessions-store'

/**
 * 侧栏会话区（T9 起，T18 补项目区）：把 sessions-store 接到 SessionList / NewSessionButton 上。
 *
 * 三件事在这里做：
 *   1. 首屏拉一次会话列表（与对话页共用 ensureLoaded，重复调用会去重）；
 *   2. 中部插一段「项目」区（ProjectsSection，T18）——项目名下的会话在那边渲染；
 *   3. 维护"平铺区"的列表：**没有项目的会话**（含草稿）走「今天 / 更早」（口径见
 *      sidebar-sessions.composeSidebarSessions）；项目名下的会话不在这儿重复出现。
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
  const remove = useSessionsStore((state) => state.remove)
  const rename = useSessionsStore((state) => state.rename)

  const mappings = useProjectsStore((state) => state.mappings)
  const projects = useSettingsStore((state) => state.settings.projects)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const projectOf = useMemo(
    () => (threadId: string | null) => (threadId === null ? null : (mappings[threadId] ?? null)),
    [mappings]
  )
  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const sessions = useMemo(
    () => composeSidebarSessions({ threads, activeId, projectOf, projectIds }).ungrouped,
    [threads, activeId, projectOf, projectIds]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NewSessionButton onNew={() => startNew(projectOf(activeId))} />
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
      {/* 整块导航共用一个滚动容器：项目区与平铺列表一起滚（列表自己的滚动关掉） */}
      <div data-testid="sidebar-nav-scroll" className="min-h-0 flex-1 overflow-y-auto">
        <ProjectsSection />
        <SessionList
          sessions={sessions}
          activeId={activeId}
          notices={notices}
          listClassName="min-h-0 overflow-visible"
          onSelect={select}
          onRename={(threadId, title) => {
            void rename(threadId, title)
          }}
          onDelete={(threadId) => {
            void remove(threadId)
          }}
        />
      </div>
    </div>
  )
}
