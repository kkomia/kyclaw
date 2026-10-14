import { expect, it, vi } from 'vitest'
import type { PlanRef, SessionPlan } from '@shared/plan'
import { createPlansStore, planSession } from '../plans-store'
import { planStateRef, PlansApiError, type PlansApi } from '../plans-api'
function state(threadId = 't', version = 3): SessionPlan {
  return {
    threadId,
    version,
    mode: 'awaiting_approval',
    planId: 'p',
    revision: 1,
    body: 'plan',
    feedback: null,
    approval: null,
    updatedAt: new Date().toISOString()
  }
}
const result = (value: SessionPlan): { state: SessionPlan; ref: PlanRef | null } => ({
  state: value,
  ref: planStateRef(value)
})
function api(): PlansApi {
  return {
    get: vi.fn(async (thread) => result(state(thread))),
    enter: vi.fn(),
    decision: vi.fn(),
    cancel: vi.fn(),
    resumeRequest: vi.fn(async (threadId, ref) => ({
      url: '/plans/resume',
      init: { method: 'POST' as const, headers: {}, body: JSON.stringify({ threadId, ref }) }
    }))
  }
}
it('materialize-triggered automatic load and explicit enter load await the same server result', async () => {
  const service = api()
  let finish!: (value: ReturnType<typeof result>) => void
  service.get = vi.fn(
    () =>
      new Promise<ReturnType<typeof result>>((resolve) => {
        finish = resolve
      })
  )
  const store = createPlansStore({ api: service, onResume: async () => {} })
  const automatic = store.getState().load('t')
  let continued = false
  const explicit = store
    .getState()
    .load('t')
    .then(() => {
      continued = true
    })
  await Promise.resolve()
  expect(continued).toBe(false)
  expect(service.get).toHaveBeenCalledTimes(1)
  finish(result(state()))
  await Promise.all([automatic, explicit])
  expect(planSession(store.getState(), 't').state?.version).toBe(3)
})
it('shared load failure unlocks, retries and forget cancels waiters without cross-thread deadlock', async () => {
  const service = api()
  let reject!: (failure: Error) => void
  service.get = vi.fn(
    () =>
      new Promise<ReturnType<typeof result>>((_resolve, fail) => {
        reject = fail
      })
  )
  const store = createPlansStore({ api: service, onResume: async () => {} })
  const first = store.getState().load('t')
  const second = store.getState().load('t')
  const failed = Promise.allSettled([first, second])
  reject(new Error('load failed'))
  expect((await failed).every((entry) => entry.status === 'rejected')).toBe(true)
  expect(planSession(store.getState(), 't').busy).toBe(false)
  service.get = vi.fn(async (thread) => result(state(thread)))
  await store.getState().load('t')
  service.get = vi.fn(() => new Promise<ReturnType<typeof result>>(() => {}))
  const pending = store.getState().load('t')
  const cancelled = expect(pending).rejects.toThrow('已失效')
  store.getState().forget('t')
  await cancelled
  service.get = vi.fn(async (thread) => result(state(thread)))
  await store.getState().load('other')
  await store.getState().load('t')
  expect(planSession(store.getState(), 't').busy).toBe(false)
})
it('keeps approved pending until explicit same-Chat resume and never synthesizes finished/history', async () => {
  const service = api()
  const approved = { ...state(), version: 4, approval: { runId: 'r', toolCallId: 'c' } }
  service.decision = vi.fn(async () => result(approved))
  const onResume = vi.fn(async () => {})
  const store = createPlansStore({ api: service, onResume })
  await store.getState().load('t')
  await store.getState().approve('t', planStateRef(state())!)
  expect(onResume).not.toHaveBeenCalled()
  expect(planSession(store.getState(), 't').state?.mode).toBe('awaiting_approval')
  service.get = vi.fn(async () => result({ ...approved, version: 5, mode: 'executing' }))
  await store.getState().resume('t', planStateRef(approved)!)
  expect(onResume).toHaveBeenCalledWith('t', expect.objectContaining({ url: '/plans/resume' }))
  expect(planSession(store.getState(), 't').state?.mode).toBe('executing')
})
it('isolates threads, drops late forgotten responses and preserves confirmed state on cancel failure', async () => {
  const service = api()
  let finish!: (value: ReturnType<typeof result>) => void
  service.get = vi.fn((thread) =>
    thread === 't'
      ? new Promise<ReturnType<typeof result>>((resolve) => {
          finish = resolve
        })
      : Promise.resolve(result(state(thread)))
  )
  const store = createPlansStore({ api: service, onResume: vi.fn(async () => {}) })
  const old = store.getState().load('t')
  await store.getState().load('other')
  store.getState().forget('t')
  finish(result(state('t')))
  await expect(old).rejects.toThrow('已失效')
  expect(store.getState().sessions.t).toBeUndefined()
  service.cancel = vi.fn(async () => {
    throw new Error('cancel failed')
  })
  await expect(store.getState().cancel('other', 3)).rejects.toThrow('cancel failed')
  expect(planSession(store.getState(), 'other').state?.mode).toBe('awaiting_approval')
})
it('409 refreshes without resubmitting approval and permits identical failure retry', async () => {
  const service = api()
  service.decision = vi.fn(async () => {
    throw new PlansApiError(409, '冲突')
  })
  const store = createPlansStore({ api: service, onResume: vi.fn(async () => {}) })
  await store.getState().load('t')
  for (let attempt = 1; attempt <= 2; attempt++) {
    await expect(store.getState().approve('t', planStateRef(state())!)).rejects.toThrow('冲突')
    expect(planSession(store.getState(), 't').busy).toBe(false)
    expect(planSession(store.getState(), 't').error).toContain('确认后重新操作')
    expect(service.decision).toHaveBeenCalledTimes(attempt)
  }
  expect(planSession(store.getState(), 't').state?.approval).toBeNull()
})
