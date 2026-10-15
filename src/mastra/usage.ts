/**
 * 用量记账（T14）：把每一轮对话的 token 用量记进 libsql 的 `usage_runs` 表。
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
 * ## 表
 *
 * 表 `usage_runs` 落在既有 libsql 库（kyclaw.db）里，与 Mastra 自己的表同库不同表。
 * libsql 的 `LibSQLStore` 没有公开"跑自定义 SQL"的口子（1.25.1 的 api 面只有各 domain store
 * 的固定方法），所以客户端从 storage 的 client 字段取（`usageSqlClient`，带形状检查）——
 * 升级 @mastra/libsql 后这里要复查（检查不过会明确抛错，不会静默丢账）。
 *
 * 记账只记 **token**（用户口径 014：不做计费）：不猜价、不算钱、回包里也没有金额字段。
 */
import { randomUUID } from 'node:crypto'
import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import type { UsageRange, UsageResponse, UsageTokens } from '../shared/usage'

/** usage_runs 的表名（自建表，与 Mastra 的表同库） */
export const USAGE_TABLE = 'usage_runs'

/** 一行落库记录（回读时也用它，所以字段名是 camelCase，SQL 列名在 store 里映射） */
export interface UsageRun {
  id: string
  runId: string | null
  /** round 18：这一轮属于哪条会话（从 onFinish 事件的 dbMessages 里取；取不到 = null） */
  threadId: string | null
  /** 运行时的模型 id 原文（未知也照记） */
  model: string
  provider: string | null
  /**
   * 这一轮**所有 LLM 调用**的合计（AI SDK 的 totalUsage：一轮里每调一次模型算一次 step）。
   * 是**整轮合计**口径 —— 不是上下文大小（后者见 `contextInput`）。
   */
  tokens: UsageTokens
  /** provider 报的缓存命中输入；没报就是 null（别当成 0） */
  cachedInput: number | null
  /**
   * round 67：这一轮**最后一次** LLM 调用的输入 tokens —— 也就是这一轮结束时**真实的上下文大小**
   * （系统提示词 + 工具定义 + 全部历史消息 + 本轮工具结果）。
   *
   * 为什么非记不可：`tokens.input` 是整轮合计，**不是**"每轮固定开销"。把它当上下文大小会
   * 得出"系统提示词/工具定义 = 221K"这种结论（实测：一轮 9 次调用的合计 221K，而真实上下文
   * 只有 ~30K）。老记录 / 事件里没有 steps 的时刻 → null（回读时退回 tokens.input，不编造）。
   */
  contextInput: number | null
  /** round 67：`contextInput` 那一份的缓存命中数（与它同一次调用，配对比值才有意义） */
  contextCachedInput: number | null
  /** round 67：这一轮一共调了几次模型（AI SDK 的 steps 数）；拿不到 → null */
  stepCount: number | null
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
      // `cost` 是**历史列**（T14 起记过"按价目表算出来的花费"）：用户已装的库里有它，
      // 新建库也照原样留着 —— 两边表形一致，老库迁移不会因为列不见了炸掉。
      // 产品已经不做计费（用户口径 014）：写入侧固定写 NULL、读取侧不映射它。
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
          "context_input_tokens" INTEGER,
          "context_cached_input_tokens" INTEGER,
          "step_count" INTEGER,
          "cost" REAL,
          "created_at" TEXT NOT NULL
        )`
      )
      // 已有库补列（round 18 / round 67）：**列名与类型分开拼**。
      // round 87 修：旧写法 `ADD COLUMN "${column}"`（column = `'thread_id TEXT'`）会把**整串**
      // 当列名 —— 建出来的是一个名字叫 `thread_id TEXT` 的怪列，真列根本没补上；紧接着的
      // `CREATE INDEX … ("thread_id")` 于是报 `no such column: thread_id`，ensureTable 整体抛出，
      // **用量面每一条路由都 500**（用户反馈 017 里那句"用量服务错误 500"正是这条路：老库
      // 的 usage_runs 建于 round 18 之前，升上来就撞它）。
      // 也不再用"ALTER 失败就当列已存在"的 catch 兜底：那会把真正的失败吞掉 ——
      // 与 compaction.ts 同一口径（**查得到才不补**，其余异常照抛）。
      const columns = await client.execute(`PRAGMA table_info("${USAGE_TABLE}")`)
      const existing = new Set(columns.rows.map((row) => String(row.name)))
      for (const column of [
        'thread_id',
        'context_input_tokens',
        'context_cached_input_tokens',
        'step_count'
      ]) {
        if (existing.has(column)) continue
        await client.execute(
          `ALTER TABLE "${USAGE_TABLE}" ADD COLUMN "${column}" ${
            column === 'thread_id' ? 'TEXT' : 'INTEGER'
          }`
        )
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
          ("id", "run_id", "thread_id", "model", "provider", "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "context_input_tokens", "context_cached_input_tokens", "step_count", "cost", "created_at")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          run.contextInput,
          run.contextCachedInput,
          run.stepCount,
          // cost：历史列，保留兼容 —— 产品不再记账，固定写 NULL（"没记"比写 0 诚实：
          // 0 会被读成"这次没花钱"）
          null,
          run.createdAt
        ]
      })
    },
    async listSince(since) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT ${USAGE_COLUMNS}
          FROM "${USAGE_TABLE}" WHERE "created_at" >= ? ORDER BY "created_at" DESC`,
        args: [since.toISOString()]
      })
      return result.rows.map(rowOfUsageRun)
    },
    async listByThread(threadId) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT ${USAGE_COLUMNS}
          FROM "${USAGE_TABLE}" WHERE "thread_id" = ? ORDER BY "created_at" ASC`,
        args: [threadId]
      })
      return result.rows.map(rowOfUsageRun)
    }
  }
}

/** usage_runs 的列清单（读回用；round 67 加了三列上下文口径。`cost` 是历史列，不读） */
const USAGE_COLUMNS = `"id", "run_id", "thread_id", "model", "provider", "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "context_input_tokens", "context_cached_input_tokens", "step_count", "created_at"`

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
    // round 67：老记录这两列是 NULL → null（回读时退回整轮口径，不假装是老口径的 0）
    contextInput: toNullableNumber(row.context_input_tokens),
    contextCachedInput: toNullableNumber(row.context_cached_input_tokens),
    stepCount: toNullableNumber(row.step_count),
    createdAt: String(row.created_at)
  }
}

/**
 * round 59：一条会话的 token 读数（**唯一口径**：/api/usage/context 与压缩记录的 tokensBefore
 * 都从这里来，别在两处各算一套）。
 *
 * round 67 改口径（原来把**整轮合计**当成了"上下文大小"，于是面板把 221K 的整轮合计显示成
 * "系统提示词 / 工具定义"）：
 *   - `lastInput` = 最近一轮的**真实上下文大小** —— 那一轮最后一次 LLM 调用的输入 tokens
 *     （`contextInput`）。老记录没有这一列（NULL）才退回整轮合计，宁可粗一点也不要空；
 *   - `baselineInput` = **首轮**的同一口径 —— ≈ 系统提示词 + 工具定义 + 首条提问；
 *   - `lastCachedInput` = 与 `lastInput` **同一次调用**的缓存命中数（两者必须同源，否则
 *     算出来的命中率是拿"整轮命中和"除"最后一次的输入"，没有意义）。
 *
 * 排序口径不变：按 created_at 升序，末行 = 最近一轮、首行 = 首轮基线。
 * 空会话三个字段都是 null（不假装 0）。
 */
export interface ThreadTokenReadout {
  lastInput: number | null
  lastCachedInput: number | null
  baselineInput: number | null
}

/** 取"上下文口径"的数字：新记录用 contextInput，老记录（NULL）退回整轮合计 */
function contextOrTurn(contextValue: number | null, turnValue: number): number {
  return contextValue ?? turnValue
}

export async function threadTokenReadout(
  store: UsageStore,
  threadId: string
): Promise<ThreadTokenReadout> {
  const rows = await store.listByThread(threadId)
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (last === undefined) {
    return { lastInput: null, lastCachedInput: null, baselineInput: null }
  }
  return {
    lastInput: contextOrTurn(last.contextInput, last.tokens.input),
    lastCachedInput: last.contextCachedInput ?? last.cachedInput,
    baselineInput:
      first === undefined ? null : contextOrTurn(first.contextInput, first.tokens.input)
  }
}

/** 窗口起点：today = 本地零点；month = 本地 1 号零点（"本地日历"口径，与用户看到的对得上） */
export function rangeStart(range: UsageRange, now: Date): Date {
  const start = new Date(now)
  if (range === 'month') start.setDate(1)
  start.setHours(0, 0, 0, 0)
  return start
}

/** 聚合：总量 + 按模型拆分（token 降序） */
export function summarizeUsage(rows: readonly UsageRun[], range: UsageRange): UsageResponse {
  const tokens: UsageTokens = { input: 0, output: 0, total: 0 }
  const byModel = new Map<
    string,
    {
      model: string
      provider: string | null
      runs: number
      tokens: UsageTokens
    }
  >()

  for (const row of rows) {
    tokens.input += row.tokens.input
    tokens.output += row.tokens.output
    tokens.total += row.tokens.total

    const key = `${row.provider ?? ''}\u0000${row.model}`
    const group = byModel.get(key) ?? {
      model: row.model,
      provider: row.provider,
      runs: 0,
      tokens: { input: 0, output: 0, total: 0 }
    }
    group.runs += 1
    group.tokens.input += row.tokens.input
    group.tokens.output += row.tokens.output
    group.tokens.total += row.tokens.total

    byModel.set(key, group)
  }

  return {
    range,
    tokens,
    byModel: [...byModel.values()].sort(
      (a, b) => b.tokens.total - a.tokens.total || a.model.localeCompare(b.model)
    )
  }
}

/** onFinish 事件里我们要的那几个字段（结构化取用，不把框架类型搬进来） */
export interface UsageFinishEvent {
  usage?: unknown
  totalUsage?: unknown
  /** 这一步是第几次 LLM 调用（0 基）。有它就能算出这一轮调了几次模型（round 67） */
  stepNumber?: number
  /** 这一轮的全部 step（每个 step 带自己那一次的 usage）——取末一个 = 真实上下文大小（round 67） */
  steps?: unknown
  /** 末一个 step 的捷径（有的框架版本只给这个，不给 steps） */
  finalStep?: unknown
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

/** 「这一次调用」的 usage 对象（末一个 step 的 usage；形状不对 → null） */
function lastStepUsage(event: UsageFinishEvent): Record<string, unknown> | null {
  const steps = Array.isArray(event.steps) ? event.steps : []
  const last = steps.length > 0 ? steps[steps.length - 1] : event.finalStep
  if (typeof last !== 'object' || last === null) return null
  const usage = (last as { usage?: unknown }).usage
  return typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : null
}

/** 这一轮调了几次模型：stepNumber（0 基）+1 优先，其次 steps.length；都没有 → null */
function stepCountOf(event: UsageFinishEvent): number | null {
  if (typeof event.stepNumber === 'number' && Number.isFinite(event.stepNumber)) {
    return Math.max(1, Math.trunc(event.stepNumber) + 1)
  }
  if (Array.isArray(event.steps) && event.steps.length > 0) return event.steps.length
  return null
}

/** 缓存命中数：兼容 `cachedInputTokens`（别名）与 `inputTokenDetails.cacheReadTokens`（新形状） */
function cachedOf(usage: Record<string, unknown> | null): number | null {
  if (usage === null) return null
  const alias = tokenNumber(usage.cachedInputTokens)
  if (alias !== undefined) return alias
  const details = usage.inputTokenDetails
  if (typeof details === 'object' && details !== null) {
    const read = tokenNumber((details as { cacheReadTokens?: unknown }).cacheReadTokens)
    if (read !== undefined) return read
  }
  return null
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
      const cachedInput = cachedOf(usage ?? null)
      const model = firstText(event.model?.modelId, event.response?.modelId) ?? 'unknown'
      const provider = firstText(event.model?.provider) ?? null
      // round 67：末一个 step 的 usage = 这一轮结束时的真实上下文（见 UsageRun.contextInput）
      const finalUsage = lastStepUsage(event)
      const contextInput = tokenNumber(finalUsage?.inputTokens) ?? null
      const contextCachedInput = cachedOf(finalUsage)

      await options.store.insert({
        id: randomUUID(),
        runId: event.runId ?? null,
        threadId: threadIdOf(event),
        model,
        provider,
        tokens: { input, output, total: reportedTotal > 0 ? reportedTotal : input + output },
        cachedInput: cachedInput ?? null,
        contextInput,
        contextCachedInput,
        stepCount: stepCountOf(event),
        createdAt: now().toISOString()
      })
    } catch (error) {
      if (options.onError !== undefined) options.onError(error)
      else console.warn('[kyclaw] 用量记账失败（对话不受影响）', error)
    }
  }
}
