/**
 * 会话↔PPT 模板映射（round 66）：哪条会话固定了哪套模板 —— 落 libsql 的 `session_ppt_templates` 表。
 *
 * 与 `session-projects.ts`（会话↔项目）同一份形状与同一份理由：会话本体（线程/消息）就在这份库里，
 * 会话级的选择跟它同寿命、同删除时机；放 settings.json 会变成"两处事实、各自漂移"
 * （而且 round 63 的全局化正是这么来的：新会话继承了别人的选择）。建表/查询与 usage_runs、
 * session_projects 同一套做法：`ensureTable` 幂等 + 客户端形状检查（拿不到就显式抛，不静默丢写）。
 *
 * **内存镜像**：`create_ppt` 要在工具执行那一刻**同步**回答"这个会话用哪套模板"，
 * 而工具执行里没有 await 的余量（renderPptx 之前的取模板是同步的）。所以：
 *   - 启动时 `load()` 全表进内存（失败只记日志、当空表 —— 会话退化为"没有固定模板"，不影响对话）；
 *   - 之后所有写入都经本 store（路由 PUT /api/ppt/templates 是唯一入口），内存与表同步更新。
 * 单写者（同一个应用实例）前提下这份镜像与表一致。
 */
import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import type { SessionPptTemplateEntry } from '../shared/session-ppt-templates'

/** 表名（自建表，与 Mastra 自己的表同库不同表） */
export const SESSION_PPT_TEMPLATES_TABLE = 'session_ppt_templates'

export interface SessionPptTemplateStore {
  /** 建表（幂等；内部缓存，重复调用只建一次） */
  ensureTable(): Promise<void>
  /** 全表读进内存镜像（服务启动时调一次；失败不缓存，调用方可再试） */
  load(): Promise<void>
  /**
   * 这条会话固定的模板名（同步，读内存镜像）；没有（或镜像没载入）回 null。
   * create_ppt 每次执行都问它，所以**不许**是异步的。
   */
  get(threadId: string): string | null
  /** 记下/改掉一条（表 + 内存镜像一起更新；写库失败就抛，不留在内存里假装成功） */
  set(threadId: string, template: string): Promise<void>
  /** 摘掉一条（同上，幂等）——「清回自动」与会话被删时的清理都走它 */
  clear(threadId: string): Promise<void>
  /** 当前镜像的快照（路由回包用） */
  list(): SessionPptTemplateEntry[]
}

/**
 * libsql 客户端：`LibSQLStore` 没有公开的自定义 SQL 口子，client 是它的构造期字段
 * （运行时是真属性）。形状不对就抛——宁可让映射显式失败，也不要静默丢写。
 * （与 usage.ts / session-projects.ts 同一份检查，报错指向本文件。）
 */
function clientOf(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (client === undefined || typeof client.execute !== 'function') {
    throw new Error(
      '拿不到 libsql 客户端（LibSQLStore.client 形状变了）：升级 @mastra/libsql 后要复查 session-ppt-templates.ts'
    )
  }
  return client
}

function rowText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

export function createSessionPptTemplateStore(storage: LibSQLStore): SessionPptTemplateStore {
  const client = clientOf(storage)
  const mirror = new Map<string, string>()
  let ready: Promise<void> | null = null

  const ensureTable = (): Promise<void> => {
    ready ??= (async () => {
      await client.execute(
        `CREATE TABLE IF NOT EXISTS "${SESSION_PPT_TEMPLATES_TABLE}" (
          "thread_id" TEXT PRIMARY KEY,
          "template" TEXT NOT NULL,
          "created_at" TEXT NOT NULL
        )`
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
        `SELECT "thread_id", "template" FROM "${SESSION_PPT_TEMPLATES_TABLE}"`
      )
      mirror.clear()
      for (const row of result.rows) {
        const threadId = rowText(row.thread_id)
        const template = rowText(row.template)
        if (threadId !== '' && template !== '') mirror.set(threadId, template)
      }
    },

    get(threadId) {
      return mirror.get(threadId) ?? null
    },

    async set(threadId, template) {
      await ensureTable()
      await client.execute({
        sql: `INSERT OR REPLACE INTO "${SESSION_PPT_TEMPLATES_TABLE}" ("thread_id", "template", "created_at") VALUES (?, ?, ?)`,
        args: [threadId, template, new Date().toISOString()]
      })
      mirror.set(threadId, template)
    },

    async clear(threadId) {
      await ensureTable()
      await client.execute({
        sql: `DELETE FROM "${SESSION_PPT_TEMPLATES_TABLE}" WHERE "thread_id" = ?`,
        args: [threadId]
      })
      mirror.delete(threadId)
    },

    list() {
      return [...mirror].map(([threadId, template]) => ({ threadId, template }))
    }
  }
}
