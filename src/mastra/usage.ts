/**
 * 用量记账（T14）：把每一轮对话的 token 花销记进 libsql 的 `usage_runs` 表，并算出花费。
 *
 * ## 记账钩子的到达位置（先查实现再接线）
 *
 * AI SDK v7 的 **UI 消息流**里 `finish` part 只有 finishReason / messageMetadata，**没有 usage**
 * （`ai/dist/index.d.ts` 的 `UIMessageChunk`）——渲染端拿不到 token。usage 在服务端这一侧：
 * `@mastra/ai-sdk` 的 chatRoute 把请求交给 `agent.stream()`，agent 循环在**每个 run 收尾**时
 * 调用 `onFinish(event)`，event 里带 `totalUsage`（Mastra 归一过的 `LanguageModelUsage`：
 * inputTokens / outputTokens / totalTokens / cachedInputTokens…）、`model { provider, modelId }`、
 * `runId`（`@mastra/core` 的 `MastraOnFinishCallbackArgs`；见 `agent-*.js` 里
 * `options?.onFinish({ ...payload, runId, usage, totalUsage })` 那一处）。
 * 所以接线是 `chatRoute({ defaultOptions: { onFinish: recorder } })`——不碰协议、不新增 part。
 *
 * 边界（实读实现得出的口径，别把没记的当"没花"）：
 *   - `finishReason` 是 `error` / `suspended`（等审批）/ `aborted`（用户停止）时，循环**不调用**
 *     onFinish：这些轮的 token 不落账；
 *   - 审批续跑（resumeStream）是另一次 run，按它自己那次的 usage 落一行。
 *
 * ## 表与价目
 *
 * 表 `usage_runs` 落在既有 libsql 库（kyclaw.db）里，与 Mastra 自己的表同库不同表。
 * libsql 的 `LibSQLStore` 没有公开"跑自定义 SQL"的口子（1.25.1 的 api 面只有各 domain store
 * 的固定方法），所以客户端从 storage 的 client 字段取（`usageSqlClient`，带形状检查）——
 * 升级 @mastra/libsql 后这里要复查（检查不过会明确抛错，不会静默丢账）。
 *
 * 价目表是自建的：**未知模型不猜价格**——cost=null，只记 token（spec §7.4）。
 */
import { randomUUID } from 'node:crypto'
import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import type { UsageRange, UsageResponse, UsageTokens } from '../shared/usage'

/** 花费的币种（价目表的口径；换币种/加非美元模型前先扩这里与 MODEL_PRICING） */
export const USAGE_CURRENCY = 'USD'

/** usage_runs 的表名（自建表，与 Mastra 的表同库） */
export const USAGE_TABLE = 'usage_runs'

/**
 * 单价（币种见 USAGE_CURRENCY，单位：每百万 token）。
 * 数值来自 DeepSeek 官方定价页（2026-10 实测）：当前模型 deepseek-flash / deepseek-v4-pro；
 * 官方脚注写明遗留名 deepseek-v4-flash 由 Flash 承载，按 Flash 价计。
 * 取**峰时**价（谷时是峰时的一半）→ 估出来是上限，不低估。
 */
export interface TokenPricing {
  /** 输入·缓存未命中 */
  inputPerMillion: number
  /** 输入·缓存命中 */
  cachedInputPerMillion: number
  /** 输出 */
  outputPerMillion: number
}

const DEEPSEEK_FLASH_PRICING: TokenPricing = {
  inputPerMillion: 0.3,
  cachedInputPerMillion: 0.006,
  outputPerMillion: 1.2
}

export const MODEL_PRICING: Readonly<Record<string, TokenPricing>> = {
  'deepseek-flash': DEEPSEEK_FLASH_PRICING,
  // 遗留名（官方定价页脚注：由 Flash 承载、按 Flash 计费）
  'deepseek-v4-flash': DEEPSEEK_FLASH_PRICING,
  'deepseek-v4-flash-vision-exp': DEEPSEEK_FLASH_PRICING,
  'deepseek-v4-pro': {
    inputPerMillion: 1.32,
    cachedInputPerMillion: 0.044,
    outputPerMillion: 3.96
  }
}

/**
 * 模型 id → 价目；价目表里没有 → null（未知模型只记 token）。
 * 归一：小写、去空白、去掉 `provider/` 前缀（有的通道把 provider 拼进 id）。
 */
export function pricingFor(modelId: string | null | undefined): TokenPricing | null {
  if (typeof modelId !== 'string') return null
  const normalized = modelId.trim().toLowerCase()
  const bare = normalized.slice(normalized.lastIndexOf('/') + 1)
  return MODEL_PRICING[bare] ?? null
}

/** 花费 = 输入(未命中) + 输入(命中) + 输出；命中数按输入数封顶（不出现负的未命中） */
export function computeCost(
  pricing: TokenPricing,
  tokens: { input: number; output: number; cachedInput?: number }
): number {
  const cached = Math.min(Math.max(tokens.cachedInput ?? 0, 0), Math.max(tokens.input, 0))
  const uncached = Math.max(tokens.input, 0) - cached
  const output = Math.max(tokens.output, 0)
  return (
    (uncached * pricing.inputPerMillion +
      cached * pricing.cachedInputPerMillion +
      output * pricing.outputPerMillion) /
    1_000_000
  )
}

/** 一行落库记录（回读时也用它，所以字段名是 camelCase，SQL 列名在 store 里映射） */
export interface UsageRun {
  id: string
  runId: string | null
  /** round 18：这一轮属于哪条会话（从 onFinish 事件的 dbMessages 里取；取不到 = null） */
  threadId: string | null
  /** 运行时的模型 id 原文（未知也照记） */
  model: string
  provider: string | null
  tokens: UsageTokens
  /** provider 报的缓存命中输入；没报就是 null（别当成 0 去算价） */
  cachedInput: number | null
  /** 世界货币计价的花费；价目表不认识这个模型 → null */
  cost: number | null
  /** ISO 时间串（写入时刻） */
  createdAt: string
}

/** usage_runs 的读写口（测试与生产共用；真实现落 libsql） */
export interface UsageStore {
  /** 建表（幂等；内部缓存，重复调用只建一次） */
  ensureTable(): Promise<void>
  insert(run: UsageRun): Promise<void>
  /** 窗口内的全部运行（长表逐行读回，聚合在 summarizeUsage 里做） */
  listSince(since: Date): Promise<UsageRun[]>
  /** 某条会话的运行（**时间升序**：首条当"系统+工具"基线，最后一条当"最近一轮"） */
  listByThread(threadId: string): Promise<UsageRun[]>
}

/**
 * libsql 客户端：`LibSQLStore` 没有公开的自定义 SQL 口子，client 是它的构造期字段
 * （运行时是真属性）。形状不对就抛——宁可让记账显式失败，也不要静默写丢。
 */
export function usageSqlClient(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (client === undefined || typeof client.execute !== 'function') {
    throw new Error(
      '拿不到 libsql 客户端（LibSQLStore.client 形状变了）：升级 @mastra/libsql 后要复查 usage.ts'
    )
  }
  return client
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value === '') return null
  return toNumber(value)
}

/** 落库的 store：表随第一次使用建好（CREATE TABLE IF NOT EXISTS + created_at 索引） */
export function createUsageStore(client: SqliteClient): UsageStore {
  let ready: Promise<void> | null = null

  const ensureTable = (): Promise<void> => {
    ready ??= (async () => {
      await client.execute(
        `CREATE TABLE IF NOT EXISTS "${USAGE_TABLE}" (
          "id" TEXT PRIMARY KEY,
          "run_id" TEXT,
          "thread_id" TEXT,
          "model" TEXT NOT NULL,
          "provider" TEXT,
          "input_tokens" INTEGER NOT NULL DEFAULT 0,
          "output_tokens" INTEGER NOT NULL DEFAULT 0,
          "total_tokens" INTEGER NOT NULL DEFAULT 0,
          "cached_input_tokens" INTEGER,
          "cost" REAL,
          "created_at" TEXT NOT NULL
        )`
      )
      // 已有库补列（round 18）：SQLite 的 ALTER 重复执行会报错，忽略即可（列已存在 = 已完成迁移）
      try {
        await client.execute(`ALTER TABLE "${USAGE_TABLE}" ADD COLUMN "thread_id" TEXT`)
      } catch {
        // 列已存在
      }
      await client.execute(
        `CREATE INDEX IF NOT EXISTS "${USAGE_TABLE}_created_at" ON "${USAGE_TABLE}" ("created_at")`
      )
      await client.execute(
        `CREATE INDEX IF NOT EXISTS "${USAGE_TABLE}_thread_id" ON "${USAGE_TABLE}" ("thread_id")`
      )
    })().catch((error: unknown) => {
      ready = null // 失败不缓存：下一次调用再试一遍
      throw error
    })
    return ready
  }

  return {
    ensureTable,
    async insert(run) {
      await ensureTable()
      await client.execute({
        sql: `INSERT OR REPLACE INTO "${USAGE_TABLE}"
          ("id", "run_id", "thread_id", "model", "provider", "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cost", "created_at")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          run.id,
          run.runId,
          run.threadId,
          run.model,
          run.provider,
          run.tokens.input,
          run.tokens.output,
          run.tokens.total,
          run.cachedInput,
          run.cost,
          run.createdAt
        ]
      })
    },
    async listSince(since) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT "id", "run_id", "thread_id", "model", "provider", "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cost", "created_at"
          FROM "${USAGE_TABLE}" WHERE "created_at" >= ? ORDER BY "created_at" DESC`,
        args: [since.toISOString()]
      })
      return result.rows.map(rowOfUsageRun)
    },
    async listByThread(threadId) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT "id", "run_id", "thread_id", "model", "provider", "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cost", "created_at"
          FROM "${USAGE_TABLE}" WHERE "thread_id" = ? ORDER BY "created_at" ASC`,
        args: [threadId]
      })
      return result.rows.map(rowOfUsageRun)
    }
  }
}

/** libsql 行 → UsageRun（列名映射只写这一处） */
function rowOfUsageRun(row: Record<string, unknown>): UsageRun {
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value)
  return {
    id: String(row.id),
    runId: text(row.run_id),
    threadId: text(row.thread_id),
    model: String(row.model),
    provider: text(row.provider),
    tokens: {
      input: toNumber(row.input_tokens),
      output: toNumber(row.output_tokens),
      total: toNumber(row.total_tokens)
    },
    cachedInput: toNullableNumber(row.cached_input_tokens),
    cost: toNullableNumber(row.cost),
    createdAt: String(row.created_at)
  }
}

/**
 * round 59：一条会话的 token 读数（**唯一口径**：/api/usage/context 与压缩记录的 tokensBefore
 * 都从这里来，别在两处各算一套）。
 *
 * 口径同 listByThread 的排序：按 created_at 升序，**末行** = 最近一轮、**首行** = 首轮基线
 * （首行 ≈ 系统提示 + 工具定义的基线，见 shared/usage 的 usageThreadContextSchema 注释）。
 * 空会话三个字段都是 null（不假装 0）。`lastCachedInput` 一起回：路由的 hover 明细要它，
 * 与其再查一次同一张表，不如一次读完（压缩侧只用前两个字段）。
 */
export interface ThreadTokenReadout {
  lastInput: number | null
  lastCachedInput: number | null
  baselineInput: number | null
}

export async function threadTokenReadout(
  store: UsageStore,
  threadId: string
): Promise<ThreadTokenReadout> {
  const rows = await store.listByThread(threadId)
  const first = rows[0]
  const last = rows[rows.length - 1]
  return {
    lastInput: last?.tokens.input ?? null,
    lastCachedInput: last?.cachedInput ?? null,
    baselineInput: first?.tokens.input ?? null
  }
}

/** 窗口起点：today = 本地零点；month = 本地 1 号零点（"本地日历"口径，与用户看到的对得上） */
export function rangeStart(range: UsageRange, now: Date): Date {
  const start = new Date(now)
  if (range === 'month') start.setDate(1)
  start.setHours(0, 0, 0, 0)
  return start
}

/** 聚合：总量 + 按模型拆分（token 降序）；cost 只算有价的部分，一条都算不出就是 null */
export function summarizeUsage(rows: readonly UsageRun[], range: UsageRange): UsageResponse {
  const tokens: UsageTokens = { input: 0, output: 0, total: 0 }
  const byModel = new Map<
    string,
    {
      model: string
      provider: string | null
      runs: number
      tokens: UsageTokens
      cost: number | null
    }
  >()
  let cost: number | null = null
  let costIncomplete = false

  for (const row of rows) {
    tokens.input += row.tokens.input
    tokens.output += row.tokens.output
    tokens.total += row.tokens.total

    const key = `${row.provider ?? ''}\u0000${row.model}`
    const group = byModel.get(key) ?? {
      model: row.model,
      provider: row.provider,
      runs: 0,
      tokens: { input: 0, output: 0, total: 0 },
      cost: null
    }
    group.runs += 1
    group.tokens.input += row.tokens.input
    group.tokens.output += row.tokens.output
    group.tokens.total += row.tokens.total

    if (row.cost === null) {
      costIncomplete = true
    } else {
      cost = (cost ?? 0) + row.cost
      group.cost = (group.cost ?? 0) + row.cost
    }
    byModel.set(key, group)
  }

  return {
    range,
    tokens,
    cost,
    costIncomplete,
    currency: USAGE_CURRENCY,
    byModel: [...byModel.values()].sort(
      (a, b) => b.tokens.total - a.tokens.total || a.model.localeCompare(b.model)
    )
  }
}

/** onFinish 事件里我们要的那几个字段（结构化取用，不把框架类型搬进来） */
export interface UsageFinishEvent {
  usage?: unknown
  totalUsage?: unknown
  model?: { modelId?: string; provider?: string } | null
  response?: { modelId?: string; dbMessages?: ReadonlyArray<{ threadId?: unknown }> } | null
  runId?: string | null
}

/** 从 onFinish 事件的 dbMessages 里取会话 id（Mastra 的 DB 消息带 threadId；取不到 = null） */
function threadIdOf(event: UsageFinishEvent): string | null {
  for (const message of event.response?.dbMessages ?? []) {
    if (typeof message.threadId === 'string' && message.threadId.trim() !== '') {
      return message.threadId
    }
  }
  return null
}

/** provider 的 usage 字段有的报数字、有的报 `{ total }` 对象；都收 */
function tokenNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'object' && value !== null) {
    const total = (value as { total?: unknown }).total
    if (typeof total === 'number' && Number.isFinite(total)) return total
  }
  return undefined
}

function firstText(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * 记账钩子（chatRoute 的 defaultOptions.onFinish）：
 * 每轮 run 收尾把 usage 落一行；token 为 0 的轮不记（空轮不留噪音）。
 * 记账是旁路：写库失败只记日志，绝不让对话跟着挂（onError 可注入，测试用）。
 */
export function createUsageRecorder(options: {
  store: UsageStore
  now?: () => Date
  onError?: (error: unknown) => void
}): (event: UsageFinishEvent) => Promise<void> {
  const now = options.now ?? (() => new Date())

  return async (event) => {
    try {
      const usage = (event.totalUsage ?? event.usage) as Record<string, unknown> | null | undefined
      const input = tokenNumber(usage?.inputTokens) ?? 0
      const output = tokenNumber(usage?.outputTokens) ?? 0
      if (input + output <= 0) return
      const reportedTotal = tokenNumber(usage?.totalTokens) ?? 0
      const cachedInput = tokenNumber(usage?.cachedInputTokens)
      const model = firstText(event.model?.modelId, event.response?.modelId) ?? 'unknown'
      const provider = firstText(event.model?.provider) ?? null
      const pricing = pricingFor(model)

      await options.store.insert({
        id: randomUUID(),
        runId: event.runId ?? null,
        threadId: threadIdOf(event),
        model,
        provider,
        tokens: { input, output, total: reportedTotal > 0 ? reportedTotal : input + output },
        cachedInput: cachedInput ?? null,
        cost: pricing === null ? null : computeCost(pricing, { input, output, cachedInput }),
        createdAt: now().toISOString()
      })
    } catch (error) {
      if (options.onError !== undefined) options.onError(error)
      else console.warn('[kyclaw] 用量记账失败（对话不受影响）', error)
    }
  }
}
