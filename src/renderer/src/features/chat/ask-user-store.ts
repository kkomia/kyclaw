import { create } from 'zustand'
import { validateAskUserAnswer, type AskUserAnswer } from '@shared/ask-user'
import { cancelAskUser, fetchPendingAskUser, type PendingAskUser } from '@renderer/lib/ask-user-api'
import { askUserCallKey, createAskUserDraft, type AskUserDraft } from './ask-user-ui'
import type { UIMessage } from 'ai'
import { hasPendingAskUser } from './ask-user'

export interface AskUserThreadState {
  pending: readonly PendingAskUser[]
  loaded: boolean
  refreshing: boolean
  submitting: boolean
  stopping: boolean
  error: string | null
}
export const EMPTY_ASK_USER_THREAD: AskUserThreadState = {
  pending: [],
  loaded: false,
  refreshing: false,
  submitting: false,
  stopping: false,
  error: null
}
interface AskUserState {
  threads: Map<string, AskUserThreadState>
  drafts: Map<string, AskUserDraft>
  refresh: (threadId: string) => Promise<boolean>
  changeDraft: (key: string, draft: AskUserDraft) => void
  /**
   * 提交一次回答。`resume` 是"发恢复请求"这件动作本身，签名里的回调是**服务端已接收**
   * 的回执（见 lib/agent 的 `AskUserAccepted`）：响应到手时调一次，整轮跑完不算。
   */
  submit: (
    threadId: string,
    run: PendingAskUser,
    answer: AskUserAnswer,
    resume: (accepted: () => void) => Promise<void>
  ) => Promise<void>
  cancel: (
    threadId: string,
    stop: () => Promise<void>,
    synchronize?: () => Promise<void>
  ) => Promise<string[] | null>
}
const revisions = new Map<string, number>()
const loads = new Map<string, Promise<boolean>>()
/**
 * 已"服务端已接收"、但服务端那份挂起快照**可能还在列**的调用（0.1.2 / 001，threadId → 调用键）：
 * 恢复被受理后挂起要等这一轮真消费掉才消失，期间任何一次 pending 刷新（焦点 / 轮末 / 切回会话）
 * 都会把它列回来、卡片复活 —— 用户对着同一个问题再答一遍，服务端那边它早就是 `stale-run`。
 *
 * 生命周期：只在"已答但挂起还没被消费掉"这个窗口里非空 —— `refresh` 每收到一份**当前代次**的
 * 快照，就把服务端不再列的那些键收掉（见 refresh 尾部）。不用 `revisions`：那是"旧异步结果作废"
 * 的代次，跟"这一条调用已经成交"不是一回事（混用会让合法回执被刷新的代次误伤）。
 */
const accepted = new Map<string, Set<string>>()
/**
 * 线程上**正在提交的那一次**（threadId → 调用键 + 代次）。
 *
 * `key` 认领 `submitting` 这个槽：旧请求收尾不能把新一轮提交的锁一起放掉（那是"重复提交"的入口）。
 * `generation` 认迟到的回执/错误：整轮可能跑几十秒，期间这条线程完全可能已经被 reset、开了新一轮
 * 提交或走进取消 —— 代次对不上就一个字都不写（见 `ownedBy`）。
 */
const inFlight = new Map<string, { key: string; generation: number }>()
let generations = 0
function message(error: unknown): string {
  return error instanceof Error ? error.message : '问题服务操作失败，请重试'
}
export const useAskUserStore = create<AskUserState>()((set, get) => {
  const patch = (threadId: string, update: Partial<AskUserThreadState>): void => {
    set((state) => ({
      threads: new Map(state.threads).set(threadId, {
        ...(state.threads.get(threadId) ?? EMPTY_ASK_USER_THREAD),
        ...update
      })
    }))
  }
  const invalidate = (threadId: string): number => {
    const version = (revisions.get(threadId) ?? 0) + 1
    revisions.set(threadId, version)
    loads.delete(threadId)
    return version
  }
  /** 这一代提交是不是线程当前的那一次（迟到的东西一律过这道门） */
  const ownedBy = (threadId: string, key: string, generation: number): boolean => {
    const active = inFlight.get(threadId)
    return active?.key === key && active.generation === generation
  }
  /** 放掉提交槽（只有还属于这一代时才放）：提交锁与卡上的 loading 都收到这里 */
  const releaseSubmit = (threadId: string, key: string, generation: number): void => {
    if (!ownedBy(threadId, key, generation)) return
    inFlight.delete(threadId)
    patch(threadId, { submitting: false })
  }
  const acceptedIn = (threadId: string): Set<string> => {
    const existing = accepted.get(threadId)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    accepted.set(threadId, created)
    return created
  }
  const withoutCall = (threadId: string, run: PendingAskUser): PendingAskUser[] =>
    (get().threads.get(threadId)?.pending ?? []).filter(
      (item) => item.runId !== run.runId || item.toolCallId !== run.toolCallId
    )
  return {
    threads: new Map(),
    drafts: new Map(),
    changeDraft: (key, draft) =>
      set((state) => ({ drafts: new Map(state.drafts).set(key, draft) })),
    refresh: (threadId) => {
      const existing = loads.get(threadId)
      if (existing) return existing
      const version = invalidate(threadId)
      patch(threadId, { refreshing: true })
      const task = (async () => {
        try {
          const reported = await fetchPendingAskUser(threadId)
          if (revisions.get(threadId) !== version) return false
          // 已确认的那几条滤掉（挂起快照晚一步消失），顺带把服务端**不再列**的账收掉 ——
          // 这本账只在"已答、服务端还列着"的窗口里非空（见 `accepted`）
          const confirmed = accepted.get(threadId)
          const pending = reported.filter(
            (item) => !confirmed?.has(askUserCallKey({ threadId, ...item }))
          )
          if (confirmed !== undefined) {
            const listed = new Set(reported.map((item) => askUserCallKey({ threadId, ...item })))
            for (const key of [...confirmed]) if (!listed.has(key)) confirmed.delete(key)
            if (confirmed.size === 0) accepted.delete(threadId)
          }
          set((state) => {
            const drafts = new Map(state.drafts)
            for (const item of pending) {
              const key = askUserCallKey({ threadId, ...item })
              if (!drafts.has(key)) drafts.set(key, createAskUserDraft(item.input))
            }
            return { drafts }
          })
          patch(threadId, { pending, loaded: true, refreshing: false, error: null })
          return true
        } catch (error) {
          if (revisions.get(threadId) === version)
            patch(threadId, {
              refreshing: false,
              error: message(error)
            })
          return false
        } finally {
          if (revisions.get(threadId) === version) loads.delete(threadId)
        }
      })()
      loads.set(threadId, task)
      return task
    },
    submit: async (threadId, run, answer, resume) => {
      const current = get().threads.get(threadId) ?? EMPTY_ASK_USER_THREAD
      if (current.submitting || current.stopping || current.refreshing) return
      if (
        !current.pending.some(
          (item) => item.runId === run.runId && item.toolCallId === run.toolCallId
        )
      ) {
        patch(threadId, { error: '这个问题已失效，请刷新待答问题' })
        return
      }
      const key = askUserCallKey({ threadId, ...run })
      const generation = (generations += 1)
      invalidate(threadId)
      inFlight.set(threadId, { key, generation })
      patch(threadId, { submitting: true, error: null })
      /**
       * **响应到手**（服务端已接收）那一刻收口：收卡 + 放掉提交等待，两件都挂在"请求被受理"上，
       * 不挂在"这一轮跑完"上（模型流跑完可能是几十秒，用户看到的就是"点了提交、卡不收"）。
       * 生成中的忙态由聊天自己那份 status 表示。
       *
       * 只认这一代的回执（`ownedBy`）；不动 `error` —— 提交开场已经清过一遍，此刻还挂着的错误
       * 只可能来自并发的取消/刷新失败，回执不替它们擦掉（下一次成功刷新会清）。
       */
      const acknowledge = (): void => {
        if (!ownedBy(threadId, key, generation)) return
        if (get().threads.get(threadId)?.stopping) return
        acceptedIn(threadId).add(key)
        releaseSubmit(threadId, key, generation)
        patch(threadId, { pending: withoutCall(threadId, run), loaded: true })
      }
      try {
        validateAskUserAnswer(run.input, answer)
        await resume(acknowledge)
        // 这里**不做任何"没收到回执也算成功"的补记**：SDK 的 sendMessage 在中止（abort）时会正常
        // resolve 且不置 chat.error，流末 resolve 因此证明不了服务端已接收。没回执就保持卡与草稿，
        // 靠下一次成功刷新收敛（服务端真受理过，快照里就不会再列它）。
      } catch (error) {
        // 只有这一代、且还没被取消时，失败才写进卡上：确认**之前**失败（409 / 断网）卡与选择都留着，
        // 让用户重试；确认之后的失败走不到这里（回执那一响已经把这一代交出去了）。
        if (ownedBy(threadId, key, generation) && !get().threads.get(threadId)?.stopping)
          patch(threadId, { error: message(error) })
      } finally {
        releaseSubmit(threadId, key, generation)
      }
    },
    cancel: async (threadId, stop, synchronize) => {
      if (get().threads.get(threadId)?.stopping) return null
      invalidate(threadId)
      patch(threadId, { stopping: true, error: null })
      try {
        await stop()
        const runIds = await cancelAskUser(threadId)
        invalidate(threadId)
        patch(threadId, { pending: [], loaded: true, refreshing: false })
        await synchronize?.()
        await get().refresh(threadId)
        return runIds
      } catch (error) {
        patch(threadId, { error: message(error), refreshing: false })
        return null
      } finally {
        patch(threadId, { stopping: false })
      }
    }
  }
})

export function askUserPending(threadId: string, message: UIMessage | undefined): boolean {
  const state = useAskUserStore.getState().threads.get(threadId)
  return state?.loaded && state.error === null
    ? state.pending.length > 0
    : hasPendingAskUser(message)
}

export function askUserWaiting(threadId: string): boolean {
  const state = useAskUserStore.getState().threads.get(threadId)
  return (
    state !== undefined &&
    (!state.loaded ||
      state.refreshing ||
      state.submitting ||
      state.stopping ||
      state.error !== null ||
      state.pending.length > 0)
  )
}

export function resetAskUserStore(): void {
  revisions.clear()
  loads.clear()
  accepted.clear()
  inFlight.clear()
  useAskUserStore.setState({ threads: new Map(), drafts: new Map() })
}
