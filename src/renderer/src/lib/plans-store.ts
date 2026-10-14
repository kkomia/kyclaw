import { createStore, type StoreApi } from 'zustand/vanilla'
import type { PlanRef, SessionPlan } from '@shared/plan'
import {
  plansApi,
  PlansApiError,
  type PlanApiResult,
  type PlanResumeRequest,
  type PlansApi
} from './plans-api'

export interface PlanSessionState {
  state: SessionPlan | null
  ref: PlanRef | null
  busy: boolean
  error: string | null
  feedback: string
}
export const EMPTY_PLAN_SESSION: PlanSessionState = {
  state: null,
  ref: null,
  busy: false,
  error: null,
  feedback: ''
}
export interface PlansState {
  sessions: Readonly<Record<string, PlanSessionState | undefined>>
  load(threadId: string): Promise<void>
  enter(threadId: string, expectedVersion: number): Promise<void>
  approve(threadId: string, ref: PlanRef): Promise<void>
  revise(threadId: string, ref: PlanRef, feedback: string): Promise<void>
  cancel(threadId: string, expectedVersion: number): Promise<void>
  resume(threadId: string, ref: PlanRef): Promise<void>
  setFeedback(threadId: string, feedback: string): void
  forget(threadId: string): void
}
export function planSession(state: PlansState, threadId: string): PlanSessionState {
  return Object.prototype.hasOwnProperty.call(state.sessions, threadId)
    ? (state.sessions[threadId] ?? EMPTY_PLAN_SESSION)
    : EMPTY_PLAN_SESSION
}
export function createPlansStore(options: {
  api?: PlansApi
  onResume: (threadId: string, request: PlanResumeRequest) => Promise<void>
}): StoreApi<PlansState> {
  const api = options.api ?? plansApi
  let serial = 0
  const tickets = new Map<string, number>()
  const loads = new Map<string, { promise: Promise<void>; cancel: () => void }>()
  return createStore<PlansState>()((set, get) => {
    const patch = (threadId: string, changes: Partial<PlanSessionState>): void => {
      set((state) => ({
        sessions: { ...state.sessions, [threadId]: { ...planSession(state, threadId), ...changes } }
      }))
    }
    const start = (threadId: string): number => {
      const ticket = ++serial
      tickets.set(threadId, ticket)
      patch(threadId, { busy: true, error: null })
      return ticket
    }
    const current = (threadId: string, ticket: number): boolean => tickets.get(threadId) === ticket
    const apply = (threadId: string, result: PlanApiResult): void => {
      if (result.state.threadId !== threadId) throw new Error('计划回包会话不一致')
      const previous = planSession(get(), threadId).state
      if (previous && result.state.version < previous.version) throw new Error('计划回包版本过旧')
      patch(threadId, { state: result.state, ref: result.ref })
    }
    const fail = async (threadId: string, ticket: number, failure: unknown): Promise<never> => {
      const message = failure instanceof Error ? failure.message : '计划操作失败，请重试'
      if (current(threadId, ticket)) {
        if (failure instanceof PlansApiError && failure.status === 409) {
          try {
            const refreshed = await api.get(threadId)
            if (current(threadId, ticket)) apply(threadId, refreshed)
          } catch {
            /* keep last confirmed server state */
          }
        }
        if (current(threadId, ticket))
          patch(threadId, {
            busy: false,
            error:
              failure instanceof PlansApiError && failure.status === 409
                ? `${message}；已尝试刷新，请确认后重新操作`
                : message
          })
      }
      throw failure instanceof Error ? failure : new Error(message)
    }
    const mutate = async (
      threadId: string,
      operation: () => Promise<PlanApiResult>
    ): Promise<void> => {
      if (planSession(get(), threadId).busy) throw new Error('计划操作进行中')
      const ticket = start(threadId)
      try {
        const result = await operation()
        if (!current(threadId, ticket)) return
        apply(threadId, result)
        patch(threadId, { busy: false })
      } catch (failure) {
        await fail(threadId, ticket, failure)
      }
    }
    const assertRef = (threadId: string, ref: PlanRef): SessionPlan => {
      const session = planSession(get(), threadId)
      if (
        !session.state ||
        !session.ref ||
        session.ref.planId !== ref.planId ||
        session.ref.revision !== ref.revision ||
        session.ref.version !== ref.version
      )
        throw new Error('计划版本已变化，请刷新后重试')
      return session.state
    }
    return {
      sessions: {},
      load(threadId) {
        const existing = loads.get(threadId)
        if (existing) return existing.promise
        if (planSession(get(), threadId).busy)
          return Promise.reject(new Error('计划操作进行中，请稍后刷新'))
        let cancel!: () => void
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new Error('计划加载已失效'))
        })
        const ticket = start(threadId)
        const promise = (async () => {
          try {
            const result = await Promise.race([api.get(threadId), cancelled])
            if (!current(threadId, ticket)) throw new Error('计划加载已失效')
            apply(threadId, result)
            patch(threadId, { busy: false })
          } catch (failure) {
            await fail(threadId, ticket, failure)
          } finally {
            if (loads.get(threadId)?.cancel === cancel) loads.delete(threadId)
          }
        })()
        loads.set(threadId, { promise, cancel })
        return promise
      },
      enter: (threadId, version) => mutate(threadId, () => api.enter(threadId, version)),
      approve: (threadId, ref) =>
        mutate(threadId, async () => {
          assertRef(threadId, ref)
          return api.decision(threadId, ref, 'approve')
        }),
      revise: (threadId, ref, feedback) =>
        mutate(threadId, async () => {
          assertRef(threadId, ref)
          return api.decision(threadId, ref, 'revise', feedback)
        }),
      cancel: (threadId, version) => mutate(threadId, () => api.cancel(threadId, version)),
      async resume(threadId, ref) {
        if (planSession(get(), threadId).busy) throw new Error('计划操作进行中')
        const state = assertRef(threadId, ref)
        if (!state.approval && !state.pendingRevision) throw new Error('尚无服务器确认的计划决定')
        const ticket = start(threadId)
        try {
          const request = await api.resumeRequest(threadId, ref)
          if (!current(threadId, ticket)) return
          await options.onResume(threadId, request)
          if (!current(threadId, ticket)) return
          const result = await api.get(threadId)
          if (!current(threadId, ticket)) return
          apply(threadId, result)
          patch(threadId, { busy: false })
        } catch (failure) {
          await fail(threadId, ticket, failure)
        }
      },
      setFeedback: (threadId, feedback) => patch(threadId, { feedback }),
      forget(threadId) {
        tickets.delete(threadId)
        loads.get(threadId)?.cancel()
        loads.delete(threadId)
        set((state) => {
          const sessions = { ...state.sessions }
          delete sessions[threadId]
          return { sessions }
        })
      }
    }
  })
}
export type PlansStore = ReturnType<typeof createPlansStore>
