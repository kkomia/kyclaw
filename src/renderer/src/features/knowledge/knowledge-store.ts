/**
 * 知识库页面状态（M5-B）：文档清单 / 选中 / 搜索 / 正文 / 导入结果，全部走 preload 的
 * `window.kyclaw.knowledge`（闸门与磁盘动作都在主进程）。
 *
 * 口径：
 *   - **单一数据源在主进程**：store 只存镜像（documents / text / hits），任何写操作成功后再刷镜像；
 *   - **搜索在主进程**（`knowledge:search`），这里只存 query 与命中，不在渲染端扫全文；
 *   - 失败一律落 `error` 给人话（页面顶部条），不抛给调用方；正文加载用序号防竞态（快速点选）；
 *   - 选中文档被删/刷新后不存在时，自动选第一篇（空库则 null）。
 */
import { create } from 'zustand'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import type { KnowledgeDoc, KnowledgeSearchHit, KnowledgeSkipped } from '@shared/knowledge'

function messageOf(error: unknown): string {
  return unwrapIpcError(error)
}

/** 正文请求序号（快速点选时只认最后一次回包） */
let textSeq = 0
/** ensureLoaded 去重句柄（模块级） */
let loadPromise: Promise<void> | null = null

export interface KnowledgeState {
  documents: KnowledgeDoc[]
  selectedId: string | null
  loaded: boolean
  loading: boolean
  importing: boolean
  error: string | null
  /** 最近一次导入被跳过的文件（展示后由页面关闭） */
  skipped: KnowledgeSkipped[]
  /** 搜索词；空串 = 普通列表 */
  query: string
  searching: boolean
  /** null = 没在搜索（显示全量列表）；数组 = 命中（可能为空） */
  hits: KnowledgeSearchHit[] | null
  /** 选中文档的正文（搜索不碰它） */
  text: string
  textTruncated: boolean
  textLoading: boolean
  textError: string | null

  ensureLoaded: () => Promise<void>
  refresh: () => Promise<void>
  select: (id: string | null) => void
  importDocuments: () => Promise<void>
  search: (query: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  reveal: (id: string) => Promise<void>
  openFolder: () => Promise<void>
  clearSkipped: () => void
  clearError: () => void
}

const EMPTY: Pick<
  KnowledgeState,
  | 'documents'
  | 'selectedId'
  | 'loaded'
  | 'loading'
  | 'importing'
  | 'error'
  | 'skipped'
  | 'query'
  | 'searching'
  | 'hits'
  | 'text'
  | 'textTruncated'
  | 'textLoading'
  | 'textError'
> = {
  documents: [],
  selectedId: null,
  loaded: false,
  loading: false,
  importing: false,
  error: null,
  skipped: [],
  query: '',
  searching: false,
  hits: null,
  text: '',
  textTruncated: false,
  textLoading: false,
  textError: null
}

/** 测试用：把 store 复位到初始状态（并清模块级去重句柄） */
export function resetKnowledgeStore(): void {
  loadPromise = null
  textSeq += 1
  useKnowledgeStore.setState(EMPTY)
}

/** 读 preload 面；缺失（纯单测没装桥）给一句人话 */
function api(): Window['kyclaw']['knowledge'] {
  const bridge = window.kyclaw?.knowledge
  if (bridge === undefined) throw new Error('知识库通道不可用（window.kyclaw.knowledge 缺失）')
  return bridge
}

export const useKnowledgeStore = create<KnowledgeState>()((set, get) => {
  /** 刷新后对齐选中：原选中还在就留，否则选第一篇；并重载正文 */
  const alignSelection = (documents: KnowledgeDoc[]): void => {
    const current = get().selectedId
    const next = documents.some((doc) => doc.id === current) ? current : (documents[0]?.id ?? null)
    if (next !== get().selectedId) set({ selectedId: next })
    if (next !== null) get().select(next)
    else set({ text: '', textTruncated: false, textLoading: false, textError: null })
  }

  const load = async (): Promise<void> => {
    set({ loading: true, error: null })
    try {
      const { documents } = await api().list()
      set({
        documents,
        loaded: true,
        loading: false,
        error: null,
        // 列表刷新后命中也失效（搜索结果引用的文档可能已改/删）
        hits: null,
        searching: false,
        query: ''
      })
      alignSelection(documents)
    } catch (error) {
      set({ loaded: true, loading: false, error: messageOf(error) })
    }
  }

  return {
    ...EMPTY,

    ensureLoaded: () => {
      if (get().loaded) return Promise.resolve()
      loadPromise ??= load().finally(() => {
        loadPromise = null
      })
      return loadPromise
    },

    refresh: load,

    select: (id) => {
      set({ selectedId: id })
      if (id === null) {
        textSeq += 1
        set({ text: '', textTruncated: false, textLoading: false, textError: null })
        return
      }
      // 正文按 id 重新取；序号防止快速点选时旧回包覆盖新选择
      textSeq += 1
      const seq = textSeq
      set({ text: '', textTruncated: false, textLoading: true, textError: null })
      void api()
        .readText(id)
        .then((result) => {
          if (seq !== textSeq || get().selectedId !== id) return
          set({
            text: result.text,
            textTruncated: result.truncated,
            textLoading: false,
            textError: null
          })
        })
        .catch((error: unknown) => {
          if (seq !== textSeq || get().selectedId !== id) return
          set({ text: '', textLoading: false, textError: messageOf(error) })
        })
    },

    importDocuments: async () => {
      set({ importing: true, error: null })
      try {
        const result = await api().import()
        const { documents } = await api().list()
        const firstImported = result.documents[0]?.id ?? null
        set({
          documents,
          importing: false,
          skipped: result.skipped,
          error: null,
          query: '',
          hits: null,
          searching: false
        })
        if (firstImported !== null) get().select(firstImported)
        else alignSelection(documents)
      } catch (error) {
        set({ importing: false, error: messageOf(error) })
      }
    },

    search: async (query) => {
      const trimmed = query.trim()
      if (trimmed === '') {
        set({ query: '', hits: null, searching: false })
        return
      }
      set({ query, searching: true, error: null })
      try {
        const { hits } = await api().search(trimmed)
        if (get().query !== query) return
        set({ hits, searching: false })
      } catch (error) {
        set({ searching: false, hits: null, error: messageOf(error) })
      }
    },

    rename: async (id, title) => {
      try {
        const { document } = await api().rename(id, title)
        set((state) => ({
          documents: state.documents.map((doc) => (doc.id === id ? document : doc))
        }))
      } catch (error) {
        set({ error: messageOf(error) })
      }
    },

    remove: async (id) => {
      try {
        await api().remove(id)
        const documents = get().documents.filter((doc) => doc.id !== id)
        set({ documents })
        if (get().selectedId === id) alignSelection(documents)
      } catch (error) {
        set({ error: messageOf(error) })
      }
    },

    reveal: async (id) => {
      try {
        await api().reveal(id)
      } catch (error) {
        set({ error: messageOf(error) })
      }
    },

    openFolder: async () => {
      try {
        await api().openFolder()
      } catch (error) {
        set({ error: messageOf(error) })
      }
    },

    clearSkipped: () => set({ skipped: [] }),
    clearError: () => set({ error: null })
  }
})
