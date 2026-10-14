import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import { randomUUID } from 'node:crypto'
import {
  taskSnapshotSchema,
  taskThreadIdSchema,
  taskWriteSchema,
  type TaskItem,
  type TaskSnapshot,
  type TaskWrite,
  type TodoOutput
} from '../shared/tasks'

export const SESSION_TASK_REVISIONS_TABLE = 'session_task_revisions'
const HEADS_TABLE = 'session_task_heads'

export interface TaskWriteOrigin {
  origin: 'tool' | 'user'
  messageId?: string
  toolCallId?: string
}

export interface TaskRevision extends TaskWriteOrigin {
  origin: 'tool' | 'user'
  revision: number
  snapshot: TaskSnapshot
  createdAt: string
}

export interface SessionTaskStore {
  ensureTable(): Promise<void>
  get(threadId: string): Promise<TaskSnapshot>
  listRevisions(threadId: string): Promise<TaskRevision[]>
  apply(threadId: string, input: TaskWrite, origin: TaskWriteOrigin): Promise<TodoOutput>
  clear(threadId: string): Promise<TaskSnapshot>
  truncate(threadId: string, deletedMessageIds: readonly string[]): Promise<TaskSnapshot>
}

export class TaskValidationError extends Error {}

function clientOf(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (!client || typeof client.execute !== 'function' || typeof client.transaction !== 'function') {
    throw new Error('拿不到 libsql 事务客户端：升级 @mastra/libsql 后要复查 session-tasks.ts')
  }
  return client
}

function emptySnapshot(): TaskSnapshot {
  return { revision: 0, items: [], updatedAt: null }
}

function snapshotOf(row: Record<string, unknown> | undefined): TaskSnapshot {
  if (row === undefined) return emptySnapshot()
  const snapshot = taskSnapshotSchema.parse(JSON.parse(String(row.snapshot_json)))
  if (snapshot.revision !== Number(row.revision)) throw new Error('任务快照版本与数据库不一致')
  return snapshot
}

function nextRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('任务版本号已耗尽')
  return revision + 1
}

function changedItems(current: TaskSnapshot, input: TaskWrite, now: string): TaskItem[] {
  const old = new Map(current.items.map((item) => [item.id, item]))
  if (input.action === 'replace') {
    return input.items.map((item) => {
      const previous = item.id === undefined ? undefined : old.get(item.id)
      if (item.id !== undefined && previous === undefined) {
        throw new TaskValidationError('replace 包含未知任务 id')
      }
      return {
        ...item,
        id: previous?.id ?? randomUUID(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      }
    })
  }
  const changes = new Map(input.changes.map((change) => [change.id, change]))
  for (const id of changes.keys()) {
    if (!old.has(id)) throw new TaskValidationError('update 包含未知任务 id')
  }
  return current.items.map((item) => {
    const change = changes.get(item.id)
    if (change === undefined) return item
    const note = change.note === undefined ? item.note : change.note
    const result: TaskItem = {
      ...item,
      title: change.title ?? item.title,
      status: change.status ?? item.status,
      updatedAt: now
    }
    if (note === null || note === undefined) delete result.note
    else result.note = note
    return result
  })
}

export function createSessionTaskStore(storage: LibSQLStore): SessionTaskStore {
  const client = clientOf(storage)
  let ready: Promise<void> | null = null
  const ensureTable = (): Promise<void> => {
    ready ??= (async () => {
      await client.execute(`CREATE TABLE IF NOT EXISTS "${HEADS_TABLE}" (
        thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL
      )`)
      await client.execute(`CREATE TABLE IF NOT EXISTS "${SESSION_TASK_REVISIONS_TABLE}" (
        thread_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        origin TEXT NOT NULL, message_id TEXT, tool_call_id TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, revision)
      )`)
    })().catch((error: unknown) => {
      ready = null
      throw error
    })
    return ready
  }

  const selectHead = async (
    executor: Pick<SqliteClient, 'execute'>,
    threadId: string
  ): Promise<TaskSnapshot> => {
    const result = await executor.execute({
      sql: `SELECT revision, snapshot_json FROM "${HEADS_TABLE}" WHERE thread_id = ?`,
      args: [threadId]
    })
    return snapshotOf(result.rows[0])
  }

  const beginWrite = async (): Promise<Awaited<ReturnType<SqliteClient['transaction']>>> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.transaction('write')
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (!code.startsWith('SQLITE_BUSY') || attempt >= 20) throw error
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  }

  const mutate = async (
    threadId: string,
    work: (
      tx: Awaited<ReturnType<SqliteClient['transaction']>>,
      current: TaskSnapshot
    ) => Promise<TodoOutput>
  ): Promise<TodoOutput> => {
    taskThreadIdSchema.parse(threadId)
    await ensureTable()
    const tx = await beginWrite()
    try {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO "${HEADS_TABLE}" (thread_id, revision, snapshot_json) VALUES (?, 0, ?)`,
        args: [threadId, JSON.stringify(emptySnapshot())]
      })
      const result = await work(tx, await selectHead(tx, threadId))
      await tx.commit()
      return result
    } catch (error) {
      if (!tx.closed) await tx.rollback()
      throw error
    } finally {
      tx.close()
    }
  }

  const writeHead = async (
    tx: Pick<SqliteClient, 'execute'>,
    threadId: string,
    current: TaskSnapshot,
    snapshot: TaskSnapshot
  ): Promise<void> => {
    const result = await tx.execute({
      sql: `UPDATE "${HEADS_TABLE}" SET revision = ?, snapshot_json = ? WHERE thread_id = ? AND revision = ?`,
      args: [snapshot.revision, JSON.stringify(snapshot), threadId, current.revision]
    })
    if (result.rowsAffected !== 1) throw new Error('任务数据库 CAS 失败')
  }

  return {
    ensureTable,
    async get(threadId) {
      taskThreadIdSchema.parse(threadId)
      await ensureTable()
      return selectHead(client, threadId)
    },
    async listRevisions(threadId) {
      taskThreadIdSchema.parse(threadId)
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT * FROM "${SESSION_TASK_REVISIONS_TABLE}" WHERE thread_id = ? ORDER BY revision`,
        args: [threadId]
      })
      return result.rows.map((row) => {
        const origin = String(row.origin)
        if (origin !== 'tool' && origin !== 'user') throw new Error('任务版本来源损坏')
        return {
          origin,
          revision: Number(row.revision),
          snapshot: snapshotOf(row),
          ...(row.message_id === null ? {} : { messageId: String(row.message_id) }),
          ...(row.tool_call_id === null ? {} : { toolCallId: String(row.tool_call_id) }),
          createdAt: String(row.created_at)
        }
      })
    },
    async apply(threadId, rawInput, origin) {
      const parsed = taskWriteSchema.safeParse(rawInput)
      if (!parsed.success) throw new TaskValidationError(parsed.error.message)
      if (origin.origin !== 'tool' && origin.origin !== 'user')
        throw new TaskValidationError('任务来源无效')
      if (origin.origin === 'tool' && (!origin.messageId?.trim() || !origin.toolCallId?.trim())) {
        throw new TaskValidationError('任务工具缺少可信消息身份')
      }
      return mutate(threadId, async (tx, current) => {
        if (parsed.data.expectedRevision !== current.revision)
          return { status: 'conflict', snapshot: current }
        const now = new Date().toISOString()
        const checked = taskSnapshotSchema.safeParse({
          revision: nextRevision(current.revision),
          items: changedItems(current, parsed.data, now),
          updatedAt: now
        })
        if (!checked.success) throw new TaskValidationError(checked.error.message)
        const snapshot = checked.data
        await writeHead(tx, threadId, current, snapshot)
        await tx.execute({
          sql: `INSERT INTO "${SESSION_TASK_REVISIONS_TABLE}" (thread_id, revision, snapshot_json, origin, message_id, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            threadId,
            snapshot.revision,
            JSON.stringify(snapshot),
            origin.origin,
            origin.messageId ?? null,
            origin.toolCallId ?? null,
            now
          ]
        })
        return { status: 'ok', snapshot }
      })
    },
    async clear(threadId) {
      const result = await mutate(threadId, async (tx, current) => {
        const snapshot = {
          revision: nextRevision(current.revision),
          items: [],
          updatedAt: new Date().toISOString()
        }
        await writeHead(tx, threadId, current, snapshot)
        await tx.execute({
          sql: `DELETE FROM "${SESSION_TASK_REVISIONS_TABLE}" WHERE thread_id = ?`,
          args: [threadId]
        })
        return { status: 'ok', snapshot }
      })
      return result.snapshot
    },
    async truncate(threadId, deletedMessageIds) {
      const result = await mutate(threadId, async (tx, current) => {
        const revisions = await tx.execute({
          sql: `SELECT * FROM "${SESSION_TASK_REVISIONS_TABLE}" WHERE thread_id = ? ORDER BY revision`,
          args: [threadId]
        })
        const ids = new Set(deletedMessageIds)
        const index = revisions.rows.findIndex(
          (row) => row.message_id !== null && ids.has(String(row.message_id))
        )
        if (index === -1) return { status: 'ok', snapshot: current }
        const cutoff = Number(revisions.rows[index].revision)
        const previous = index === 0 ? emptySnapshot() : snapshotOf(revisions.rows[index - 1])
        const snapshot = taskSnapshotSchema.parse({
          ...previous,
          revision: nextRevision(current.revision),
          updatedAt: new Date().toISOString()
        })
        await tx.execute({
          sql: `DELETE FROM "${SESSION_TASK_REVISIONS_TABLE}" WHERE thread_id = ? AND revision >= ?`,
          args: [threadId, cutoff]
        })
        await writeHead(tx, threadId, current, snapshot)
        return { status: 'ok', snapshot }
      })
      return result.snapshot
    }
  }
}
