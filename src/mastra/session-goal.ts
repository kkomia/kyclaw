/**
 * PB-039 goal 的服务端权威状态（`session_goals` 单行 + revision CAS + 进程本地 activation）。
 *
 * 语义照抄 DSH `@deepseek-ai/dsh-goal`（0.2.1-rc.2；证据行号见共享契约 `src/shared/goal.ts` 头注）：
 *   - 每会话至多一个当前 goal；未完成时 create → `GOAL_ALREADY_EXISTS`；
 *   - 每次变更 revision + 1；所有写操作都必须带 `{id, revision}`，陈旧即 `GOAL_STALE_REVISION`；
 *   - `activation`（armed/disarmed）**只存在进程内 Map**：重启/加载会话即 disarmed，只有 resume 会 armed；
 *   - 默认轮上限 256；resume 在轮数用尽时拒绝；block **仅 active**。
 *
 * 与 `session-plan.ts` 同一套存储做法（libsql client + write transaction + CAS UPDATE），
 * 不引入新的存储依赖。
 */
import { randomUUID } from 'node:crypto'
import type { LibSQLStore, SqliteClient, SqliteTransaction } from '@mastra/libsql'
import {
  DEFAULT_MAX_GOAL_ROUNDS,
  GOAL_ERROR_STATUS,
  GOAL_ERROR_TEXT,
  goalBlockedReasonSchema,
  goalThreadIdSchema,
  goalViewSchema,
  type GoalActivation,
  type GoalBlockedReason,
  type GoalErrorCode,
  type GoalRef,
  type GoalState,
  type GoalView
} from '../shared/goal'

export const SESSION_GOAL_TABLE = 'session_goals'

/** goal 领域错误：HTTP 路由与模型工具都按 `code` 分派，`message` 是给用户看的中文 */
export class SessionGoalError extends Error {
  readonly code: GoalErrorCode
  readonly status: 400 | 404 | 409 | 500

  constructor(code: GoalErrorCode) {
    super(GOAL_ERROR_TEXT[code])
    this.name = 'SessionGoalError'
    this.code = code
    this.status = GOAL_ERROR_STATUS[code]
  }
}

/** 抛领域错误（helper：让调用点读起来是 `throw goalError('GOAL_…')`） */
export function goalError(code: GoalErrorCode): SessionGoalError {
  return new SessionGoalError(code)
}

export interface GoalRoundAdmission {
  goalId: string
  revision: number
  round: number
}

export interface SessionGoalStore {
  ensureTable(): Promise<void>
  /** 读状态（无 goal → `{goal:null, activation}`；不 404） */
  state(threadId: string): Promise<GoalState>
  create(threadId: string, objective: string, maxGoalRounds?: number): Promise<GoalState>
  edit(
    threadId: string,
    ref: GoalRef,
    patch: { objective?: string; maxGoalRounds?: number }
  ): Promise<GoalState>
  pause(threadId: string, ref: GoalRef): Promise<GoalState>
  resume(threadId: string, ref: GoalRef): Promise<GoalState>
  complete(threadId: string, ref: GoalRef): Promise<GoalState>
  block(threadId: string, ref: GoalRef, blocked: GoalBlockedReason): Promise<GoalState>
  clear(threadId: string, ref: GoalRef): Promise<GoalState>
  /** 只改 activation（不动 phase / revision）：客户端 abort、流错误、用户停止时用 */
  disarm(threadId: string): Promise<GoalState>
  /**
   * goal round **准入**（DSH「先预留后准入」里的准入侧）：校验 goal 仍在、revision 匹配、
   * phase 仍是 active、轮数还有余量；通过才 `roundsStarted + 1`（revision 同步 +1，让并发的
   * 陈旧轮在 CAS 上被拒）。不通过抛 `GOAL_STALE_REVISION` / `GOAL_INVALID_TRANSITION`。
   */
  admitRound(threadId: string, admission: GoalRoundAdmission): Promise<GoalState>
}

function clientOf(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (!client || typeof client.execute !== 'function' || typeof client.transaction !== 'function') {
    throw new Error('Goal: incompatible LibSQLStore.client; execute/transaction required')
  }
  return client
}

interface StoredRow {
  revision: number
  goal: GoalView | null
}

function decodeRow(row: Record<string, unknown>): StoredRow {
  const revision = Number(row.revision)
  const raw = row.goal_json === null || row.goal_json === undefined ? null : String(row.goal_json)
  if (raw === null) return { revision, goal: null }
  const goal = goalViewSchema.parse(JSON.parse(raw))
  if (goal.revision !== revision) throw new Error('Goal: corrupt revision binding')
  return { revision, goal }
}

function assertRef(goal: GoalView | null, ref: GoalRef): GoalView {
  if (goal === null) throw goalError('GOAL_NOT_FOUND')
  if (goal.id !== ref.id || goal.revision !== ref.revision)
    throw goalError('GOAL_STALE_REVISION')
  return goal
}

/** 只有 active 能 pause/block（DSH `:676-678`、`:720-728`） */
function assertActive(goal: GoalView): void {
  if (goal.phase !== 'active') throw goalError('GOAL_INVALID_TRANSITION')
}

export function createSessionGoalStore(storage: LibSQLStore): SessionGoalStore {
  const client = clientOf(storage)
  /** 进程本地：不落库；新进程/新会话一律 disarmed（DSH `:94-99,594-596`） */
  const activation = new Map<string, GoalActivation>()
  let ready: Promise<void> | null = null

  const ensureTable = (): Promise<void> => {
    ready ??= client
      .execute(
        `CREATE TABLE IF NOT EXISTS "${SESSION_GOAL_TABLE}" (
      thread_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      goal_json TEXT
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
  ): Promise<StoredRow | null> => {
    const result = await db.execute({
      sql: `SELECT revision, goal_json FROM "${SESSION_GOAL_TABLE}" WHERE thread_id = ?`,
      args: [threadId]
    })
    return result.rows[0] ? decodeRow(result.rows[0]) : null
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

  const activationOf = (threadId: string): GoalActivation =>
    activation.get(threadId) ?? 'disarmed'

  const stateOf = async (threadId: string): Promise<GoalState> => {
    const thread = goalThreadIdSchema.parse(threadId)
    await ensureTable()
    const row = await select(client, thread)
    return { goal: row?.goal ?? null, activation: activationOf(thread) }
  }

  /** CAS 写：`WHERE revision = ?`，写不中就说明别人先改了 → STALE */
  const write = async (
    tx: SqliteTransaction,
    threadId: string,
    expectedRevision: number,
    goal: GoalView | null
  ): Promise<void> => {
    const nextRevision = expectedRevision + 1
    const result = await tx.execute({
      sql: `UPDATE "${SESSION_GOAL_TABLE}" SET revision = ?, goal_json = ? WHERE thread_id = ? AND revision = ?`,
      args: [nextRevision, goal === null ? null : JSON.stringify({ ...goal, revision: nextRevision }), threadId, expectedRevision]
    })
    if (result.rowsAffected !== 1) throw goalError('GOAL_STALE_REVISION')
  }

  /** 统一改状态：读 → 校验 → 改 → CAS 写 → 事务后改 activation */
  const transition = async (
    threadIdInput: string,
    ref: GoalRef,
    mutate: (goal: GoalView) => { goal: GoalView; activation: GoalActivation }
  ): Promise<GoalState> => {
    const threadId = goalThreadIdSchema.parse(threadIdInput)
    const next = await transaction(async (tx) => {
      const row = await select(tx, threadId)
      if (row === null) throw goalError('GOAL_NOT_FOUND')
      const goal = assertRef(row.goal, ref)
      const changed = mutate(goal)
      const stamped = goalViewSchema.parse({
        ...changed.goal,
        updatedAt: Date.now()
      })
      await write(tx, threadId, row.revision, stamped)
      return { goal: { ...stamped, revision: row.revision + 1 }, activation: changed.activation }
    })
    activation.set(threadId, next.activation)
    return { goal: next.goal, activation: next.activation }
  }

  return {
    ensureTable,

    async state(threadId) {
      return stateOf(threadId)
    },

    async create(threadIdInput, objective, maxGoalRounds = DEFAULT_MAX_GOAL_ROUNDS) {
      const threadId = goalThreadIdSchema.parse(threadIdInput)
      const goal = await transaction(async (tx) => {
        const row = await select(tx, threadId)
        // DSH `:638-639`：还有未完成 goal（phase !== complete）→ 拒绝
        if (row?.goal && row.goal.phase !== 'complete') throw goalError('GOAL_ALREADY_EXISTS')
        const now = Date.now()
        const created = goalViewSchema.parse({
          id: randomUUID(),
          revision: 1,
          objective,
          phase: 'active',
          roundsStarted: 0,
          maxGoalRounds,
          createdAt: now,
          updatedAt: now
        })
        if (row === null) {
          const result = await tx.execute({
            sql: `INSERT INTO "${SESSION_GOAL_TABLE}" (thread_id, revision, goal_json) VALUES (?, ?, ?)`,
            args: [threadId, 1, JSON.stringify(created)]
          })
          if (result.rowsAffected !== 1) throw goalError('GOAL_STORAGE_ERROR')
        } else {
          // 旧的 complete goal 可被替换（DSH `:635-648`）
          const result = await tx.execute({
            sql: `UPDATE "${SESSION_GOAL_TABLE}" SET revision = ?, goal_json = ? WHERE thread_id = ? AND revision = ?`,
            args: [1, JSON.stringify(created), threadId, row.revision]
          })
          if (result.rowsAffected !== 1) throw goalError('GOAL_STALE_REVISION')
        }
        return created
      })
      activation.set(threadId, 'armed')
      return { goal, activation: 'armed' }
    },

    async edit(threadId, ref, patch) {
      if (patch.objective === undefined && patch.maxGoalRounds === undefined)
        throw goalError('GOAL_INVALID_EDIT')
      return transition(threadId, ref, (goal) => ({
        goal: {
          ...goal,
          objective: patch.objective ?? goal.objective,
          maxGoalRounds: patch.maxGoalRounds ?? goal.maxGoalRounds
        },
        activation: activationOf(goalThreadIdSchema.parse(threadId))
      }))
    },

    async pause(threadId, ref) {
      return transition(threadId, ref, (goal) => {
        assertActive(goal)
        return { goal: { ...goal, phase: 'paused' }, activation: 'disarmed' }
      })
    },

    async resume(threadId, ref) {
      const thread = goalThreadIdSchema.parse(threadId)
      return transition(thread, ref, (goal) => {
        if (goal.phase === 'complete') throw goalError('GOAL_INVALID_TRANSITION')
        if (goal.roundsStarted >= goal.maxGoalRounds) throw goalError('GOAL_INVALID_TRANSITION')
        // DSH `:696`：已 armed 再 resume 报错（activation 不在 goal 里，用闭包 Map 判）
        if (activationOf(thread) === 'armed' && goal.phase === 'active')
          throw goalError('GOAL_INVALID_TRANSITION')
        return { goal: { ...goal, phase: 'active' }, activation: 'armed' }
      })
    },

    async complete(threadId, ref) {
      return transition(threadId, ref, (goal) => ({
        goal: { ...goal, phase: 'complete', blockedReason: undefined },
        activation: 'disarmed'
      }))
    },

    async block(threadId, ref, blocked) {
      const reason = goalBlockedReasonSchema.parse(blocked)
      return transition(threadId, ref, (goal) => {
        assertActive(goal) // DSH `:720-728`：仅 active
        return { goal: { ...goal, phase: 'blocked', blockedReason: reason }, activation: 'disarmed' }
      })
    },

    async clear(threadIdInput, ref) {
      const threadId = goalThreadIdSchema.parse(threadIdInput)
      await transaction(async (tx) => {
        const row = await select(tx, threadId)
        if (row === null) throw goalError('GOAL_NOT_FOUND')
        assertRef(row.goal, ref)
        // 保留一行墓碑：旧客户端的陈旧 ref 会拿到 STALE（而不是 NOT_FOUND）
        const result = await tx.execute({
          sql: `UPDATE "${SESSION_GOAL_TABLE}" SET revision = ?, goal_json = NULL WHERE thread_id = ? AND revision = ?`,
          args: [row.revision + 1, threadId, row.revision]
        })
        if (result.rowsAffected !== 1) throw goalError('GOAL_STALE_REVISION')
      })
      activation.set(threadId, 'disarmed')
      return { goal: null, activation: 'disarmed' }
    },

    async disarm(threadIdInput) {
      const threadId = goalThreadIdSchema.parse(threadIdInput)
      activation.set(threadId, 'disarmed')
      return stateOf(threadId)
    },

    async admitRound(threadIdInput, admission) {
      const threadId = goalThreadIdSchema.parse(threadIdInput)
      const goal = await transaction(async (tx) => {
        const row = await select(tx, threadId)
        if (row === null) throw goalError('GOAL_STALE_REVISION')
        const current = row.goal
        if (current === null || current.id !== admission.goalId)
          throw goalError('GOAL_STALE_REVISION')
        if (current.revision !== admission.revision) throw goalError('GOAL_STALE_REVISION')
        if (current.phase !== 'active') throw goalError('GOAL_INVALID_TRANSITION')
        if (current.roundsStarted >= current.maxGoalRounds)
          throw goalError('GOAL_INVALID_TRANSITION')
        // 预留的轮号必须正好是下一轮（防重放/并发跳号）
        if (admission.round !== current.roundsStarted + 1)
          throw goalError('GOAL_STALE_REVISION')
        const admitted = goalViewSchema.parse({
          ...current,
          roundsStarted: current.roundsStarted + 1,
          updatedAt: Date.now()
        })
        const baseRevision = row.revision
        await write(tx, threadId, baseRevision, admitted)
        return { ...admitted, revision: baseRevision + 1 }
      })
      return { goal, activation: activationOf(threadId) }
    }
  }
}

