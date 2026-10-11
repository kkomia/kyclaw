import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Project } from '@shared/projects'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { sessionWorkspaceOf } from '../chat/session-workspace'
import { useSessionsStore } from '../sessions/sessions-store'
import { composeSidebarSessions } from '../sessions/sidebar-sessions'
import { CreateProjectDialog, type CreateProjectMode } from './CreateProjectDialog'
import { ProjectList } from './ProjectList'
import { useProjectsStore } from './projects-store'

/**
 * 侧栏「项目」区的接线（T18）：把 settings（项目清单）/ projects-store（会话归属）/ sessions-store
 * （会话本体）三份数据拼成 ProjectList 要的形状，并管住三件事：
 *   1. 首屏拉一次映射（与会话列表并行；失败只在区里落一行错误，不炸侧栏）；
 *   2. **点项目行 = 展开/折叠名下会话**（round 16 用户实拍改口：不再"点开一个新会话"——
 *      折叠状态由 ProjectList 自己按 id 记忆；在这个项目里开会话走创建对话框的收尾）；
 *   3. 建项目（两路入口 → 同一个对话框）与删项目（连带把名下会话的归属摘掉）的收尾。
 */
export function ProjectsSection(): React.JSX.Element {
  const navigate = useNavigate()
  const projects = useSettingsStore((state) => state.settings.projects)
  const removeProject = useSettingsStore((state) => state.removeProject)

  const threads = useSessionsStore((state) => state.threads)
  const activeId = useSessionsStore((state) => state.activeId)
  const notices = useSessionsStore((state) => state.notices)
  const select = useSessionsStore((state) => state.select)
  const startNew = useSessionsStore((state) => state.startNew)
  const rename = useSessionsStore((state) => state.rename)
  const remove = useSessionsStore((state) => state.remove)

  const mappings = useProjectsStore((state) => state.mappings)
  const ensureLoaded = useProjectsStore((state) => state.ensureLoaded)
  const error = useProjectsStore((state) => state.error)
  const clearProjectMappings = useProjectsStore((state) => state.clearProjectMappings)

  const settings = useSettingsStore((state) => state.settings)
  const archivedThreads = settings.archivedThreads
  const pinnedThreads = settings.pinnedThreads

  const [dialog, setDialog] = useState<{ mode: CreateProjectMode; key: number } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const projectOf = useMemo(
    () => (threadId: string | null) => (threadId === null ? null : (mappings[threadId] ?? null)),
    [mappings]
  )
  // round 20：归档的会话不出现在任何分组；置顶的在项目桶里也排最前
  const archivedIds = useMemo(
    () => new Set(archivedThreads.map((entry) => entry.threadId)),
    [archivedThreads]
  )
  const pinnedIds = useMemo(() => new Set(pinnedThreads), [pinnedThreads])

  const { byProject } = useMemo(
    () =>
      composeSidebarSessions({
        threads,
        activeId,
        projectOf,
        projectIds,
        archivedIds,
        pinnedIds
      }),
    [threads, activeId, projectOf, projectIds, archivedIds, pinnedIds]
  )

  /** round 20：项目名下的会话行工具（与会话平铺区同口径；动作在 SessionsController/这里各自接线） */
  const canOpenExplorerOf = useMemo(
    () => (threadId: string) => sessionWorkspaceOf({ threadId, settings, projectOf }) !== null,
    [settings, projectOf]
  )

  const togglePin = (threadId: string, pinned: boolean): void => {
    const current = useSettingsStore.getState().settings.pinnedThreads
    const next = pinned
      ? [...current.filter((id) => id !== threadId), threadId]
      : current.filter((id) => id !== threadId)
    setActionError(null)
    useSettingsStore
      .getState()
      .setPinnedThreads(next)
      .catch((cause: unknown) => {
        console.error('[kyclaw] 置顶会话失败', cause)
        setActionError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const moveToProject = (threadId: string, projectId: string | null): void => {
    void useProjectsStore.getState().assignSession(threadId, projectId)
  }

  const openInExplorer = (threadId: string): void => {
    const api = window.kyclaw?.workspace
    if (api === undefined) return
    setActionError(null)
    void api.openInExplorer(threadId).catch((cause: unknown) => {
      console.error('[kyclaw] 打开会话文件夹失败', cause)
      setActionError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  /** 归档：快照此刻的标题与项目，行从项目桶里消失（数据不删；取消归档回原项目） */
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
        (cause: unknown) => {
          console.error('[kyclaw] 归档会话失败', cause)
          setActionError(cause instanceof Error ? cause.message : String(cause))
        }
      )
  }

  /** 在这个项目里开一个新会话（round 16 起只有"项目刚建好"这一条路走它） */
  const openSessionIn = (projectId: string | null): void => {
    startNew(projectId)
    navigate('/chat')
  }

  const onDeleteProject = (project: Project): void => {
    setActionError(null)
    removeProject(project.id).then(
      () => {
        // 项目没了，名下会话的归属也摘掉（否则它们会"挂在"一个不存在的项目上，虽然后备逻辑能兜住）
        void clearProjectMappings(project.id)
      },
      (cause: unknown) => {
        console.error('[kyclaw] 删除项目失败', cause)
        setActionError(cause instanceof Error ? cause.message : String(cause))
      }
    )
  }

  return (
    <div className="shrink-0">
      <ProjectList
        projects={projects}
        sessionsOf={(projectId) => byProject[projectId] ?? []}
        activeSessionId={activeId}
        notices={notices}
        onSelectSession={(threadId) => {
          select(threadId)
          navigate('/chat')
        }}
        onRenameSession={(threadId, title) => {
          void rename(threadId, title)
        }}
        onDeleteSession={(threadId) => {
          void remove(threadId)
        }}
        onDeleteProject={onDeleteProject}
        onCreateBlank={() => setDialog({ mode: 'blank', key: Date.now() })}
        onCreateFolder={() => setDialog({ mode: 'folder', key: Date.now() })}
        pinnedIds={pinnedIds}
        projectIdOf={projectOf}
        canOpenExplorerOf={canOpenExplorerOf}
        onTogglePin={togglePin}
        onMoveToProject={moveToProject}
        onOpenInExplorer={openInExplorer}
        onArchive={archive}
      />

      {error === null && actionError === null ? null : (
        <p data-testid="project-error" className="px-4 pb-1 text-c1 text-danger">
          {actionError ?? '项目加载失败'}
          <Button
            size="sm"
            variant="ghost"
            data-testid="project-retry"
            className="ml-1"
            onClick={() => {
              setActionError(null)
              void useProjectsStore.getState().refresh()
            }}
          >
            重试
          </Button>
        </p>
      )}

      <CreateProjectDialog
        key={dialog?.key ?? 'closed'}
        open={dialog !== null}
        mode={dialog?.mode ?? 'blank'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        onCreated={(projectId) => {
          openSessionIn(projectId)
        }}
      />
    </div>
  )
}
