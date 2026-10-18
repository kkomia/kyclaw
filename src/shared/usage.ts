/**
 * 用量契约（T14）：agent 服务的 `/api/usage` 与渲染端用量页共用一处。
 *
 * 口径：
 *   - 统计窗口是**本地日历**的"今天 / 本月"（服务端按本机时区切边界）；
 *   - 只讲 token 用量（用户口径 014：不做计费）—— 回包里**没有** cost / 币种一类字段，
 *     也没有"计价了多少"这种口径；
 *   - `byModel` 里每一行的 model 就是运行时的模型 id 原文（未知模型也在列，token 照记）。
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
  tokens: usageTokensSchema
})

export type UsageModelRow = z.infer<typeof usageModelRowSchema>

/** GET /api/usage?range=today|month 的回包 */
export const usageResponseSchema = z.strictObject({
  range: usageRangeSchema,
  tokens: usageTokensSchema,
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
 *     这一列，回读时退回该轮**整轮合计**（`tokens.input`）—— 那是整轮全部模型调用的合计、
 *     比上下文大得多，
 *     所以老会话的环会偏高；新会话一律是实测；
 *   - `today*` 是本地日历当天**全部会话**的合计（窗口合计口径，用整轮合计累加 —— 页面说的是
 *     "今天花了多少 token"，不是"当前上下文多大"）；`todayCachedInput` 同理。
 */
/** 该会话全部 usage_runs 的合计（上下文浮窗的「Token 用量 / 会话统计」口径，一处算） */
export const usageThreadTotalsSchema = z.strictObject({
  /** 该会话记过账的轮数（usage_runs 行数） */
  rounds: z.number().int().min(0),
  /** 模型调用次数 = Σ stepCount（老记录没有 step 数时按"一轮至少一次"记 1） */
  modelCalls: z.number().int().min(0),
  /** 全部轮的输入合计（含缓存命中的部分） */
  input: z.number().int().min(0),
  /** 缓存读取（provider 报的 cachedInput 合计） */
  cachedInput: z.number().int().min(0),
  /** 未缓存输入 = input − cachedInput（不足 0 归 0） */
  uncachedInput: z.number().int().min(0),
  output: z.number().int().min(0),
  /** 缓存命中率 %（input = 0 → null，不假装 0） */
  hitRate: z.number().int().min(0).max(100).nullable()
})

export type UsageThreadTotals = z.infer<typeof usageThreadTotalsSchema>

/**
 * 「系统提示词 / 工具定义」的拆分（~估算）：baselineInput 是两者合计；
 * 用该会话**首份请求快照**的 system_chars / tools_chars 字符占比拆分。
 * 拿不到请求快照（老会话 / 快照表读失败）→ 整个对象为 null，UI 合并成一行，不编两个数。
 */
export const usageThreadCompositionSchema = z.strictObject({
  systemPrompt: z.number().int().min(0),
  toolDefinitions: z.number().int().min(0)
})

export type UsageThreadComposition = z.infer<typeof usageThreadCompositionSchema>

export const usageThreadContextSchema = z.strictObject({
  threadId: z.string().min(1),
  lastInput: z.number().int().min(0).nullable(),
  lastCachedInput: z.number().int().min(0).nullable(),
  baselineInput: z.number().int().min(0).nullable(),
  todayInput: z.number().int().min(0),
  todayCachedInput: z.number().int().min(0),
  /** 全会话合计（Token 用量四格 + 会话统计的数据面） */
  totals: usageThreadTotalsSchema,
  /** baseline 的 sys/tools 拆分；null = 无法诚实拆分（UI 合并一行） */
  composition: usageThreadCompositionSchema.nullable()
})

export type UsageThreadContext = z.infer<typeof usageThreadContextSchema>

/**
 * GET /api/usage/calendar?year=YYYY 的回包（task-127 首页日历热力图的数据面）。
 * 口径与 /api/usage 一致：**本地日历**按天聚合；只回有记录的天（渲染端补零），不造数据。
 * 每轮 usage_runs 一行：input/output 为整轮合计，cachedInput 为 provider 报的缓存命中，
 * steps = Σ stepCount（老记录没有 step 数时按一轮至少调 1 次记 1，下界不虚报）。
 */
export const usageCalendarDaySchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cachedInput: z.number().int().min(0),
  runs: z.number().int().min(0),
  steps: z.number().int().min(0)
})

export type UsageCalendarDay = z.infer<typeof usageCalendarDaySchema>

export const usageCalendarSchema = z.strictObject({
  year: z.number().int().min(2000).max(2100),
  days: z.array(usageCalendarDaySchema),
  totalActiveDays: z.number().int().min(0),
  /** 当年 Σ tokens.total（input+output；与 /api/usage 的 tokens.total 同口径） */
  totalTokens: z.number().int().min(0)
})

export type UsageCalendar = z.infer<typeof usageCalendarSchema>

/** 查询参数：年份缺省由路由取当前年；脏值 400，不静默回落 */
export const usageCalendarYearSchema = z.coerce.number().int().min(2000).max(2100)
