/**
 * 项目状态（T18）：会话↔项目映射 + 「当前项目」的推导，侧栏项目区与新建会话共用一份。
 *
 * 口径：
 *   - **映射以服务端为准**（libsql 的 session_projects）：`mappings` 是它的镜像；新建会话时先在
 *     本地补上（侧栏马上有反馈），PUT 成功/失败都记在 `error` 里（失败要把会话从项目里摘回来，
 *     不能让 UI 显示一个服务端其实不知道的归属 —— 那会让这个会话悄悄用默认工作区干活）。
 *   - **当前项目 = 当前会话的项目**（推导，不单独存）：点项目行 = 在那个项目里开一个新会话 →
 *     草稿带着它的映射 → 当前项目自然就是它；点一条没有项目的会话 → 当前项目回到"无"。
 *     这样"新建会话"落在哪儿只有一个答案，不会出现"选中的项目"和"正在看的会话"打架。
 *   - 项目清单本身在 settings（settings-store），这里只读它来判"映射还有没有对应的项目"。
 *
 * 失败一律落 `error`（侧栏显示），不抛给调用方。
 */
import { unwrapIpcError } from '@renderer/lib/ipc-error'
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
  /** 初次加载是否结束（成功或失败都算结束） */
  loaded: boolean
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
  loaded: false,
  error: null,

  ensureLoaded: () => {
    if (get().loaded) return Promise.resolve()
    loadPromise ??= (async () => {
      try {
        const entries = await fetchSessionProjects()
        set({ mappings: mergeSnapshot(entries), loaded: true, error: null })
      } catch (error) {
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
      set({ mappings: mergeSnapshot(entries), loaded: true, error: null })
    } catch (error) {
      console.error('[kyclaw] 刷新会话项目映射失败', error)
      set({ error: messageOf(error) })
    }
  },

  projectOf: (threadId) => {
    if (threadId === null) return null
    return get().mappings[threadId] ?? null
  },

  assignSession: async (threadId, projectId) => {
    const previous = get().mappings[threadId] ?? null
    set((state) => ({ mappings: withMapping(state.mappings, threadId, projectId), error: null }))
    try {
      await putSessionProject(threadId, projectId)
    } catch (error) {
      console.error('[kyclaw] 会话项目归属没能记上', error)
      // 回滚本地视图：服务端不知道的归属不该在侧栏里显示出来（否则这个会话会悄悄用默认工作区）
      set((state) => ({
        mappings: withMapping(state.mappings, threadId, previous),
        error: messageOf(error)
      }))
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

/** 测试用：回到初始状态（模块级 store 不随 render 重置） */
export function resetProjectsStore(): void {
  loadPromise = null
  pendingPatch = {}
  useProjectsStore.setState({ mappings: {}, loaded: false, error: null })
}
