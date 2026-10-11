import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { PluginsNavItem } from '../plugins/PluginsNavItem'
import { ProjectsSection } from '../projects/ProjectsSection'
import { useProjectsStore } from '../projects/projects-store'
import { sessionWorkspaceOf } from '../chat/session-workspace'
import { NewSessionButton } from './NewSessionButton'
import { SessionList } from './SessionList'
import { composeSidebarSessions } from './sidebar-sessions'
import { useSessionsStore } from './sessions-store'

/**
 * 侧栏会话区（T9 起，T18 补项目区，round 20 补置顶/归档）：
 * 把 sessions-store 接到 SessionList / NewSessionButton 上。
 *
 * 四件事在这里做：
 *   1. 首屏拉一次会话列表（与对话页共用 ensureLoaded，重复调用会去重）；
 *   2. 中部插一段「项目」区（ProjectsSection，T18）——项目名下的会话在那边渲染；
 *   3. 维护"平铺区"的列表：**没有项目的会话**（含草稿）走「今天 / 更早」（口径见
 *      sidebar-sessions.composeSidebarSessions）；项目名下的会话不在这儿重复出现；
 *      round 20：归档的（settings.archivedThreads）不出现，置顶的（settings.pinnedThreads）排前；
 *   4. 会话行的新动作（round 20）：置顶 / 移至项目 / 在文件资源管理器中打开 / 归档。
 *      写设置与打通道的失败都露成一行人话（`session-action-error`），不静默吞。
 *      「在新窗口打开」没做（单窗口架构，见 round 20 报告）。
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
  const archivedThreads = useSettingsStore((state) => state.settings.archivedThreads)
  const pinnedThreads = useSettingsStore((state) => state.settings.pinnedThreads)
  const settings = useSettingsStore((state) => state.settings)

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

  /** 会话行工具：这个会话能不能在文件资源管理器里打开（判不出唯一工作区 = 菜单项禁用） */
  const canOpenExplorerOf = useMemo(
    () => (threadId: string) => sessionWorkspaceOf({ threadId, settings, projectOf }) !== null,
    [settings, projectOf]
  )

  const reportActionError = (prefix: string, cause: unknown): void => {
    console.error(prefix, cause)
    setActionError(cause instanceof Error ? cause.message : String(cause))
  }

  /** 置顶 / 取消置顶（round 20）：整表替换 pinnedThreads；失败露一行 */
  const togglePin = (threadId: string, pinned: boolean): void => {
    const current = useSettingsStore.getState().settings.pinnedThreads
    const next = pinned
      ? [...current.filter((id) => id !== threadId), threadId]
      : current.filter((id) => id !== threadId)
    setActionError(null)
    useSettingsStore
      .getState()
      .setPinnedThreads(next)
      .catch((cause: unknown) => reportActionError('[kyclaw] 置顶会话失败', cause))
  }

  /** 移至项目（round 20）：沿用 T18 的映射通道（失败由 projects-store 回滚 + 露在项目区） */
  const moveToProject = (threadId: string, projectId: string | null): void => {
    void useProjectsStore.getState().assignSession(threadId, projectId)
  }

  /** 在文件资源管理器中打开（round 20）：路径解析在主进程（workspace:open-in-explorer） */
  const openInExplorer = (threadId: string): void => {
    const api = window.kyclaw?.workspace
    if (api === undefined) return
    setActionError(null)
    void api
      .openInExplorer(threadId)
      .catch((cause: unknown) => reportActionError('[kyclaw] 打开会话文件夹失败', cause))
  }

  /**
   * 归档（round 20）：写快照进 settings（标题/项目按**此刻**的值），行随之从侧栏消失；
   * **不删会话数据**（服务端线程与消息原样留着，取消归档就回来）。
   * 归档的是当前会话时，把选中让给下一条可见会话（没有就开新草稿）——
   * 还在跑的流不受影响（Chat 实例在注册表里，切回来能看完）。
   */
  const archive = (threadId: string): void => {
    const listed = threads.find((thread) => thread.id === threadId)
    const snapshot = {
      threadId,
      title: listed?.title ?? null,
      projectId: projectOf(threadId),
      archivedAt: new Date().toISOString()
    }
    setActionError(null)
    useSettingsStore
      .getState()
      .archiveThread(snapshot)
      .then(
        () => {
          if (useSessionsStore.getState().activeId !== threadId) return
          const nowArchived = new Set(
            useSettingsStore.getState().settings.archivedThreads.map((entry) => entry.threadId)
          )
          const remaining = useSessionsStore
            .getState()
            .threads.filter((thread) => !nowArchived.has(thread.id))
          const next = remaining[0]
          if (next === undefined) startNew()
          else select(next.id)
        },
        (cause: unknown) => reportActionError('[kyclaw] 归档会话失败', cause)
      )
  }

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
          onRename={(threadId, title) => {
            void rename(threadId, title)
          }}
          onDelete={(threadId) => {
            void remove(threadId)
          }}
          pinnedIds={pinnedIds}
          projects={projects.map((project) => ({ id: project.id, name: project.name }))}
          projectIdOf={projectOf}
          canOpenExplorerOf={canOpenExplorerOf}
          onTogglePin={togglePin}
          onMoveToProject={moveToProject}
          onOpenInExplorer={openInExplorer}
          onArchive={archive}
        />
      </div>
    </div>
  )
}
