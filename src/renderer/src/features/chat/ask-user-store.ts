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
  submit: (
    threadId: string,
    run: PendingAskUser,
    answer: AskUserAnswer,
    resume: () => Promise<void>
  ) => Promise<void>
  cancel: (
    threadId: string,
    stop: () => Promise<void>,
    synchronize?: () => Promise<void>
  ) => Promise<string[] | null>
}
const revisions = new Map<string, number>()
const loads = new Map<string, Promise<boolean>>()
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
          const pending = await fetchPendingAskUser(threadId)
          if (revisions.get(threadId) !== version) return false
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
      invalidate(threadId)
      patch(threadId, { submitting: true, error: null })
      try {
        validateAskUserAnswer(run.input, answer)
        await resume()
        if (get().threads.get(threadId)?.stopping) return
        if (!(await get().refresh(threadId))) return
      } catch (error) {
        if (!get().threads.get(threadId)?.stopping) patch(threadId, { error: message(error) })
      } finally {
        patch(threadId, { submitting: false })
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
  useAskUserStore.setState({ threads: new Map(), drafts: new Map() })
}
