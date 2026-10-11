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
 * 口径（都是**近似**，报告里如实标注）：
 *   - `lastInput` = 该会话最近一轮的输入 tokens（环的分子）；
 *   - `baselineInput` = 该会话**首轮**的输入 tokens ≈ 系统提示词 + 工具定义的基线；
 *     分解里"对话消息" = lastInput − baselineInput（不足 0 归 0）；
 *   - 缓存字段来自 provider 上报（DeepSeek 系有 prompt_cache_hit_tokens → AI SDK 的 cachedInputTokens）；
 *     端点不报就是 null / 0，不拿它猜命中率；`today*` 是本地日历当天**全部会话**的合计（窗口合计口径）。
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
