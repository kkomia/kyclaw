/**
 * 笔记页状态（M5 · 渲染端）：列表 / 选中 / 草稿 / 自动保存 / 搜索 / 置顶。
 *
 * 数据只在主进程（`window.kyclaw.notes`）；这里把「用户在编辑什么」「保存到哪一步」收成一份
 * store，组件只做展示。自动保存 debounce 600ms 放在 store 里（页面/编辑器共用同一支计时器，
 * 切笔记/新建/删除前统一 flush，不会把 A 的草稿写进 B）。
 */
import { create } from 'zustand'
import type { NoteMeta, NoteSearchHit } from '@shared/notes'
import { unwrapIpcError } from '@renderer/lib/ipc-error'

/** 自动保存 debounce（plan §1.1：600ms） */
export const NOTE_AUTOSAVE_MS = 600
/** 搜索 debounce（输入停顿后查主进程；主进程做标题+正文全文） */
export const NOTE_SEARCH_MS = 200

export type NotesSaveState = 'idle' | 'saving' | 'saved' | 'error'
export type NotesEditorMode = 'edit' | 'preview'

export interface NotesState {
  notes: NoteMeta[]
  listLoading: boolean
  listError: string | null
  initialized: boolean

  selectedId: string | null
  noteLoading: boolean
  title: string
  body: string
  dirty: boolean
  mode: NotesEditorMode

  saveState: NotesSaveState
  savedAt: string | null
  saveError: string | null

  query: string
  searchHits: NoteSearchHit[] | null
  searching: boolean

  notice: string | null

  init: (narrow: boolean) => Promise<void>
  refresh: () => Promise<void>
  select: (id: string) => Promise<void>
  closeNote: () => void
  create: () => Promise<void>
  remove: (id: string) => Promise<void>
  setTitle: (value: string) => void
  setBody: (value: string) => void
  setMode: (mode: NotesEditorMode) => void
  save: (force?: boolean) => Promise<boolean>
  retrySave: () => Promise<void>
  search: (query: string) => void
  clearSearch: () => void
  togglePin: (id: string) => Promise<void>
  openFolder: () => Promise<void>
  clearNotice: () => void
}

function messageOf(error: unknown): string {
  return unwrapIpcError(error)
}

/** 模块级计时器：自动保存 / 搜索（不进 store，避免 React state 抖动） */
let saveTimer: ReturnType<typeof setTimeout> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null

function clearSaveTimer(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

function clearSearchTimer(): void {
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
}

/** 笔记 API（preload） */
function notesApi(): typeof window.kyclaw.notes {
  return window.kyclaw.notes
}

/** 列表排序与主进程一致：置顶优先 + updatedAt 倒序（本地乐观更新后也用同一支） */
function sortNotes(notes: NoteMeta[]): NoteMeta[] {
  return notes.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return 0
  })
}

export const useNotesStore = create<NotesState>()((set, get) => {
  /** 草稿是否有未落盘的变化（save 里按 revision 判断"保存期间又改了"） */
  let editRevision = 0

  /** 真正落盘：只在 force 或 dirty 时打 IPC；返回是否成功 */
  const persist = async (force: boolean): Promise<boolean> => {
    const state = get()
    if (state.selectedId === null) return false
    if (!force && !state.dirty) return true
    const revision = editRevision
    set({ saveState: 'saving', saveError: null })
    try {
      const { note } = await notesApi().save({
        id: state.selectedId,
        title: state.title,
        text: state.body
      })
      const nextNotes = sortNotes(get().notes.map((item) => (item.id === note.id ? note : item)))
      const stillCurrent = get().selectedId === note.id
      const unchanged = editRevision === revision
      set((current) => ({
        notes: nextNotes,
        saveState: unchanged ? 'saved' : 'saving',
        savedAt: new Date().toISOString(),
        saveError: null,
        dirty: stillCurrent ? !unchanged : current.dirty
      }))
      // 保存期间又改了：等这一拍结束再排下一次（不丢字）
      if (!unchanged && stillCurrent) scheduleSave()
      return true
    } catch (error) {
      set({ saveState: 'error', saveError: messageOf(error) })
      return false
    }
  }

  const scheduleSave = (): void => {
    clearSaveTimer()
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist(false)
    }, NOTE_AUTOSAVE_MS)
  }

  const flushSave = async (): Promise<void> => {
    if (!get().dirty) return
    clearSaveTimer()
    await persist(true)
  }

  const applyLoadedNote = (note: NoteMeta | undefined, text: string): void => {
    set({
      selectedId: note?.id ?? null,
      title: note?.title ?? '',
      body: text,
      dirty: false,
      mode: 'edit',
      saveState: 'idle',
      savedAt: note?.updatedAt ?? null,
      saveError: null,
      noteLoading: false
    })
  }

  return {
    notes: [],
    listLoading: false,
    listError: null,
    initialized: false,
    selectedId: null,
    noteLoading: false,
    title: '',
    body: '',
    dirty: false,
    mode: 'edit',
    saveState: 'idle',
    savedAt: null,
    saveError: null,
    query: '',
    searchHits: null,
    searching: false,
    notice: null,

    init: async (narrow) => {
      if (get().initialized) return
      set({ listLoading: true, listError: null })
      try {
        const { notes } = await notesApi().list()
        const sorted = sortNotes(notes)
        set({ notes: sorted, listLoading: false, initialized: true })
        if (!narrow && sorted.length > 0) await get().select(sorted[0]!.id)
      } catch (error) {
        set({ listLoading: false, initialized: true, listError: messageOf(error) })
      }
    },

    refresh: async () => {
      set({ listLoading: true, listError: null })
      try {
        const { notes } = await notesApi().list()
        set({ notes: sortNotes(notes), listLoading: false })
      } catch (error) {
        set({ listLoading: false, listError: messageOf(error) })
      }
    },

    select: async (id) => {
      if (get().selectedId === id && !get().dirty) return
      await flushSave()
      set({ selectedId: id, noteLoading: true, mode: 'edit', dirty: false })
      try {
        const { text } = await notesApi().get(id)
        // 加载期间用户可能又点了别的：只认还在选中态的这次结果
        if (get().selectedId !== id) return
        applyLoadedNote(
          get().notes.find((note) => note.id === id),
          text
        )
      } catch (error) {
        set({
          noteLoading: false,
          saveError: null,
          listError: messageOf(error),
          selectedId: id,
          title: '',
          body: '',
          dirty: false
        })
      }
    },

    closeNote: () => {
      void flushSave()
      set({ selectedId: null, title: '', body: '', dirty: false, mode: 'edit' })
    },

    create: async () => {
      await flushSave()
      set({ listLoading: true, listError: null })
      try {
        const { note } = await notesApi().create({})
        const { notes } = await notesApi().list()
        const sorted = sortNotes(
          notes.some((item) => item.id === note.id) ? notes : [note, ...notes]
        )
        set({
          notes: sorted,
          listLoading: false,
          selectedId: note.id,
          title: note.title,
          body: '',
          dirty: false,
          mode: 'edit',
          saveState: 'idle',
          savedAt: note.updatedAt,
          saveError: null
        })
      } catch (error) {
        set({ listLoading: false, listError: messageOf(error) })
      }
    },

    remove: async (id) => {
      clearSaveTimer()
      set({ listLoading: true, listError: null })
      try {
        await notesApi().remove(id)
        const { notes } = await notesApi().list()
        const sorted = sortNotes(notes)
        const removingSelected = get().selectedId === id
        set({
          notes: sorted,
          listLoading: false,
          ...(removingSelected
            ? {
                selectedId: null,
                title: '',
                body: '',
                dirty: false,
                mode: 'edit' as const,
                saveState: 'idle' as const,
                savedAt: null,
                saveError: null
              }
            : {})
        })
      } catch (error) {
        set({ listLoading: false, listError: messageOf(error) })
      }
    },

    setTitle: (value) => {
      editRevision += 1
      set({ title: value, dirty: true, saveState: 'idle', saveError: null })
      scheduleSave()
    },

    setBody: (value) => {
      editRevision += 1
      set({ body: value, dirty: true, saveState: 'idle', saveError: null })
      scheduleSave()
    },

    setMode: (mode) => set({ mode }),

    save: async (force = false) => {
      clearSaveTimer()
      return persist(force)
    },

    retrySave: async () => {
      await get().save(true)
    },

    search: (query) => {
      clearSearchTimer()
      set({ query })
      if (query.trim() === '') {
        set({ searchHits: null, searching: false })
        return
      }
      set({ searching: true })
      searchTimer = setTimeout(() => {
        searchTimer = null
        const needle = get().query.trim()
        if (needle === '') return
        notesApi()
          .search(needle)
          .then(({ hits }) => {
            if (get().query.trim() === needle) set({ searchHits: hits, searching: false })
          })
          .catch((error: unknown) => {
            set({ searching: false, listError: messageOf(error) })
          })
      }, NOTE_SEARCH_MS)
    },

    clearSearch: () => {
      clearSearchTimer()
      set({ query: '', searchHits: null, searching: false })
    },

    togglePin: async (id) => {
      const current = get().notes.find((note) => note.id === id)
      if (current === undefined) return
      try {
        const { note } = await notesApi().pin(id, !current.pinned)
        set({ notes: sortNotes(get().notes.map((item) => (item.id === id ? note : item))) })
      } catch (error) {
        set({ notice: messageOf(error) })
      }
    },

    openFolder: async () => {
      try {
        const { path } = await notesApi().openFolder()
        set({ notice: `已打开：${path}` })
      } catch (error) {
        set({ notice: messageOf(error) })
      }
    },

    clearNotice: () => set({ notice: null })
  }
})

/** 测试用：把 store 恢复成初始态（含模块级计时器） */
export function resetNotesStore(): void {
  clearSaveTimer()
  clearSearchTimer()
  useNotesStore.setState({
    notes: [],
    listLoading: false,
    listError: null,
    initialized: false,
    selectedId: null,
    noteLoading: false,
    title: '',
    body: '',
    dirty: false,
    mode: 'edit',
    saveState: 'idle',
    savedAt: null,
    saveError: null,
    query: '',
    searchHits: null,
    searching: false,
    notice: null
  })
}
