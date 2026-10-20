/**
 * 项目状态（T18）：会话↔项目映射 + 「当前项目」的推导，侧栏项目区与新建会话共用一份。
 *
 * 口径：
 *   - **映射以服务端为准**（libsql 的 session_projects）：`mappings` 是它的镜像；新建会话时先在
 *     本地补上（侧栏马上有反馈），PUT 成功/失败都记在 `error` 里（失败要把会话从项目里摘回来，
 *     不能让 UI 显示一个服务端其实不知道的归属 —— 那会让这个会话悄悄用默认工作区干活）。
 *   - **当前项目 = 当前会话的项目**（推导，不单独存）：只有**项目行的 ⊕**（以及"项目刚建好"那条路）
 *     在这个项目里开新会话 → 草稿带着它的映射 → 当前项目自然就是它；点一条没有项目的会话 →
 *     当前项目回到"无"。round 55 起**全局「新建会话」不带项目**（不继承"最后浏览的项目"，
 *     根走默认工作区下的会话子目录）—— 归属的写入只有 ⊕ 一处，不会出现"选中的项目"和
 *     "正在看的会话"打架。
 *   - 项目清单本身在 settings（settings-store），这里只读它来判"映射还有没有对应的项目"。
 *
 * 失败一律落 `error`（侧栏显示），不抛给调用方。
 */
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { isFeatureDisabledError } from '@renderer/lib/feature-disabled'
import { create } from 'zustand'
import type { SessionProjectEntry } from '@shared/projects'
import { fetchSessionProjects, putSessionProject } from '../../lib/projects-api'

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/** ensureLoaded 的去重句柄（多个组件可能同时触发；模块级，不进 store） */
let loadPromise: Promise<void> | null = null

export interface ProjectsState {
  /** 会话 id → 项目 id（服务端镜像 + 本地乐观补丁） */
  mappings: Record<string, string>
  /**
   * 本地乐观补丁里**服务端还没回执**的那些会话（threadId 集合）。
   *
   * 会话根的唯一解析者在主进程（sessionRoots 读服务端的映射镜像）：PUT 落地之前它还按旧口径
   * 解析——渲染端却已经把"这个会话属于哪个项目"画出来了。工作台三件按根开工的工具
   * （文件树 / Git / 终端）据此推迟第一次请求，否则会按**兜底根**先列一次目录、起一个 cwd
   * 在别的目录上的 shell，而那次结果之后不会再刷新（round 49 用户实报"切换对话后文件区路径没刷新"）。
   */
  pending: Record<string, true>
  /** 初次加载是否结束（成功或失败都算结束） */
  loaded: boolean
  /**
   * 0.2.1（PB-053）：会话↔项目映射这条宿主路由在 0.2.x **主动下架**（501 feature-disabled）。
   * 这是"本版没有这个能力"，不是"加载失败"——不能落 `error`（侧栏会画成红字"项目加载失败"
   * 并给一个永远失败的重试）。`unavailable = true` 时所有依赖映射的入口（项目区、选择项目胶囊、
   * 移至项目、项目记忆指令块、归档页项目分区）一律隐藏；旧项目数据不做迁移/兼容。
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
          // 本版主动下架（501）：不是失败。映射为空、不报错、不再重试；入口由各组件按
          // `unavailable` 隐藏（PB-053）。旧项目数据直接舍弃，不做兼容/迁移。
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
    // 映射通道本版不可用：不写、不假装成功、也不报错（入口已隐藏；这里只是防御）
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
    const doomed = Object.entries(get().mappings)
      .filter(([, mapped]) => mapped === projectId)
      .map(([threadId]) => threadId)
    for (const threadId of doomed) {
      await get().assignSession(threadId, null)
    }
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

function withMapping(
  mappings: Record<string, string>,
  threadId: string,
  projectId: string | null
): Record<string, string> {
  pendingPatch = { ...pendingPatch, [threadId]: projectId }
  const next = { ...mappings }
  if (projectId === null) delete next[threadId]
  else next[threadId] = projectId
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
  useProjectsStore.setState({
    mappings: {},
    pending: {},
    loaded: false,
    unavailable: false,
    error: null
  })
}
