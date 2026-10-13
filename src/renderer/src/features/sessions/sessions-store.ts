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
 * round 26（可用性收口）：草稿也是"完整会话"——`materialize` 把它先落成真实线程
 * （POST /api/threads，与首条消息建线程同一条存储路径），置顶/归档/移至项目先物化再执行；
 * 重命名/删除就地做（本地标题 `draftTitles` / 本地丢弃），不必把每个动作都变成建线程。
 *
 * 失败一律落 `error` 字段（侧栏显示 + 重试），不抛给调用方：侧栏不该把整个应用带崩。
 * 例外：`materialize` 与 provider 同族——失败抛给调用方（动作等它成功才继续，
 * 静默吞掉会让"点了没反应"复现）。界面文案是产品口径（不写后端原文），
 * **原始 error 一律 `console.error` 留底**，生产排障有落点（T9 之后复核指出过：只落文案、原文丢了）。
 */
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { startupMark } from '@renderer/lib/startup-timing'
import { create } from 'zustand'
import type { ThreadSummary } from '@shared/threads'
import { notifyTurnDone } from '../../lib/notify'
import {
  createThread,
  deleteThread,
  fetchThreads,
  generateThreadTitle,
  renameThread
} from '../../lib/threads-api'
import type { OutgoingMessage } from '../chat/composer-attachments'
import { usePptTemplatesStore } from '../chat/ppt-templates-store'
import { dropThreadChat } from '../chat/thread-chats'
import { useProjectsStore } from '../projects/projects-store'

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
  /** round 26：草稿的本地标题（"就地重命名"写这里；物化时带给服务端，物化后由服务端标题接管） */
  draftTitles: Record<string, string>
  /**
   * round 62：**发送队列**（按会话存；`Record<threadId, OutgoingMessage[]>`）。
   *
   * 什么进这里：流式中 / 挂起等审批 / 压缩中 / 发送预检在途时发的消息 —— 先排队，轮末由对话页
   * 逐条补发（口径见 ChatPage 的 submit / flushNext）。**为什么放 store 而不是对话页的组件内 ref**：
   * 对话页按 `key={activeId}` 挂会话组件，切会话就是卸载 —— 排队内容与它的条数会随组件一起
   * 蒸发（用户实报：切走再切回，排队发的消息没了，输入框也不再有提示）。挂到会话维度上之后，
   * 切走再切回队列原样还在，轮末照常补发。
   */
  queues: Record<string, OutgoingMessage[]>

  ensureLoaded: () => Promise<void>
  refresh: () => Promise<void>
  select: (threadId: string) => void
  /**
   * 新建：开一个草稿（不发请求；第一轮对话时才落成真线程）。
   * T18：`projectId` 非空时把这个新会话记进项目映射（服务端据此给它项目工作区的根）。
   * round 55 的归属口径：**全局「新建会话」= 不传 projectId（无项目草稿）**——不继承"最后浏览的
   * 那个项目"，根走默认工作区下的会话子目录；**只有项目行的 ⊕**（与"项目刚建好"那条路）才传
   * projectId（见 ProjectsSection 的 openSessionIn）。
   * 返回新草稿的 id（调用方要拿它做后续动作）。
   */
  startNew: (projectId?: string | null) => string
  /** round 26：就地改草稿标题（服务端还没有它，不落盘；物化时把这份标题带过去） */
  setDraftTitle: (threadId: string, title: string) => void
  /** round 62：入队（尾部追加）—— 排队内容只有这一个写入口，读走 takeQueuedMessage */
  enqueueMessage: (threadId: string, message: OutgoingMessage) => void
  /** round 62：取出队首并**就地移除**（空队回 null）；轮末补发用，取走即不再留 */
  takeQueuedMessage: (threadId: string) => OutgoingMessage | null
  /**
   * round 26：把草稿**物化**成真实线程（round 26 可用性收口：置顶/归档/移至项目先物化再执行）。
   * 走"首条消息建线程"同一条服务端路径（POST /api/threads → memory.createThread，只是不带消息）；
   * 已在 threads 里 = 空操作；成功把新线程并进镜像，失败**抛给调用方**（由它露错误）。
   */
  materialize: (threadId: string) => Promise<void>
  remove: (threadId: string) => Promise<void>
  rename: (threadId: string, title: string) => Promise<void>
  /** 一轮结束（isError/isAbort 由调用方先过滤）：标题 + 刷新 + 完成通知 */
  handleTurnEnd: (threadId: string) => Promise<void>
}

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/** ensureLoaded 的去重句柄（ChatPage 与侧栏可能同时触发；模块级，不进 store） */
let loadPromise: Promise<void> | null = null

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  threads: [],
  activeId: null,
  loaded: false,
  error: null,
  notices: {},
  draftTitles: {},
  queues: {},

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
        // 列表没载入也要能继续：开草稿对话（服务通不通由对话页的错误卡说）。
        // 界面上只说"会话列表加载失败"（雷点 2.2：不把后端原文写给用户看），
        // 原始 error 落控制台 —— 生产排障（DevTools / 日志）要有落点。
        console.error('[kyclaw] 会话列表加载失败', error)
        set((state) => ({
          loaded: true,
          error: messageOf(error),
          activeId: state.activeId ?? newThreadId()
        }))
      } finally {
        loadPromise = null
        // round 73：冷启动打点 —— 会话列表有结果了（成功失败都算；首屏就此从"载入中"出来）
        startupMark('会话列表就绪')
      }
    })()
    return loadPromise
  },

  refresh: async () => {
    try {
      const threads = await fetchThreads()
      set({ threads, loaded: true, error: null })
    } catch (error) {
      console.error('[kyclaw] 刷新会话列表失败', error)
      set({ error: messageOf(error) })
    }
  },

  select: (threadId) => {
    set((state) => ({
      activeId: threadId,
      notices: withoutKey(state.notices, threadId)
    }))
  },

  startNew: (projectId = null) => {
    const threadId = newThreadId()
    set({ activeId: threadId })
    // 归属记在服务端（映射表）：新建会话的那一刻就写，第一轮工具调用读到的是它。
    // 失败由 projects-store 回滚 + 落 error（这个会话就按"没有项目"跑，不会悄悄用错根）。
    if (projectId !== null) void useProjectsStore.getState().assignSession(threadId, projectId)
    return threadId
  },

  setDraftTitle: (threadId, title) => {
    set((state) => ({ draftTitles: { ...state.draftTitles, [threadId]: title } }))
  },

  enqueueMessage: (threadId, message) => {
    set((state) => ({
      queues: { ...state.queues, [threadId]: [...(state.queues[threadId] ?? []), message] }
    }))
  },

  takeQueuedMessage: (threadId) => {
    const queue = get().queues[threadId] ?? []
    const [next, ...rest] = queue
    if (next === undefined) return null
    // 取空了就把这一格也收掉（不给 store 留一堆空数组）
    set((state) => ({
      queues:
        rest.length === 0
          ? withoutKey(state.queues, threadId)
          : { ...state.queues, [threadId]: rest }
    }))
    return next
  },

  /**
   * round 26：草稿物化（置顶/归档/移至项目先走这一步）。与"首条消息建线程"同一条服务端路径；
   * 已在镜像里 = 空操作；本地草稿标题随创建带过去（物化后由服务端标题接管）。
   * 失败抛给调用方（它负责露错误）；成功把新线程并进镜像（时间最近，排最前）。
   */
  materialize: async (threadId) => {
    if (get().threads.some((thread) => thread.id === threadId)) return
    const created = await createThread(threadId, get().draftTitles[threadId])
    set((state) => ({
      threads: state.threads.some((thread) => thread.id === threadId)
        ? state.threads
        : [created, ...state.threads],
      draftTitles: withoutKey(state.draftTitles, threadId)
    }))
    // round 66：服务端现在认识这条会话了 —— 草稿期间在「PPT」胶囊里挑的模板这一笔补记上
    // （不 await 的写法会让"发出去的第一轮 create_ppt"与这次 PUT 赛跑，等它落地再返回）。
    // 补写失败不抛：会话已经建好了，模板没记上只是这个会话按自动挑跑（store 自己记日志）。
    await usePptTemplatesStore.getState().flushDraft(threadId)
  },

  remove: async (threadId) => {
    // round 26：草稿（服务端还没有它）就地删——不发 DELETE（那边本来就没有东西），
    // 只收本地账：丢掉内存态、移出镜像、选中接力。
    const listed = get().threads.some((thread) => thread.id === threadId)
    if (listed) {
      try {
        await deleteThread(threadId)
      } catch (error) {
        console.error('[kyclaw] 删除会话失败', error)
        set({ error: messageOf(error) })
        return
      }
    }
    // 被删会话的内存态一起丢掉（连同还在跑的流）：它不会再被渲染，留着只会泄漏消息与请求
    dropThreadChat(threadId, { stop: true })
    const remaining = get().threads.filter((thread) => thread.id !== threadId)
    set((state) => ({
      threads: remaining,
      draftTitles: withoutKey(state.draftTitles, threadId),
      notices: withoutKey(state.notices, threadId),
      // round 62：会话没了，它的排队内容也一起丢掉（不会再有人去补发它）
      queues: withoutKey(state.queues, threadId),
      activeId: state.activeId === threadId ? (remaining[0]?.id ?? newThreadId()) : state.activeId
    }))
    // 与服务端对齐排序/时间（草稿没有服务端那一半，不用刷）
    if (listed) void get().refresh()
  },

  rename: async (threadId, title) => {
    // round 26：草稿（服务端还没有它）就地改本地标题——不 PATCH（那边 404），
    // 物化（首个动作/首轮消息）时把这份本地标题带过去。
    if (!get().threads.some((thread) => thread.id === threadId)) {
      get().setDraftTitle(threadId, title)
      return
    }
    try {
      const updated = await renameThread(threadId, title)
      set((state) => ({
        threads: state.threads.map((thread) => (thread.id === threadId ? updated : thread)),
        error: null
      }))
    } catch (error) {
      console.error('[kyclaw] 重命名会话失败', error)
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
        ],
        // 本地草稿标题到此交棒：真标题由服务端生成（round 26 的就地重命名是"落成前"的显示口径）
        draftTitles: withoutKey(state.draftTitles, threadId)
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
    } catch (error) {
      // 标题生成失败不影响会话本身（服务端已降级；这里连降级都没拿到就用"新会话"显示）
      console.error('[kyclaw] 生成会话标题失败', error)
    }
    void get().refresh()
  }
}))

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
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
    notices: {},
    draftTitles: {},
    // round 62：排队内容也是模块级状态 —— 不复位会让上一条用例的排队消息漏进下一条
    queues: {}
  })
}
