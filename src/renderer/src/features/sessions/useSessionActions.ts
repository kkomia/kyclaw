/**
 * 会话行动作（round 24 抽取）：侧栏行 ⋯ 与对话页顶部栏的名称菜单**共用这一份实现**——
 * 菜单项、重命名/删除对话框（SessionActionsMenu.tsx）和这里的动作接线都只有一处，
 * 两边的行为、错误文案与状态同步（都经 store）天然一致。
 *
 * 动作口径（与 round 20/22 的侧栏实现逐条对齐，只是搬了位置）：
 *   - 置顶：settings.pinnedThreads 整表替换（失败露给 onError）；
 *   - 移至项目 / 从项目中移除：T18 映射通道（projects-store.assignSession；失败回滚 + error 落在该项目区）；
 *   - 在文件资源管理器里打开：workspace:open-in-explorer（路径解析在主进程）；
 *   - 归档：写快照进 settings.archivedThreads，归档的是当前会话时把选中让给下一条可见会话；
 *   - 重命名 / 删除：sessions-store 的现成动作（删当前会话会连带切走）。
 *
 * round 26（可用性收口）：**草稿会话同一份口径，不灰**——置顶/归档/移至项目先经 `ensureThread`
 * 物化（sessions-store.materialize → POST /api/threads，与首条消息建线程同一条路）再执行；
 * 重命名/删除由 sessions-store 就地处理（草稿标题本地改 / 草稿本地丢弃）。
 * 唯一仍禁用的项：确实判不出任何工作区时的「在文件资源管理器里打开」（无从打开）。
 */
import { useCallback, useMemo } from 'react'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useSessionsStore } from './sessions-store'
import { useProjectsStore } from '../projects/projects-store'
import { sessionWorkspaceOf } from '../chat/session-workspace'

export interface SessionActionsContext {
  pinned: boolean
  /** 「移至项目 ▸」与「从 <项目> 中移除」用的项目清单 */
  projects: ReadonlyArray<{ id: string; name: string }>
  /**
   * 项目归属能力本版是否可用（0.2.1/PB-053：映射通道下架时 false →「移至项目」入口整体不出现）。
   * 缺省按可用处理（既有调用方/测试不传就是旧行为）。
   */
  projectsAvailable?: boolean
  /** 当前所属项目（null = 无项目；归属项目时才出「从…中移除」） */
  projectId: string | null
  /** 能不能在文件资源管理器里打开（判不出唯一工作区 = false → 菜单项禁用） */
  canOpenExplorer: boolean
}

export interface SessionActions {
  context: SessionActionsContext
  togglePin: (pinned: boolean) => void
  moveToProject: (projectId: string | null) => void
  openInExplorer: () => void
  archive: () => void
  rename: (title: string) => void
  remove: () => void
}

export interface SessionActionsOptions {
  threadId: string
  /** 归档快照用的标题（调用方给：侧栏行 = 行标题，顶部栏 = 会话标题；null = 还没生成） */
  title: string | null
  /** 失败的一句话（调用方决定露在哪：侧栏 = 就地错误行，顶部栏 = 菜单下方一行）；缺省只 console.error */
  onError?: (message: string) => void
}

export function useSessionActions(options: SessionActionsOptions): SessionActions {
  const { threadId, title } = options
  const settings = useSettingsStore((state) => state.settings)
  const mappings = useProjectsStore((state) => state.mappings)
  /**
   * 0.2.1（PB-053）：映射通道本版下架（501）→ 项目归属相关动作整体不提供。
   * 旧项目数据不做兼容/迁移：`移至项目` 在这时没有任何可生效的目标。
   */
  const projectsUnavailable = useProjectsStore((state) => state.unavailable)

  // onError 的失败文案出口（调用方决定露在哪）；作为依赖参与回调身份，不玩 ref 逃生舱
  const onError = options.onError
  const report = useCallback(
    (prefix: string, cause: unknown): void => {
      console.error(prefix, cause)
      // 展示前剥 IPC 包装（round 25：`Error invoking remote method …` 不进横幅）
      onError?.(unwrapIpcError(cause))
    },
    [onError]
  )

  const projects = useMemo(
    () =>
      projectsUnavailable
        ? []
        : settings.projects.map((project) => ({ id: project.id, name: project.name })),
    [settings.projects, projectsUnavailable]
  )
  const projectId = projectsUnavailable ? null : (mappings[threadId] ?? null)
  const canOpenExplorer = useMemo(
    () =>
      sessionWorkspaceOf({
        threadId,
        settings,
        projectOf: (id) => (id === null ? null : (mappings[id] ?? null))
      }) !== null,
    [threadId, settings, mappings]
  )

  /**
   * round 26：动作前的"草稿物化"——已在服务端的会话直接放行；草稿先物化成真实线程
   * （置顶/归档/移至项目都是"给服务端认识的东西记一笔"，把草稿 id 记上去等于悬空）。
   * 失败报一行并返回 false（动作就此不做，不静默）。
   */
  const ensureThread = useCallback(async (): Promise<boolean> => {
    const sessions = useSessionsStore.getState()
    if (sessions.threads.some((thread) => thread.id === threadId)) return true
    try {
      await sessions.materialize(threadId)
      return true
    } catch (cause) {
      report('[kyclaw] 创建会话失败', cause)
      return false
    }
  }, [threadId, report])

  const togglePin = useCallback(
    (pinned: boolean): void => {
      void ensureThread().then((ready) => {
        if (!ready) return
        const current = useSettingsStore.getState().settings.pinnedThreads
        const next = pinned
          ? [...current.filter((id) => id !== threadId), threadId]
          : current.filter((id) => id !== threadId)
        useSettingsStore
          .getState()
          .setPinnedThreads(next)
          .catch((cause: unknown) => report('[kyclaw] 置顶会话失败', cause))
      })
    },
    [threadId, report, ensureThread]
  )

  const moveToProject = useCallback(
    (nextProjectId: string | null): void => {
      // 本版映射通道下架：菜单入口已隐藏，这里也不做（不写、不假装成功）
      if (projectsUnavailable) return
      void ensureThread().then((ready) => {
        if (!ready) return
        // 失败由 projects-store 回滚 + 落 error（项目区那行）——与侧栏既有口径一致
        void useProjectsStore.getState().assignSession(threadId, nextProjectId)
      })
    },
    [threadId, ensureThread, projectsUnavailable]
  )

  const openInExplorer = useCallback((): void => {
    const api = window.kyclaw?.workspace
    if (api === undefined) return
    void api
      .openInExplorer(threadId)
      .catch((cause: unknown) => report('[kyclaw] 打开会话文件夹失败', cause))
  }, [threadId, report])

  const archive = useCallback((): void => {
    void ensureThread().then((ready) => {
      if (!ready) return
      const snapshot = {
        threadId,
        title,
        projectId: useProjectsStore.getState().projectOf(threadId),
        archivedAt: new Date().toISOString()
      }
      useSettingsStore
        .getState()
        .archiveThread(snapshot)
        .then(
          () => {
            // 归档的是当前会话：选中让给下一条可见会话（没有就开新草稿）
            const sessions = useSessionsStore.getState()
            if (sessions.activeId !== threadId) return
            const nowArchived = new Set(
              useSettingsStore.getState().settings.archivedThreads.map((entry) => entry.threadId)
            )
            const remaining = sessions.threads.filter((thread) => !nowArchived.has(thread.id))
            const next = remaining[0]
            if (next === undefined) sessions.startNew()
            else sessions.select(next.id)
          },
          (cause: unknown) => report('[kyclaw] 归档会话失败', cause)
        )
    })
  }, [threadId, title, report, ensureThread])

  const rename = useCallback(
    (nextTitle: string): void => {
      void useSessionsStore.getState().rename(threadId, nextTitle)
    },
    [threadId]
  )

  const remove = useCallback((): void => {
    void useSessionsStore.getState().remove(threadId)
  }, [threadId])

  return {
    context: {
      pinned: settings.pinnedThreads.includes(threadId),
      projects,
      projectsAvailable: !projectsUnavailable,
      projectId,
      canOpenExplorer
    },
    togglePin,
    moveToProject,
    openInExplorer,
    archive,
    rename,
    remove
  }
}
