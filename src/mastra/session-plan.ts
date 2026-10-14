import type { LibSQLStore, SqliteClient, SqliteTransaction } from '@mastra/libsql'
import { randomUUID } from 'node:crypto'
import {
  planBindingSchema,
  planRefSchema,
  planThreadIdSchema,
  sessionPlanSchema,
  submitPlanSchema,
  userPlanDecisionSchema,
  type PlanBinding,
  type PlanRef,
  type SessionPlan,
  type SubmitPlan,
  type UserPlanDecision
} from '../shared/plan'

export const SESSION_PLAN_TABLE = 'session_plans'

export interface SessionPlanStore {
  ensureTable(): Promise<void>
  clear(threadId: string): Promise<void>
  invalidate(threadId: string): Promise<SessionPlan>
  initialize(threadId: string): Promise<SessionPlan>
  find(threadId: string): Promise<SessionPlan | null>
  enter(threadId: string, expectedVersion: number): Promise<SessionPlan>
  submit(threadId: string, input: SubmitPlan): Promise<SessionPlan>
  decide(threadId: string, input: UserPlanDecision): Promise<SessionPlan>
  consume(threadId: string, ref: PlanRef, binding: PlanBinding): Promise<SessionPlan>
  cancel(threadId: string, expectedVersion: number): Promise<SessionPlan>
  finish(threadId: string, ref: PlanRef, runId: string): Promise<SessionPlan>
  resetCancelled(threadId: string, expectedVersion: number): Promise<SessionPlan>
  reviseSuspended(
    threadId: string,
    ref: PlanRef,
    feedback: string,
    binding: PlanBinding
  ): Promise<SessionPlan>
  consumeRevision(threadId: string, ref: PlanRef, binding: PlanBinding): Promise<SessionPlan>
}

function clientOf(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (!client || typeof client.execute !== 'function' || typeof client.transaction !== 'function') {
    throw new Error('Plan: incompatible LibSQLStore.client; execute/transaction required')
  }
  return client
}

function decode(threadId: string, row: Record<string, unknown>): SessionPlan {
  const state = sessionPlanSchema.parse(JSON.parse(String(row.state_json)))
  if (state.threadId !== threadId || state.version !== Number(row.version)) {
    throw new Error('Plan: corrupt thread/version binding')
  }
  return state
}

function assertRef(state: SessionPlan, input: PlanRef): void {
  const ref = planRefSchema.parse({
    planId: input.planId,
    revision: input.revision,
    version: input.version
  })
  if (
    state.planId !== ref.planId ||
    state.revision !== ref.revision ||
    state.version !== ref.version
  ) {
    throw new Error('Plan: stale plan reference')
  }
}

function assertVersion(state: SessionPlan, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0 || state.version !== version) {
    throw new Error('Plan: stale state version')
  }
}

function normal(threadId: string, version: number): SessionPlan {
  return {
    threadId,
    version,
    mode: 'normal',
    planId: null,
    revision: 0,
    body: null,
    feedback: null,
    approval: null,
    updatedAt: new Date().toISOString()
  }
}

export function createSessionPlanStore(storage: LibSQLStore): SessionPlanStore {
  const client = clientOf(storage)
  let ready: Promise<void> | null = null
  const ensureTable = (): Promise<void> => {
    ready ??= client
      .execute(
        `CREATE TABLE IF NOT EXISTS "${SESSION_PLAN_TABLE}" (
      thread_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, state_json TEXT NOT NULL
    )`
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        ready = null
        throw error
      })
    return ready
  }
  const select = async (
    db: Pick<SqliteClient, 'execute'> | SqliteTransaction,
    threadId: string
  ): Promise<SessionPlan | null> => {
    const result = await db.execute({
      sql: `SELECT version, state_json FROM "${SESSION_PLAN_TABLE}" WHERE thread_id = ?`,
      args: [threadId]
    })
    return result.rows[0] ? decode(threadId, result.rows[0]) : null
  }
  const transaction = async <T>(fn: (tx: SqliteTransaction) => Promise<T>): Promise<T> => {
    await ensureTable()
    const tx = await client.transaction('write')
    try {
      const result = await fn(tx)
      await tx.commit()
      return result
    } catch (error) {
      if (!tx.closed) await tx.rollback()
      throw error
    } finally {
      tx.close()
    }
  }
  const mutate = async (
    thread: string,
    fn: (state: SessionPlan) => SessionPlan
  ): Promise<SessionPlan> => {
    const threadId = planThreadIdSchema.parse(thread)
    return transaction(async (tx) => {
      const state = await select(tx, threadId)
      if (!state) throw new Error('Plan: thread state missing')
      const next = sessionPlanSchema.parse({
        ...fn(state),
        threadId,
        version: state.version + 1,
        updatedAt: new Date().toISOString()
      })
      const result = await tx.execute({
        sql: `UPDATE "${SESSION_PLAN_TABLE}" SET version = ?, state_json = ? WHERE thread_id = ? AND version = ?`,
        args: [next.version, JSON.stringify(next), threadId, state.version]
      })
      if (result.rowsAffected !== 1) throw new Error('Plan: concurrent state change')
      return next
    })
  }
  return {
    ensureTable,
    async clear(thread) {
      const threadId = planThreadIdSchema.parse(thread)
      await ensureTable()
      await client.execute({
        sql: `DELETE FROM "${SESSION_PLAN_TABLE}" WHERE thread_id = ?`,
        args: [threadId]
      })
    },
    async invalidate(thread) {
      return mutate(thread, (state) => normal(state.threadId, state.version))
    },
    async initialize(thread) {
      const threadId = planThreadIdSchema.parse(thread)
      return transaction(async (tx) => {
        const state = normal(threadId, 0)
        await tx.execute({
          sql: `INSERT OR IGNORE INTO "${SESSION_PLAN_TABLE}" (thread_id, version, state_json) VALUES (?, ?, ?)`,
          args: [threadId, 0, JSON.stringify(state)]
        })
        const stored = await select(tx, threadId)
        if (!stored) throw new Error('Plan: initialize failed')
        return stored
      })
    },
    async find(thread) {
      const threadId = planThreadIdSchema.parse(thread)
      await ensureTable()
      return select(client, threadId)
    },
    async enter(thread, version) {
      return mutate(thread, (state) => {
        assertVersion(state, version)
        if (state.mode !== 'normal' && state.mode !== 'cancelled')
          throw new Error('Plan: already active')
        return {
          ...state,
          mode: 'planning',
          planId: randomUUID(),
          revision: 1,
          body: null,
          feedback: null,
          approval: null
        }
      })
    },
    async submit(thread, input) {
      const data = submitPlanSchema.parse(input)
      return mutate(thread, (state) => {
        assertRef(state, data)
        if (state.mode !== 'planning' || state.pendingRevision)
          throw new Error('Plan: not ready to submit')
        return { ...state, mode: 'awaiting_approval', body: data.body, approval: null }
      })
    },
    async decide(thread, input) {
      const data = userPlanDecisionSchema.parse(input)
      return mutate(thread, (state) => {
        assertRef(state, data)
        if (state.mode !== 'awaiting_approval') throw new Error('Plan: not awaiting approval')
        if (data.decision === 'cancel') return { ...state, mode: 'cancelled', approval: null }
        if (data.decision === 'revise')
          return {
            ...state,
            mode: 'planning',
            revision: state.revision + 1,
            feedback: data.feedback,
            approval: null
          }
        if (state.approval !== null) throw new Error('Plan: approval already issued')
        return { ...state, approval: data.binding }
      })
    },
    async consume(thread, input, binding) {
      const data = planBindingSchema.parse(binding)
      return mutate(thread, (state) => {
        assertRef(state, input)
        if (
          state.mode !== 'awaiting_approval' ||
          state.approval?.runId !== data.runId ||
          state.approval.toolCallId !== data.toolCallId
        )
          throw new Error('Plan: no matching unconsumed approval')
        return { ...state, mode: 'executing' }
      })
    },
    async cancel(thread, version) {
      return mutate(thread, (state) => {
        assertVersion(state, version)
        if (state.mode === 'normal' || state.mode === 'cancelled')
          throw new Error('Plan: no active plan')
        return { ...state, mode: 'cancelled', approval: null }
      })
    },
    async finish(thread, ref, runId) {
      return mutate(thread, (state) => {
        assertRef(state, ref)
        if (state.mode !== 'executing' || state.approval?.runId !== runId)
          throw new Error('Plan: wrong execution run')
        return normal(state.threadId, state.version)
      })
    },
    async resetCancelled(thread, version) {
      return mutate(thread, (state) => {
        assertVersion(state, version)
        if (state.mode !== 'cancelled') throw new Error('Plan: reset requires cancelled state')
        return normal(state.threadId, state.version)
      })
    },
    async reviseSuspended(thread, ref, feedback, binding) {
      const data = userPlanDecisionSchema.parse({ ...ref, decision: 'revise', feedback })
      const target = planBindingSchema.parse(binding)
      return mutate(thread, (state) => {
        assertRef(state, data)
        if (state.mode !== 'awaiting_approval') throw new Error('Plan: not awaiting approval')
        return {
          ...state,
          mode: 'planning',
          revision: state.revision + 1,
          feedback,
          approval: null,
          pendingRevision: { binding: target, submittedRevision: state.revision }
        }
      })
    },
    async consumeRevision(thread, ref, binding) {
      const target = planBindingSchema.parse(binding)
      return mutate(thread, (state) => {
        assertRef(state, ref)
        if (
          state.mode !== 'planning' ||
          !state.pendingRevision ||
          state.pendingRevision.binding.runId !== target.runId ||
          state.pendingRevision.binding.toolCallId !== target.toolCallId
        )
          throw new Error('Plan: no pending revision decision')
        return { ...state, pendingRevision: undefined }
      })
    }
  }
}
