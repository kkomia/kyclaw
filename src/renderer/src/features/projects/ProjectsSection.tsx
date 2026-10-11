import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Project } from '@shared/projects'
import { Button } from '@renderer/components/ui/button'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useSessionsStore } from '../sessions/sessions-store'
import { composeSidebarSessions } from '../sessions/sidebar-sessions'
import { CreateProjectDialog, type CreateProjectMode } from './CreateProjectDialog'
import { ProjectList } from './ProjectList'
import { useProjectsStore } from './projects-store'

/**
 * 侧栏「项目」区的接线（T18；round 25 补行尾动作与归档）：把 settings（项目清单）/ projects-store
 * （会话归属）/ sessions-store（会话本体）三份数据拼成 ProjectList 要的形状，并管住：
 *   1. 首屏拉一次映射（与会话列表并行；失败只在区里落一行错误，不炸侧栏）；
 *   2. **点项目行 = 展开/折叠名下会话**（round 16 口径）；**⊕ = 在这个项目下开新会话**（round 25）；
 *   3. 建项目 / 删项目（连带摘会话归属）与 round 25 的行尾动作：置顶项目（settings.pinnedProjects，
 *      置顶排前）、在文件资源管理器中打开（projects:open-in-explorer）、重命名项目（projects:rename）、
 *      归档项目（settings.archivedProjects——侧栏隐藏该项目**及其会话**，取消归档一并回来）；
 *   4. 动作失败露在 `project-error` 一行（round 25 起经 unwrapIpcError 剥 IPC 包装）。
 */
export function ProjectsSection(): React.JSX.Element {
  const navigate = useNavigate()
  const settings = useSettingsStore((state) => state.settings)
  const removeProject = useSettingsStore((state) => state.removeProject)
  const setPinnedProjects = useSettingsStore((state) => state.setPinnedProjects)
  const archiveProject = useSettingsStore((state) => state.archiveProject)

  const threads = useSessionsStore((state) => state.threads)
  const activeId = useSessionsStore((state) => state.activeId)
  const notices = useSessionsStore((state) => state.notices)
  const draftTitles = useSessionsStore((state) => state.draftTitles)
  const select = useSessionsStore((state) => state.select)
  const startNew = useSessionsStore((state) => state.startNew)

  const mappings = useProjectsStore((state) => state.mappings)
  const ensureLoaded = useProjectsStore((state) => state.ensureLoaded)
  const error = useProjectsStore((state) => state.error)
  const clearProjectMappings = useProjectsStore((state) => state.clearProjectMappings)

  const [dialog, setDialog] = useState<{ mode: CreateProjectMode; key: number } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const archivedProjectIds = useMemo(
    () => new Set(settings.archivedProjects.map((entry) => entry.projectId)),
    [settings.archivedProjects]
  )
  // round 25：归档的项目整条（连同名下会话）不出现；置顶的项目排前（stable）
  const visibleProjects = useMemo(() => {
    const visible = settings.projects.filter((project) => !archivedProjectIds.has(project.id))
    const pinned = new Set(settings.pinnedProjects)
    return [
      ...visible.filter((project) => pinned.has(project.id)),
      ...visible.filter((project) => !pinned.has(project.id))
    ]
  }, [settings.projects, settings.pinnedProjects, archivedProjectIds])
  const pinnedProjectIds = useMemo(
    () => new Set(settings.pinnedProjects),
    [settings.pinnedProjects]
  )

  const projectIds = useMemo(
    () => new Set(settings.projects.map((project) => project.id)),
    [settings.projects]
  )
  const projectOf = useMemo(
    () => (threadId: string | null) => (threadId === null ? null : (mappings[threadId] ?? null)),
    [mappings]
  )
  const archivedIds = useMemo(
    () => new Set(settings.archivedThreads.map((entry) => entry.threadId)),
    [settings.archivedThreads]
  )
  const pinnedIds = useMemo(() => new Set(settings.pinnedThreads), [settings.pinnedThreads])

  const { byProject } = useMemo(
    () =>
      composeSidebarSessions({
        threads,
        activeId,
        projectOf,
        projectIds,
        archivedIds,
        pinnedIds,
        draftTitle: activeId === null ? null : (draftTitles[activeId] ?? null)
      }),
    [threads, activeId, projectOf, projectIds, archivedIds, pinnedIds, draftTitles]
  )

  const report = (prefix: string, cause: unknown): void => {
    console.error(prefix, cause)
    setActionError(unwrapIpcError(cause))
  }

  /** 在这个项目里开一个新会话（round 25 的 ⊕ 与"项目刚建好"两条路共用） */
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
      (cause: unknown) => report('[kyclaw] 删除项目失败', cause)
    )
  }

  /** 置顶项目（toggle）：整表替换 pinnedProjects；置顶的排前 */
  const onTogglePinProject = (projectId: string, pinned: boolean): void => {
    const current = useSettingsStore.getState().settings.pinnedProjects
    const next = pinned
      ? [...current.filter((id) => id !== projectId), projectId]
      : current.filter((id) => id !== projectId)
    setActionError(null)
    setPinnedProjects(next).catch((cause: unknown) => report('[kyclaw] 置顶项目失败', cause))
  }

  /** 在文件资源管理器中打开项目目录（路径在主进程按 id 解析） */
  const onOpenProjectInExplorer = (projectId: string): void => {
    const api = window.kyclaw?.projects
    if (api === undefined) return
    setActionError(null)
    void api
      .openInExplorer(projectId)
      .catch((cause: unknown) => report('[kyclaw] 打开项目文件夹失败', cause))
  }

  const onRenameProject = (projectId: string, name: string): void => {
    const api = window.kyclaw?.projects
    if (api === undefined) return
    setActionError(null)
    api.rename(projectId, name).then(
      (next) => useSettingsStore.setState({ settings: next }),
      (cause: unknown) => report('[kyclaw] 重命名项目失败', cause)
    )
  }

  /** 归档项目：写快照（名称/路径/时间）→ 侧栏隐藏该项目及其会话；取消归档一并回来 */
  const onArchiveProject = (projectId: string): void => {
    const project = settings.projects.find((candidate) => candidate.id === projectId)
    if (project === undefined) return
    setActionError(null)
    archiveProject({
      projectId,
      name: project.name,
      path: project.path,
      archivedAt: new Date().toISOString()
    }).catch((cause: unknown) => report('[kyclaw] 归档项目失败', cause))
  }

  return (
    <div className="shrink-0">
      <ProjectList
        projects={visibleProjects}
        sessionsOf={(projectId) => byProject[projectId] ?? []}
        activeSessionId={activeId}
        notices={notices}
        pinnedProjectIds={pinnedProjectIds}
        onSelectSession={(threadId) => {
          select(threadId)
          navigate('/chat')
        }}
        onDeleteProject={onDeleteProject}
        onTogglePinProject={onTogglePinProject}
        onOpenProjectInExplorer={onOpenProjectInExplorer}
        onRenameProject={onRenameProject}
        onArchiveProject={onArchiveProject}
        onCreateSession={(projectId) => openSessionIn(projectId)}
        onCreateBlank={() => setDialog({ mode: 'blank', key: Date.now() })}
        onCreateFolder={() => setDialog({ mode: 'folder', key: Date.now() })}
        pinnedIds={pinnedIds}
        onActionError={(message) => setActionError(message)}
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
