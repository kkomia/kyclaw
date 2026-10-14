/**
 * 会话↔Word **源结构**映射：哪份 .docx 是用哪种结构渲染出来的 —— 落 libsql 的
 * `session_docx_sources` 表。
 *
 * 与 `session-ppt-sources.ts` 同一套做法（连"不带内存镜像"这条也一致）：这张表只被 `edit_docx`
 * 读（一次编辑读一次），而 `edit_docx` 的执行本来就是 async —— 所以每次 `find` 直连库读一行，
 * 少一份镜像就少一份"内存与表不一致"的可能。表结构：主键 `(thread_id, path)` —— 一条会话里可以
 * 有好几份文档，只有 threadId 分不出是哪一份。建表/读写的做法与邻居一致：`ensureTable` 幂等 +
 * 客户端形状检查（拿不到就显式抛，不静默丢写）；行数据进出一律过 shared/session-docx-sources.ts
 * 的 zod（库里的行坏了要当场看出来，不是喂给模型）。
 */
import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import {
  docxSourceRecordInputSchema,
  docxSourceRecordSchema,
  type DocxSourceRecord,
  type DocxSourceRecordInput
} from '../shared/session-docx-sources'
import { sha256Of } from './fingerprint'

/** 表名（自建表，与 Mastra 自己的表同库不同表） */
export const SESSION_DOCX_SOURCES_TABLE = 'session_docx_sources'

export { sha256Of }

export interface SessionDocxSourceStore {
  /** 建表（幂等；内部缓存，重复调用只建一次） */
  ensureTable(): Promise<void>
  /** 这条会话里这个文件的源结构；没有回 null */
  find(threadId: string, path: string): Promise<DocxSourceRecord | null>
  /** 记一份（同一会话同一路径 = 覆盖；写库失败就抛，不假装成功） */
  record(input: DocxSourceRecordInput): Promise<void>
  /** 摘掉（幂等）。`path` 省略 = 这条会话整片摘掉（会话被删时走这条） */
  clear(threadId: string, path?: string): Promise<void>
  /** 这条会话**记着的那些**（给"没有源"的失败回执指路：这个会话里其实有哪几份）；不给 threadId = 全表，测试与排障用 */
  list(threadId?: string): Promise<DocxSourceRecord[]>
}

/**
 * libsql 客户端：`LibSQLStore` 没有公开的自定义 SQL 口子，client 是它的构造期字段
 * （运行时是真属性）。形状不对就抛——宁可让映射显式失败，也不要静默丢写。
 * （与 session-ppt-sources.ts / usage.ts / session-projects.ts 同一份检查，报错指向本文件。）
 */
function clientOf(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (client === undefined || typeof client.execute !== 'function') {
    throw new Error(
      '拿不到 libsql 客户端（LibSQLStore.client 形状变了）：升级 @mastra/libsql 后要复查 session-docx-sources.ts'
    )
  }
  return client
}

function rowText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function rowNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** 一行 → 记录；行坏了（缺列 / 形状不对）返回 null，由调用方当"没有这一条"处理 */
function recordOf(row: Record<string, unknown>): DocxSourceRecord | null {
  const parsed = docxSourceRecordSchema.safeParse({
    threadId: rowText(row.thread_id),
    path: rowText(row.path),
    sourceJson: rowText(row.source_json),
    blocks: rowNumber(row.blocks),
    sha256: rowText(row.sha256),
    size: rowNumber(row.size),
    updatedAt: rowText(row.updated_at)
  })
  return parsed.success ? parsed.data : null
}

export function createSessionDocxSourceStore(storage: LibSQLStore): SessionDocxSourceStore {
  const client = clientOf(storage)
  let ready: Promise<void> | null = null

  const ensureTable = (): Promise<void> => {
    ready ??= (async () => {
      await client.execute(
        `CREATE TABLE IF NOT EXISTS "${SESSION_DOCX_SOURCES_TABLE}" (
          "thread_id" TEXT NOT NULL,
          "path" TEXT NOT NULL,
          "source_json" TEXT NOT NULL,
          "blocks" INTEGER NOT NULL,
          "sha256" TEXT NOT NULL,
          "size" INTEGER NOT NULL,
          "updated_at" TEXT NOT NULL,
          PRIMARY KEY ("thread_id", "path")
        )`
      )
    })().catch((error: unknown) => {
      ready = null // 失败不缓存：下一次调用再试一遍
      throw error
    })
    return ready
  }

  const select = async (
    where: string,
    args: Array<string | number>
  ): Promise<DocxSourceRecord[]> => {
    await ensureTable()
    const result = await client.execute({
      sql: `SELECT "thread_id", "path", "source_json", "blocks", "sha256", "size", "updated_at" FROM "${SESSION_DOCX_SOURCES_TABLE}" WHERE ${where} ORDER BY "updated_at" DESC`,
      args
    })
    const records: DocxSourceRecord[] = []
    for (const row of result.rows) {
      const record = recordOf(row as Record<string, unknown>)
      if (record !== null) records.push(record)
    }
    return records
  }

  return {
    ensureTable,

    async find(threadId, path) {
      const records = await select('"thread_id" = ? AND "path" = ?', [threadId, path])
      return records[0] ?? null
    },

    async record(input) {
      const data = docxSourceRecordInputSchema.parse(input)
      await ensureTable()
      await client.execute({
        sql: `INSERT OR REPLACE INTO "${SESSION_DOCX_SOURCES_TABLE}" ("thread_id", "path", "source_json", "blocks", "sha256", "size", "updated_at") VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          data.threadId,
          data.path,
          data.sourceJson,
          data.blocks,
          data.sha256,
          data.size,
          new Date().toISOString()
        ]
      })
    },

    async clear(threadId, path) {
      await ensureTable()
      if (path === undefined) {
        await client.execute({
          sql: `DELETE FROM "${SESSION_DOCX_SOURCES_TABLE}" WHERE "thread_id" = ?`,
          args: [threadId]
        })
        return
      }
      await client.execute({
        sql: `DELETE FROM "${SESSION_DOCX_SOURCES_TABLE}" WHERE "thread_id" = ? AND "path" = ?`,
        args: [threadId, path]
      })
    },

    async list(threadId) {
      return threadId === undefined
        ? await select('1 = 1', [])
        : await select('"thread_id" = ?', [threadId])
    }
  }
}
