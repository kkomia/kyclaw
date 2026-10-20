/**
 * 项目状态（T18；0.2.2 起映射改为从内核 cwd 推导）：会话↔项目归属 + 「当前项目」的推导，
 * 侧栏项目区与新建会话共用一份。
 *
 * 口径（0.2.2，旧映射 HTTP API 在 0.2.x 主动下架成 501 之后）：
 *   - 会话归属项目的**唯一事实来源是内核 session 的 cwd**（`session/list` 的 `items[].cwd`，
 *     经 `GET /api/threads` 回到线程列表）；`unavailable`（501）时 `mappings` 不再镜像服务端映射表，
 *     而是由 `syncFromCwd(threads)` 用"cwd + settings.projects 的路径包含关系"推导出来
 *     （归一化/最长匹配见 project-cwd.ts）。会话列表刷新、项目增删改之后都要重算一次
 *     —— 调用点在 sessions-store（列表）与 ProjectsSection（项目清单 / 501 落位）。
 *   - `unavailable` 仍保留 true：它表达的是"写映射这条通道本版没有"，依赖写映射的入口
 *     （选择项目胶囊、移至项目、归档页项目分区）继续隐藏/禁用，保持 PB-053 无红字的纪律；
 *     但**侧栏「项目」区恢复渲染**（组头 / 管理菜单 / 空态 / 按 cwd 归组），不再整块消失。
 *   - **新建会话落项目**：草稿先经 `rememberDraftProject` 记一笔本地归属（侧栏马上挂到项目下，
 *     不写服务端映射）；物化（`POST /api/threads` 带 projectId）时服务端用项目 path 当内核 cwd，
 *     物化回包/下一次列表刷新带上 cwd 后，本地草稿记账退场、归属改由 cwd 决定。
 *   - 映射通道可用时（历史版本 / 旧服务端）行为不变：服务端快照为权威，`syncFromCwd` 空操作。
 *
 * 失败一律落 `error`（侧栏显示），不抛给调用方。
 */
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { isFeatureDisabledError } from '@renderer/lib/feature-disabled'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { create } from 'zustand'
import type { SessionProjectEntry } from '@shared/projects'
import type { ThreadSummary } from '@shared/threads'
import { fetchSessionProjects, putSessionProject } from '../../lib/projects-api'
import { deriveProjectMappings } from './project-cwd'

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/** ensureLoaded 的去重句柄（多个组件可能同时触发；模块级，不进 store） */
let loadPromise: Promise<void> | null = null

/**
 * 0.2.2：草稿（还没物化成内核 session）的本地项目归属 `threadId → projectId`。
 *
 * 存在的理由：501 下"归属"由内核 cwd 决定，而草稿还没有内核 session —— 但用户点了项目行 ⊕ /
 * 刚建完项目，侧栏必须当场把它挂进项目，且物化时要告诉服务端"建到哪个项目的目录里"。
 * 物化回包/刷新带出 cwd 后自动作废（见 syncFromCwd），不留长期影子状态。
 */
let draftProjects: Record<string, string> = {}

export interface ProjectsState {
  /** 会话 id → 项目 id（501 下由内核 cwd 推导；映射通道可用时是服务端镜像 + 本地乐观补丁） */
  mappings: Record<string, string>
  /**
   * 本地乐观补丁里**服务端还没回执**的那些会话（threadId 集合）。
   *
   * 会话根的唯一解析者在主进程：PUT 落地之前它还按旧口径
   * 解析——渲染端却已经把"这个会话属于哪个项目"画出来了。工作台三件按根开工的工具
   * （文件树 / Git / 终端）据此推迟第一次请求，否则会按**兜底根**先列一次目录、起一个 cwd
   * 在别的目录上的 shell，而那次结果之后不会再刷新（round 49 用户实报"切换对话后文件区路径没刷新"）。
   *
   * 0.2.2：501 下的"草稿已记项目归属、但会话还没物化"也标这里 —— 内核 session 还没建，
   * 主进程解析出的根仍是兜底根，工作台该等物化落地（同一类竞态、同一条纪律）。
   */
  pending: Record<string, true>
  /** 初次加载是否结束（成功或失败都算结束） */
  loaded: boolean
  /**
   * 0.2.1（PB-053）：会话↔项目映射这条宿主路由在 0.2.x **主动下架**（501 feature-disabled）。
   * 这是"本版没有这个能力"，不是"加载失败"——不能落 `error`（侧栏会画成红字"项目加载失败"
   * 并给一个永远失败的重试）。
   *
   * 0.2.2：`unavailable = true` 时**不再隐藏侧栏项目区**——归属改从内核 cwd 推导（见文件头），
   * 只有依赖写映射的入口（选择项目胶囊、移至项目、归档页项目分区）继续隐藏/禁用。
   * 旧的项目映射数据不做迁移/兼容。
   */
  unavailable: boolean
  /** 最近一次失败的文案（侧栏显示；成功后清空） */
  error: string | null

  ensureLoaded: () => Promise<void>
  refresh: () => Promise<void>
  /** 某个会话的项目 id（没有回 null） */
  projectOf: (threadId: string | null) => string | null
  /** 记下/改掉一个会话的项目（新建会话归属项目、把会话从项目摘出来）；失败回滚并落 error */
  assignSession: (threadId: string, projectId: string | null) => Promise<void>
  /** 项目被删后，把它名下会话的归属逐条摘掉（尽力而为；失败落 error，不抛） */
  clearProjectMappings: (projectId: string) => Promise<void>
  /**
   * 0.2.2：用线程列表的内核 cwd 重算 mappings（只在 `unavailable` 时生效；映射通道可用时
   * 服务端快照才是权威，这里空操作）。会话列表加载/刷新、项目增删改后由调用方触发。
   */
  syncFromCwd: (threads: readonly ThreadSummary[]) => void
  /**
   * 0.2.2：草稿在项目下开出来时先记一笔本地归属（侧栏立刻可见）；物化时用
   * `draftProjectOf` 取回，交给 `POST /api/threads` 当新会话的内核 cwd。
   * 501 下不写服务端映射（那条通道本版没有）；可用时仍走 `assignSession`。
   */
  rememberDraftProject: (threadId: string, projectId: string) => void
  /** 该草稿物化时要带上的 projectId（没记过 = null） */
  draftProjectOf: (threadId: string) => string | null
  /** 草稿被删（或归属作废）：把本地这几笔（mappings / pending / 草稿记账）一起摘掉，不写服务端 */
  forgetLocalSession: (threadId: string) => void
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  mappings: {},
  pending: {},
  loaded: false,
  unavailable: false,
  error: null,

  ensureLoaded: () => {
    if (get().loaded) return Promise.resolve()
    loadPromise ??= (async () => {
      try {
        const entries = await fetchSessionProjects()
        set({ mappings: mergeSnapshot(entries), loaded: true, unavailable: false, error: null })
      } catch (error) {
        if (isFeatureDisabledError(error)) {
          // 本版主动下架（501）：不是失败。映射先空着，`unavailable` 落位后由 syncFromCwd
          // 从内核 cwd 推导（ProjectsSection 的 effect 兜第一次）；不落 error、不再重试。
          set({ mappings: {}, pending: {}, loaded: true, unavailable: true, error: null })
          return
        }
        // 映射读不到不炸侧栏：项目区空着，会话仍按"无项目"显示与工作（服务端那边同理退化为默认工作区）
        console.error('[kyclaw] 会话项目映射加载失败', error)
        set({ loaded: true, error: messageOf(error) })
      } finally {
        loadPromise = null
      }
    })()
    return loadPromise
  },

  refresh: async () => {
    try {
      const entries = await fetchSessionProjects()
      set({ mappings: mergeSnapshot(entries), loaded: true, unavailable: false, error: null })
    } catch (error) {
      if (isFeatureDisabledError(error)) {
        set({ mappings: {}, pending: {}, loaded: true, unavailable: true, error: null })
        return
      }
      console.error('[kyclaw] 刷新会话项目映射失败', error)
      set({ error: messageOf(error) })
    }
  },

  projectOf: (threadId) => {
    if (threadId === null) return null
    return get().mappings[threadId] ?? null
  },

  assignSession: async (threadId, projectId) => {
    // 映射通道本版不可用：不写、不假装成功、也不报错（依赖写映射的入口已隐藏；这里只是防御）
    if (get().unavailable) return
    const previous = get().mappings[threadId] ?? null
    set((state) => ({
      mappings: withMapping(state.mappings, threadId, projectId),
      pending: withPending(state.pending, threadId, true),
      error: null
    }))
    try {
      await putSessionProject(threadId, projectId)
    } catch (error) {
      if (isFeatureDisabledError(error)) {
        // 服务中途变成不可用：回滚 + 切到 unavailable，不落 error（不在侧栏画"失败"）
        set((state) => ({
          mappings: withMapping(state.mappings, threadId, previous),
          pending: withPending(state.pending, threadId, false),
          loaded: true,
          unavailable: true,
          error: null
        }))
        return
      }
      console.error('[kyclaw] 会话项目归属没能记上', error)
      // 回滚本地视图：服务端不知道的归属不该在侧栏里显示出来（否则这个会话会悄悄用默认工作区）
      set((state) => ({
        mappings: withMapping(state.mappings, threadId, previous),
        error: messageOf(error)
      }))
    } finally {
      // 回执到（成功或失败）＝主进程那边的映射口径与渲染端对齐了，工作台工具可以开工
      set((state) => ({ pending: withPending(state.pending, threadId, false) }))
    }
  },

  clearProjectMappings: async (projectId) => {
    // 0.2.2：草稿的本地记账先清（501 下 assignSession 是空操作，别让它们继续挂在已删项目上）
    const staleDrafts = Object.entries(draftProjects)
      .filter(([, mapped]) => mapped === projectId)
      .map(([threadId]) => threadId)
    for (const threadId of staleDrafts) {
      const next = { ...draftProjects }
      delete next[threadId]
      draftProjects = next
    }
    if (get().unavailable) {
      set((state) => ({ mappings: withoutProject(state.mappings, projectId) }))
      return
    }
    const doomed = Object.entries(get().mappings)
      .filter(([, mapped]) => mapped === projectId)
      .map(([threadId]) => threadId)
    for (const threadId of doomed) {
      await get().assignSession(threadId, null)
    }
  },

  syncFromCwd: (threads) => {
    // 映射通道可用时服务端快照才是权威（历史版本）；501 才用 cwd 推导
    if (!get().unavailable) return
    const projects = useSettingsStore.getState().settings.projects
    const projectIds = new Set(projects.map((project) => project.id))
    const mappings = deriveProjectMappings(threads, projects)
    /** cwd 已落地的线程：归属以内核事实为准（推不出项目 = 无项目），本地草稿记账退场 */
    const cwdKnown = new Set(
      threads
        .filter((thread) => thread.cwd !== undefined && thread.cwd.trim() !== '')
        .map((thread) => thread.id)
    )
    let nextDrafts: Record<string, string> | null = null
    let pending = get().pending
    for (const [threadId, projectId] of Object.entries(draftProjects)) {
      if (!projectIds.has(projectId) || cwdKnown.has(threadId)) {
        // 项目没了 / 物化已落地：这笔草稿记账作废，pending 跟着收（主进程那边的根此刻已经是真根）
        nextDrafts ??= { ...draftProjects }
        delete nextDrafts[threadId]
        pending = withPending(pending, threadId, false)
        continue
      }
      // 还没物化（或物化回包没带 cwd）：先按本地记账显示，别让"刚在项目下开的草稿"闪到任务组
      mappings[threadId] = projectId
    }
    if (nextDrafts !== null) draftProjects = nextDrafts
    set({ mappings, pending })
  },

  rememberDraftProject: (threadId, projectId) => {
    draftProjects = { ...draftProjects, [threadId]: projectId }
    if (!get().unavailable) {
      // 映射通道可用（历史口径）：归属照旧写服务端；草稿这笔只用来让物化带上 projectId
      void get().assignSession(threadId, projectId)
      return
    }
    // 501：不写服务端映射（没有那条通道）。侧栏先挂上，pending 一起标上——工作台在物化落地前
    // 先别按兜底根开工（round 49 的同一类竞态，见 ProjectChip.choose 的注释）。
    set((state) => ({
      mappings: mapped(state.mappings, threadId, projectId),
      pending: withPending(state.pending, threadId, true),
      error: null
    }))
  },

  draftProjectOf: (threadId) => draftProjects[threadId] ?? null,

  forgetLocalSession: (threadId) => {
    if (draftProjects[threadId] !== undefined) {
      const next = { ...draftProjects }
      delete next[threadId]
      draftProjects = next
    }
    set((state) => ({
      mappings: mapped(state.mappings, threadId, null),
      pending: withPending(state.pending, threadId, false)
    }))
  }
}))

/**
 * 服务端快照 + 本地未确认的补丁：快照里有的一律以服务端为准；快照里还没有、本地这几步写过的
 * （PUT 还在路上）保留本地值 —— 否则"刚点项目就新建的会话"会被一个在飞的旧快照拽回"无项目"。
 */
let pendingPatch: Record<string, string | null> = {}

function mergeSnapshot(entries: readonly SessionProjectEntry[]): Record<string, string> {
  const mappings: Record<string, string> = {}
  for (const entry of entries) mappings[entry.threadId] = entry.projectId

  const known = new Set(entries.map((entry) => entry.threadId))
  for (const [threadId, projectId] of Object.entries(pendingPatch)) {
    if (known.has(threadId)) continue
    if (projectId === null) delete mappings[threadId]
    else mappings[threadId] = projectId
  }
  return mappings
}

/** 纯映射改一笔（不碰 pendingPatch：501 推导出的映射没有"服务端回执"这回事） */
function mapped(
  mappings: Record<string, string>,
  threadId: string,
  projectId: string | null
): Record<string, string> {
  const next = { ...mappings }
  if (projectId === null) delete next[threadId]
  else next[threadId] = projectId
  return next
}

/** 写服务端映射时的乐观补丁（同时记 pendingPatch，供"在飞的旧快照"合并） */
function withMapping(
  mappings: Record<string, string>,
  threadId: string,
  projectId: string | null
): Record<string, string> {
  pendingPatch = { ...pendingPatch, [threadId]: projectId }
  return mapped(mappings, threadId, projectId)
}

/** 摘掉某个项目名下的全部映射（项目删除后的本地收尾） */
function withoutProject(
  mappings: Record<string, string>,
  projectId: string
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [threadId, mappedId] of Object.entries(mappings)) {
    if (mappedId !== projectId) next[threadId] = mappedId
  }
  return next
}

/** 挂上/摘掉一条"服务端还没回执"的标记（不变更时原样回同一引用，免得白重渲染） */
function withPending(
  pending: Record<string, true>,
  threadId: string,
  active: boolean
): Record<string, true> {
  if (active) return pending[threadId] === true ? pending : { ...pending, [threadId]: true }
  if (pending[threadId] !== true) return pending
  const next = { ...pending }
  delete next[threadId]
  return next
}

/** 测试用：回到初始状态（模块级 store 不随 render 重置） */
export function resetProjectsStore(): void {
  loadPromise = null
  pendingPatch = {}
  draftProjects = {}
  useProjectsStore.setState({
    mappings: {},
    pending: {},
    loaded: false,
    unavailable: false,
    error: null
  })
}
