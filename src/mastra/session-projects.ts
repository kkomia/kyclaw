/**
 * 会话↔项目映射（T18）：哪条会话属于哪个项目 —— 落 libsql 的 `session_projects` 表。
 *
 * 为什么放 libsql（与 `usage_runs` 同库，见 usage.ts 头注）：会话本体（线程/消息）就在这份库里，
 * 映射跟它同寿命、同备份、同删除时机；放 settings.json 会变成"两处事实、各自漂移"。
 * 表很小（一行一条有项目的会话），建表/查询都与 usage_runs 同一套做法：`ensureTable` 幂等 +
 * 客户端形状检查（拿不到就显式抛，不静默丢写）。
 *
 * **内存镜像**：文件工具每轮都要问"这个会话属于哪个项目"，而 libsql 的读写是异步的、工具装配
 * 那条路（guard.sessionRoots）是同步的。所以：
 *   - 启动时 `load()` 全表进内存（失败只记日志、当空表 —— 会话退化为"没有项目"，不影响对话）；
 *   - 之后所有写入都经本 store（路由 PUT /api/projects/mappings 是唯一入口），内存与表同步更新。
 * 单写者（同一个应用实例）前提下这份镜像与表一致；多实例（未来）要改成读库那一步。
 */
import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import type { SessionProjectEntry } from '../shared/projects'

/** 表名（自建表，与 Mastra 自己的表同库不同表） */
export const SESSION_PROJECTS_TABLE = 'session_projects'

export interface SessionProjectStore {
  /** 建表（幂等；内部缓存，重复调用只建一次） */
  ensureTable(): Promise<void>
  /** 全表读进内存镜像（服务启动时调一次；失败不缓存，调用方可再试） */
  load(): Promise<void>
  /**
   * 会话的项目 id（同步，读内存镜像）；没有映射（或镜像没载入）回 null。
   * 工具装配每轮调它，所以**不许**是异步的。
   */
  get(threadId: string): string | null
  /** 记下/改掉一条映射（表 + 内存镜像一起更新；写库失败就抛，不留在内存里假装成功） */
  set(threadId: string, projectId: string): Promise<void>
  /** 摘掉一条映射（同上，幂等） */
  clear(threadId: string): Promise<void>
  /** 当前镜像的快照（路由回包用） */
  list(): SessionProjectEntry[]
}

/**
 * libsql 客户端：`LibSQLStore` 没有公开的自定义 SQL 口子，client 是它的构造期字段
 * （运行时是真属性）。形状不对就抛——宁可让映射显式失败，也不要静默丢写。
 * （与 usage.ts 的 usageSqlClient 同一份检查，报错指向本文件。）
 */
function clientOf(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (client === undefined || typeof client.execute !== 'function') {
    throw new Error(
      '拿不到 libsql 客户端（LibSQLStore.client 形状变了）：升级 @mastra/libsql 后要复查 session-projects.ts'
    )
  }
  return client
}

function rowText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

export function createSessionProjectStore(storage: LibSQLStore): SessionProjectStore {
  const client = clientOf(storage)
  const mirror = new Map<string, string>()
  let ready: Promise<void> | null = null

  const ensureTable = (): Promise<void> => {
    ready ??= (async () => {
      await client.execute(
        `CREATE TABLE IF NOT EXISTS "${SESSION_PROJECTS_TABLE}" (
          "thread_id" TEXT PRIMARY KEY,
          "project_id" TEXT NOT NULL,
          "created_at" TEXT NOT NULL
        )`
      )
      await client.execute(
        `CREATE INDEX IF NOT EXISTS "${SESSION_PROJECTS_TABLE}_project_id" ON "${SESSION_PROJECTS_TABLE}" ("project_id")`
      )
    })().catch((error: unknown) => {
      ready = null // 失败不缓存：下一次调用再试一遍
      throw error
    })
    return ready
  }

  return {
    ensureTable,

    async load() {
      await ensureTable()
      const result = await client.execute(
        `SELECT "thread_id", "project_id" FROM "${SESSION_PROJECTS_TABLE}"`
      )
      mirror.clear()
      for (const row of result.rows) {
        const threadId = rowText(row.thread_id)
        const projectId = rowText(row.project_id)
        if (threadId !== '' && projectId !== '') mirror.set(threadId, projectId)
      }
    },

    get(threadId) {
      return mirror.get(threadId) ?? null
    },

    async set(threadId, projectId) {
      await ensureTable()
      await client.execute({
        sql: `INSERT OR REPLACE INTO "${SESSION_PROJECTS_TABLE}" ("thread_id", "project_id", "created_at") VALUES (?, ?, ?)`,
        args: [threadId, projectId, new Date().toISOString()]
      })
      mirror.set(threadId, projectId)
    },

    async clear(threadId) {
      await ensureTable()
      await client.execute({
        sql: `DELETE FROM "${SESSION_PROJECTS_TABLE}" WHERE "thread_id" = ?`,
        args: [threadId]
      })
      mirror.delete(threadId)
    },

    list() {
      return [...mirror].map(([threadId, projectId]) => ({ threadId, projectId }))
    }
  }
}
