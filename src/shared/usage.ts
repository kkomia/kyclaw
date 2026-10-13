/**
 * 用量契约（T14）：agent 服务的 `/api/usage` 与渲染端用量页共用一处。
 *
 * 口径：
 *   - 统计窗口是**本地日历**的"今天 / 本月"（服务端按本机时区切边界）；
 *   - `cost` 只统计**价目表里有价的**运行：一条都算不出来时是 null（页面显示"—"），
 *     只算出一部分时 `costIncomplete=true`（页面显示"≥"，不把未知当 0）；
 *   - `byModel` 里每一行的 model 就是运行时的模型 id 原文（未知模型也在列，只是 cost=null）。
 */
import { z } from './zod'

/** 统计窗口：今日 / 本月 */
export const usageRangeSchema = z.enum(['today', 'month'])

export type UsageRange = z.infer<typeof usageRangeSchema>

/** token 三件套（input/output/total 都是运行合计，整数） */
export const usageTokensSchema = z.strictObject({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  total: z.number().int().min(0)
})

export type UsageTokens = z.infer<typeof usageTokensSchema>

/** 按模型拆的一行 */
export const usageModelRowSchema = z.strictObject({
  model: z.string().min(1),
  /** 供应商标识（provider 没报时 null）；同一模型名不同供应商各占一行 */
  provider: z.string().nullable(),
  /** 窗口内的运行次数 */
  runs: z.number().int().min(0),
  tokens: usageTokensSchema,
  /** 该模型的合计花费；价目表没有它 → null（只记 token） */
  cost: z.number().nullable()
})

export type UsageModelRow = z.infer<typeof usageModelRowSchema>

/** GET /api/usage?range=today|month 的回包 */
export const usageResponseSchema = z.strictObject({
  range: usageRangeSchema,
  tokens: usageTokensSchema,
  /** 有价部分的花费合计；一条都算不出来 → null */
  cost: z.number().nullable(),
  /** 窗口里存在未计价（价目表不认识）的运行 */
  costIncomplete: z.boolean(),
  /** 花费的币种（价目表的口径，见 src/mastra/usage.ts 的 USAGE_CURRENCY） */
  currency: z.string().min(1),
  byModel: z.array(usageModelRowSchema)
})

export type UsageResponse = z.infer<typeof usageResponseSchema>

/**
 * GET /api/usage/context?threadId= 的回包（round 18：上下文环与 hover 明细的数据面）。
 *
 * 口径（**round 67 起是实测值，不是估算**）：
 *   - `lastInput` = 该会话最近一轮结束时的**真实上下文大小** —— 那一轮最后一次 LLM 调用的输入
 *     tokens（系统提示词 + 工具定义 + 全部历史消息 + 本轮工具结果）。环的分子就是它；
 *   - `baselineInput` = 该会话**首轮**的同一口径 ≈ 系统提示词 + 工具定义 + 首条提问；
 *     分解里"对话消息" = lastInput − baselineInput（不足 0 归 0）；
 *   - `lastCachedInput` = 与 `lastInput` **同一次调用**的缓存命中数（同源才有比值意义）；
 *   - 三者只统计**能拿到实测值**的那部分口径：老记录（round 67 之前落的行）没有"末次调用"
 *     这一列，回读时退回该轮**整轮合计**（`tokens.input`）—— 那是**花费**口径、比上下文大得多，
 *     所以老会话的环会偏高；新会话一律是实测；
 *   - `today*` 是本地日历当天**全部会话**的合计（窗口合计口径，用整轮合计累加 —— 页面说的是
 *     "今天花了多少 token"，不是"当前上下文多大"）；`todayCachedInput` 同理。
 */
export const usageThreadContextSchema = z.strictObject({
  threadId: z.string().min(1),
  lastInput: z.number().int().min(0).nullable(),
  lastCachedInput: z.number().int().min(0).nullable(),
  baselineInput: z.number().int().min(0).nullable(),
  todayInput: z.number().int().min(0),
  todayCachedInput: z.number().int().min(0)
})

export type UsageThreadContext = z.infer<typeof usageThreadContextSchema>
