import type { UsageThreadComposition, UsageThreadContext, UsageThreadTotals } from '@shared/usage'

/**
 * 上下文用量浮窗的**唯一口径**（task-107，用户口径："一个 hook 算全部数字"）。
 *
 * 环（饼图 + %）、浮窗头行、分段条、图例、会话统计、Token 用量全部从这里出；
 * 页面里不再有第二套计算。数据来自 `/api/usage/context`（round 67 / task-107 扩展字段）。
 */
export interface ContextUsageData {
  /** 已用百分比（封顶 100） */
  usedPct: number
  /** 最近一轮真实上下文大小（null = 没有这条会话的数据） */
  usedInput: number | null
  /** 当前对话长度档位换算出的阈值 token（≈ 窗口总量） */
  windowTokens: number
  /** 已用 ≥ 阈值（饼图 / 头行一起转警示） */
  overThreshold: boolean
  /** 系统提示词 + 工具定义的基线合计 */
  baseline: number | null
  /** 对话消息部分（= 已用 − 基线） */
  messageTokens: number | null
  /** 最近一轮缓存命中率 % */
  lastHitRate: number | null
  /** 今日缓存命中率 % */
  todayHitRate: number | null
  /** 压缩阈值（= 当前对话长度档位 %） */
  thresholdPct: number
  /** 该会话全部 usage_runs 的合计（null = 还没有记账数据） */
  totals: UsageThreadTotals | null
  /** 基线在「系统提示词 / 工具定义」上的拆分（null = 无法诚实拆分） */
  composition: UsageThreadComposition | null
}

export function computeContextUsage(
  threadContext: UsageThreadContext | null,
  windowTokens: number,
  thresholdPct: number
): ContextUsageData {
  const usedInput = threadContext?.lastInput ?? null
  const usedPct =
    usedInput === null ? 0 : Math.min(100, Math.round((usedInput / windowTokens) * 100))
  const overThreshold = usedInput !== null && usedInput >= windowTokens
  const baseline = threadContext?.baselineInput ?? null
  const messageTokens = usedInput === null ? null : Math.max(0, usedInput - (baseline ?? 0))
  const lastHitRate =
    threadContext?.lastCachedInput === null ||
    threadContext?.lastCachedInput === undefined ||
    usedInput === null ||
    usedInput === 0
      ? null
      : Math.round((threadContext.lastCachedInput / usedInput) * 100)
  const todayHitRate =
    threadContext === null || threadContext.todayInput === 0
      ? null
      : Math.round((threadContext.todayCachedInput / threadContext.todayInput) * 100)

  return {
    usedPct,
    usedInput,
    windowTokens,
    overThreshold,
    baseline,
    messageTokens,
    lastHitRate,
    todayHitRate,
    thresholdPct,
    totals: threadContext?.totals ?? null,
    composition: threadContext?.composition ?? null
  }
}

/** 分段条 / 图例的一行；composition 不可用时就只有「基线合计 + 对话消息」两行 */
export type BreakdownKey = 'system' | 'tools' | 'baseline' | 'messages'

export interface BreakdownRow {
  key: BreakdownKey
  label: string
  tokens: number | null
}

export function breakdownRows(stats: ContextUsageData): BreakdownRow[] {
  const messages: BreakdownRow = {
    key: 'messages',
    label: '对话消息',
    tokens: stats.messageTokens
  }
  if (stats.composition !== null && stats.baseline !== null) {
    return [
      { key: 'system', label: '系统提示词', tokens: stats.composition.systemPrompt },
      { key: 'tools', label: '工具定义', tokens: stats.composition.toolDefinitions },
      messages
    ]
  }
  // 拆不动就如实合并成一行：不编两个数
  return [{ key: 'baseline', label: '系统提示词 + 工具定义', tokens: stats.baseline }, messages]
}

export interface StatCell {
  label: string
  value: string
}

/** token 读数：1 位小数 K/M（比 formatTokens 更细，参考图的 ~37.3K 口径） */
export function formatTokenValue(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 100 ? Math.round(millions) : Number(millions.toFixed(1))}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}K`
  }
  return String(Math.max(0, Math.round(value)))
}

/**
 * 会话统计 2×2：只放**真实可得**的数（存储里没有模型用时/工具用时/首 token/输出速度，
 * 见 `features/trajectory/model.ts` 头注——不造这四个数）。
 */
export function sessionStats(stats: ContextUsageData): StatCell[] {
  const totals = stats.totals
  if (totals === null || totals.rounds === 0) {
    return [
      { label: '轮次', value: '—' },
      { label: '模型调用', value: '—' },
      { label: '平均每轮输入', value: '—' },
      { label: '平均每轮输出', value: '—' }
    ]
  }
  return [
    { label: '轮次', value: String(totals.rounds) },
    { label: '模型调用', value: String(totals.modelCalls) },
    {
      label: '平均每轮输入',
      value: `~${formatTokenValue(Math.round(totals.input / totals.rounds))}`
    },
    {
      label: '平均每轮输出',
      value: `~${formatTokenValue(Math.round(totals.output / totals.rounds))}`
    }
  ]
}

/** Token 用量 2×2：缓存命中率 + 未缓存输入 + 缓存读取 + 输出（全会话合计） */
export function tokenStats(stats: ContextUsageData): StatCell[] {
  const totals = stats.totals
  if (totals === null) {
    return [
      { label: '缓存命中', value: '—' },
      { label: '未缓存输入', value: '—' },
      { label: '缓存读取', value: '—' },
      { label: '输出', value: '—' }
    ]
  }
  return [
    { label: '缓存命中', value: totals.hitRate === null ? '—' : `${totals.hitRate}%` },
    { label: '未缓存输入', value: `${formatTokenValue(totals.uncachedInput)}tok` },
    { label: '缓存读取', value: `${formatTokenValue(totals.cachedInput)}tok` },
    { label: '输出', value: `${formatTokenValue(totals.output)}tok` }
  ]
}
