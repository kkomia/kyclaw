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
