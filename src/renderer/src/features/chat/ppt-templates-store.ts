/**
 * 会话级 PPT 模板选择（round 66）：对话页「PPT」胶囊读写的唯一一份状态。
 *
 * 口径（与 projects-store 的会话↔项目映射同一套路数，理由也同一份）：
 *   - **以服务端为准**：映射在 libsql 的 `session_ppt_templates`（与会话本体同库同寿命），
 *     渲染端启动拉一遍（`ensureLoaded`），之后写入走 `PUT /api/ppt/templates` —— 服务端是单写者，
 *     它那份内存镜像就是 `create_ppt` 取缺省模板的地方（写完同一轮工具调用就看得到）。
 *   - **草稿（服务端还不认识这个会话 id）只记本地**：`rememberDraft` 往模块级底账记一笔并立刻更新
 *     本地视图（胶囊当场改名），等会话物化完成（`POST /api/threads` 成功，见 sessions-store.materialize）
 *     再由 `flushDraft` 补写那一笔 —— "给服务端认识的东西记账"，草稿 id 记上去是悬空的。
 *   - **新会话（另一个草稿 id）= 没选**：选择按 threadId 存，别的会话（包括刚开的这个）读不到它 ——
 *     这正是 round 66 修的那件事（从前落全局 settings.pptTemplate，新会话继承了别人的选择）。
 *   - 失败：写服务端失败就回滚本地并落 `error`（界面上不另开错误行，胶囊的显示口径见
 *     PptTemplatePicker 头注；`console.error` 留底供排障），不把"服务端不知道的选择"画成已生效。
 */
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { create } from 'zustand'
import type { AgentEndpoint } from '@shared/ipc'
import type { SessionPptTemplateEntry } from '@shared/session-ppt-templates'
import { fetchSessionPptTemplates, putSessionPptTemplate } from '@renderer/lib/session-ppt-api'

/** ensureLoaded 的去重句柄（多个组件可能同时触发；模块级，不进 store） */
let loadPromise: Promise<void> | null = null

/**
 * 草稿的选择（threadId → 模板名；空串 = 明确清回自动）——**服务端还不知道的那些**。
 *
 * 它必须比组件活得久：在草稿里选完又切走会话、再切回来时（组件按 activeId 重挂）这份选择还得在。
 * 同时它是**本地视图的兜底**：一次 `refresh()` 拉回服务端快照会把"服务端还不知道的草稿选择"冲掉，
 * 所以快照合并时以它为准（见 mergeSnapshot）。
 */
const draftChoices = new Map<string, string>()

function messageOf(error: unknown): string {
  return unwrapIpcError(error)
}

/** 记一条（空串 = 清回自动，等同于没有这一条） */
function withTemplate(
  templates: Record<string, string>,
  threadId: string,
  template: string
): Record<string, string> {
  const next = { ...templates }
  if (template === '') delete next[threadId]
  else next[threadId] = template
  return next
}

export interface PptTemplatesState {
  /** 会话 id → 模板名（服务端镜像 + 草稿本地那一笔；没有的会话就是没选） */
  templates: Record<string, string>
  /** 初次加载是否结束（成功或失败都算结束） */
  loaded: boolean
  /** 最近一次失败的文案（不上面；留底与测试用，成功后清空） */
  error: string | null

  ensureLoaded: (endpoint?: AgentEndpoint) => Promise<void>
  refresh: () => Promise<void>
  /** 某个会话固定的模板（没有 / threadId 为空 → 空串 = 自动挑） */
  templateOf: (threadId: string | null) => string
  /** 已有会话：记下/改掉这个会话的模板（乐观更新 + PUT；失败回滚并落 error） */
  assignTemplate: (threadId: string, template: string) => Promise<void>
  /** 草稿：只记在本地（等物化完成再补写，见 flushDraft） */
  rememberDraft: (threadId: string, template: string) => void
  /** 物化完成：把草稿那一笔补写成正式映射（没记过 = 空操作；失败保留本地、记日志，不抛） */
  flushDraft: (threadId: string) => Promise<void>
}

export const usePptTemplatesStore = create<PptTemplatesState>()((set, get) => ({
  templates: {},
  loaded: false,
  error: null,

  /**
   * `endpoint` = 调用方**刚解析出来的**端点（可选）：对话页在拼 chat 传输时已经拿到了它，
   * 预取直接复用，不再多问一次主进程（省一次 IPC；不传就自己解析，语义完全一样）。
   * 复用端点不影响"失败可重试"：重试与否只看下面的 `loaded`/`error` 两个状态。
   */
  ensureLoaded: (endpoint) => {
    // 上一次拉失败（服务还没起来 / 网络抖）要能重试：成功才把 loaded 当"够了"用
    const state = get()
    if (state.loaded && state.error === null) return Promise.resolve()
    loadPromise ??= (async () => {
      try {
        const entries = await fetchSessionPptTemplates(endpoint)
        set({ templates: mergeSnapshot(entries), loaded: true, error: null })
      } catch (error) {
        // 映射读不到不炸对话页：这个会话按"没选模板"显示与工作（create_ppt 自动挑），不影响发送
        console.error('[kyclaw] 会话 PPT 模板映射加载失败', error)
        set({ loaded: true, error: messageOf(error) })
      } finally {
        loadPromise = null
      }
    })()
    return loadPromise
  },

  refresh: async () => {
    try {
      const entries = await fetchSessionPptTemplates()
      set({ templates: mergeSnapshot(entries), loaded: true, error: null })
    } catch (error) {
      console.error('[kyclaw] 刷新会话 PPT 模板映射失败', error)
      set({ error: messageOf(error) })
    }
  },

  templateOf: (threadId) => (threadId === null ? '' : (get().templates[threadId] ?? '')),

  assignTemplate: async (threadId, template) => {
    // 空串 = 之前没选（回滚时按它把这一条删掉，见 withTemplate）
    const previous = get().templates[threadId] ?? ''
    set((state) => ({ templates: withTemplate(state.templates, threadId, template), error: null }))
    try {
      await putSessionPptTemplate(threadId, template)
    } catch (error) {
      console.error('[kyclaw] 会话 PPT 模板没能记上', error)
      // 回滚本地视图：服务端不知道的选择不该在胶囊上画成已生效（模型那边也不会用它）
      set((state) => ({
        templates: withTemplate(state.templates, threadId, previous),
        error: messageOf(error)
      }))
    }
  },

  rememberDraft: (threadId, template) => {
    draftChoices.set(threadId, template)
    set((state) => ({ templates: withTemplate(state.templates, threadId, template), error: null }))
  },

  flushDraft: async (threadId) => {
    const choice = draftChoices.get(threadId)
    if (choice === undefined) return
    try {
      await putSessionPptTemplate(threadId, choice)
      draftChoices.delete(threadId)
    } catch (error) {
      // 补写没成：本地那份选择留着（界面口径不变），服务端这一轮拿不到它 —— 如实记日志，不抛
      console.error('[kyclaw] 草稿的 PPT 模板没能补记到服务端（这个会话按没选模板跑）', error)
      set({ error: messageOf(error) })
    }
  }
}))

/**
 * 服务端快照 + 草稿那一笔：快照里有的一律以服务端为准；快照里还没有、本地记过的草稿选择保留 ——
 * 否则"在草稿里选好模板"会被一个在飞的旧快照抹掉。
 */
function mergeSnapshot(entries: readonly SessionPptTemplateEntry[]): Record<string, string> {
  const templates: Record<string, string> = {}
  for (const entry of entries) templates[entry.threadId] = entry.template

  for (const [threadId, template] of draftChoices) {
    if (threadId in templates) continue
    if (template !== '') templates[threadId] = template
  }
  return templates
}

/** 测试用：回到初始状态（模块级底账不随 render 重置） */
export function resetPptTemplatesStore(): void {
  loadPromise = null
  draftChoices.clear()
  usePptTemplatesStore.setState({ templates: {}, loaded: false, error: null })
}
