/**
 * 会话状态（T9）：侧栏与对话页共用的一份 store。
 *
 * 口径（定死的裁决）：**线程数据以服务端为准**。
 *   - `threads` 是服务端列表的镜像（refresh 覆盖），本地只额外维护"活跃会话"与
 *     "后台完成的提醒点"；新建会话先是一个本地草稿 id，第一轮请求带着它走，
 *     发完刷新时服务端里就有真身了；
 *   - 一轮结束后（handleTurnEnd）：生成标题（服务端调模型 + 降级）→ 刷新列表；
 *     如果结束时人不在这个会话上，记一个完成点并发系统通知（spec §7.2 的"完成通知"）。
 *
 * 失败一律落 `error` 字段（侧栏显示 + 重试），不抛给调用方：侧栏不该把整个应用带崩。
 */
import { create } from 'zustand'
import type { ThreadSummary } from '@shared/threads'
import { notifyTurnDone } from '../../lib/notify'
import {
  deleteThread,
  fetchThreads,
  generateThreadTitle,
  renameThread
} from '../../lib/threads-api'
import { dropThreadChat } from '../chat/thread-chats'

/** 新建会话的草稿 id（第一轮请求带着它，服务端据此建线程） */
export function newThreadId(): string {
  return crypto.randomUUID()
}

export interface SessionsState {
  /** 服务端会话列表（镜像） */
  threads: ThreadSummary[]
  /** 当前会话：草稿 id（还没发过消息）或已存在的线程 id */
  activeId: string | null
  /** 初次加载是否结束（成功或失败都算结束，UI 据此从"载入中"出来） */
  loaded: boolean
  /** 最近一次失败的文案（侧栏显示 + 重试；成功后清空） */
  error: string | null
  /** 后台完成、人不在那个会话上：`{ [threadId]: true }`（切回去时清掉） */
  notices: Record<string, true>

  ensureLoaded: () => Promise<void>
  refresh: () => Promise<void>
  select: (threadId: string) => void
  /** 新建：开一个草稿（不发请求；第一轮对话时才落成真线程） */
  startNew: () => void
  remove: (threadId: string) => Promise<void>
  rename: (threadId: string, title: string) => Promise<void>
  /** 一轮结束（isError/isAbort 由调用方先过滤）：标题 + 刷新 + 完成通知 */
  handleTurnEnd: (threadId: string) => Promise<void>
  clearNotice: (threadId: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** ensureLoaded 的去重句柄（ChatPage 与侧栏可能同时触发；模块级，不进 store） */
let loadPromise: Promise<void> | null = null

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  threads: [],
  activeId: null,
  loaded: false,
  error: null,
  notices: {},

  ensureLoaded: () => {
    if (get().loaded) return Promise.resolve()
    loadPromise ??= (async () => {
      try {
        const threads = await fetchThreads()
        set((state) => ({
          threads,
          loaded: true,
          error: null,
          // 首屏选中最近一条；没有就开草稿
          activeId: state.activeId ?? threads[0]?.id ?? newThreadId()
        }))
      } catch (error) {
        // 列表没载入也要能继续：开草稿对话（服务通不通由对话页的错误卡说）
        set((state) => ({
          loaded: true,
          error: messageOf(error),
          activeId: state.activeId ?? newThreadId()
        }))
      } finally {
        loadPromise = null
      }
    })()
    return loadPromise
  },

  refresh: async () => {
    try {
      const threads = await fetchThreads()
      set({ threads, loaded: true, error: null })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  select: (threadId) => {
    set((state) => ({
      activeId: threadId,
      notices: withoutKey(state.notices, threadId)
    }))
  },

  startNew: () => {
    set({ activeId: newThreadId() })
  },

  remove: async (threadId) => {
    try {
      await deleteThread(threadId)
    } catch (error) {
      set({ error: messageOf(error) })
      return
    }
    // 被删会话的内存态一起丢掉（连同还在跑的流）：它不会再被渲染，留着只会泄漏消息与请求
    dropThreadChat(threadId, { stop: true })
    const remaining = get().threads.filter((thread) => thread.id !== threadId)
    set((state) => ({
      threads: remaining,
      notices: withoutKey(state.notices, threadId),
      activeId: state.activeId === threadId ? (remaining[0]?.id ?? newThreadId()) : state.activeId
    }))
    // 与服务端对齐排序/时间
    void get().refresh()
  },

  rename: async (threadId, title) => {
    try {
      const updated = await renameThread(threadId, title)
      set((state) => ({
        threads: state.threads.map((thread) => (thread.id === threadId ? updated : thread)),
        error: null
      }))
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  handleTurnEnd: async (threadId) => {
    const state = get()
    // 草稿的第一轮：服务端已经建了线程，先乐观插一条（标题稍后补上），侧栏立刻有反馈
    if (!state.threads.some((thread) => thread.id === threadId)) {
      set({
        threads: [
          { id: threadId, title: null, updatedAt: new Date().toISOString() },
          ...state.threads
        ]
      })
    }

    const title = get().threads.find((thread) => thread.id === threadId)?.title ?? null
    if (get().activeId !== threadId) {
      set((current) => ({ notices: { ...current.notices, [threadId]: true } }))
      notifyTurnDone(title ?? '新会话')
    }

    try {
      const generated = await generateThreadTitle(threadId)
      if (generated.title !== '') {
        set((current) => ({
          threads: current.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, title: generated.title, updatedAt: new Date().toISOString() }
              : thread
          )
        }))
      }
    } catch {
      // 标题生成失败不影响会话本身（服务端已降级；这里连降级都没拿到就用"新会话"显示）
    }
    void get().refresh()
  },

  clearNotice: (threadId) => {
    set((state) => ({ notices: withoutKey(state.notices, threadId) }))
  }
}))

function withoutKey(notices: Record<string, true>, key: string): Record<string, true> {
  if (!(key in notices)) return notices
  const next = { ...notices }
  delete next[key]
  return next
}

/** 测试用：回到初始状态（模块级 store 不随 render 重置） */
export function resetSessionsStore(): void {
  loadPromise = null
  useSessionsStore.setState({
    threads: [],
    activeId: null,
    loaded: false,
    error: null,
    notices: {}
  })
}
