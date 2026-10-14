// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore, type SqliteClient } from '@mastra/libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionPlanStore, SESSION_PLAN_TABLE, type SessionPlanStore } from '../session-plan'
import type { PlanRef, SessionPlan } from '../../shared/plan'

let dir: string
let storage: LibSQLStore
let store: SessionPlanStore
const binding = { runId: 'r1', toolCallId: 'submit-call' }
function ref(state: SessionPlan): PlanRef {
  if (!state.planId) throw new Error('missing plan')
  return { planId: state.planId, revision: state.revision, version: state.version }
}
async function submitted(): Promise<SessionPlan> {
  const initial = await store.initialize('t1')
  const planning = await store.enter('t1', initial.version)
  return store.submit('t1', { ...ref(planning), body: 'Read, then change the module.' })
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-plan-'))
  storage = new LibSQLStore({
    id: 'plan-test',
    url: `file:${join(dir, 'app.db').replace(/\\/g, '/')}`
  })
  store = createSessionPlanStore(storage)
})
afterEach(async () => {
  await storage.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn('[kyclaw] plan test temp cleanup deferred (libsql handle)', error)
  }
})

describe('persistent server Plan state', () => {
  it('requires explicit thread initialization, rejects default and fake approval', async () => {
    await expect(store.enter('missing', 0)).rejects.toThrow()
    await expect(store.initialize('default')).rejects.toThrow()
    const initial = await store.initialize('t1')
    const planning = await store.enter('t1', initial.version)
    await expect(
      store.submit('t1', { ...ref(planning), body: 'p', approved: true } as never)
    ).rejects.toThrow()
    expect((await store.find('t1'))?.mode).toBe('planning')
  })
  it('approval consumes once, is run/tool/thread bound, and survives real reopen', async () => {
    const submittedState = await submitted()
    const approved = await store.decide('t1', {
      ...ref(submittedState),
      decision: 'approve',
      binding
    })
    await storage.close()
    storage = new LibSQLStore({
      id: 'plan-reopened',
      url: `file:${join(dir, 'app.db').replace(/\\/g, '/')}`
    })
    store = createSessionPlanStore(storage)
    expect(await store.find('t1')).toEqual(approved)
    await store.initialize('t2')
    await expect(store.consume('t2', ref(approved), binding)).rejects.toThrow()
    await expect(
      store.consume('t1', ref(approved), { ...binding, runId: 'other' })
    ).rejects.toThrow()
    await expect(
      store.consume('t1', ref(approved), { ...binding, toolCallId: 'other' })
    ).rejects.toThrow()
    const executing = await store.consume('t1', ref(approved), binding)
    await expect(store.consume('t1', ref(approved), binding)).rejects.toThrow()
    await expect(store.finish('t1', ref(executing), 'other')).rejects.toThrow()
    expect((await store.finish('t1', ref(executing), binding.runId)).mode).toBe('normal')
  })
  it('revision edits invalidate old approval and cancelled state cannot consume', async () => {
    const state = await submitted()
    const approved = await store.decide('t1', { ...ref(state), decision: 'approve', binding })
    const revised = await store.decide('t1', {
      ...ref(approved),
      decision: 'revise',
      feedback: 'Use a smaller change'
    })
    expect(revised.revision).toBe(2)
    expect(revised.approval).toBeNull()
    await expect(store.consume('t1', ref(approved), binding)).rejects.toThrow()
    await expect(store.submit('t1', { ...ref(state), body: 'old' })).rejects.toThrow()
    const next = await store.submit('t1', { ...ref(revised), body: 'smaller plan' })
    await expect(
      store.decide('t1', { ...ref(approved), decision: 'approve', binding })
    ).rejects.toThrow()
    const reapproved = await store.decide('t1', { ...ref(next), decision: 'approve', binding })
    const cancelled = await store.cancel('t1', reapproved.version)
    expect(cancelled.approval).toBeNull()
    await expect(store.consume('t1', ref(reapproved), binding)).rejects.toThrow()
    const newPlan = await store.enter('t1', cancelled.version)
    expect(newPlan.planId).not.toBe(state.planId)
  })
  it('lifecycle reset only clears cancelled state with CAS and invalidates old approvals', async () => {
    const plan = await submitted()
    await expect(store.resetCancelled('t1', plan.version)).rejects.toThrow()
    const approved = await store.decide('t1', { ...ref(plan), decision: 'approve', binding })
    const cancelled = await store.cancel('t1', approved.version)
    await expect(store.resetCancelled('t1', cancelled.version - 1)).rejects.toThrow()
    const reset = await store.resetCancelled('t1', cancelled.version)
    expect(reset.mode).toBe('normal')
    expect(reset.approval).toBeNull()
    expect(reset.planId).toBeNull()
    expect(reset.version).toBe(cancelled.version + 1)
    expect(await createSessionPlanStore(storage).find('t1')).toEqual(reset)
    await expect(store.consume('t1', ref(approved), binding)).rejects.toThrow()
    await expect(store.resetCancelled('t1', reset.version)).rejects.toThrow()
  })
  it('serializes racing approval consumption with transactional CAS', async () => {
    const state = await submitted()
    const approved = await store.decide('t1', { ...ref(state), decision: 'approve', binding })
    const second = createSessionPlanStore(storage)
    await second.ensureTable()
    const results = await Promise.allSettled([
      store.consume('t1', ref(approved), binding),
      second.consume('t1', ref(approved), binding)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })
  it('fails closed on damaged DB state and never repairs it silently', async () => {
    await store.initialize('t1')
    const client = (storage as unknown as { client: SqliteClient }).client
    await client.execute({
      sql: `UPDATE "${SESSION_PLAN_TABLE}" SET state_json = ? WHERE thread_id = ?`,
      args: ['{"mode":"normal"}', 't1']
    })
    await expect(store.find('t1')).rejects.toThrow()
    await expect(store.initialize('t1')).rejects.toThrow()
    await expect(store.enter('t1', 0)).rejects.toThrow()
  })
})
