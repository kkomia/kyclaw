/**
 * 用量页的显示格式（纯函数，单独一处）：
 *   - token 用千分位（en 数字分组 vs 中文场景都读得懂，且不丢精度）；
 *   - 金额按币种给符号、固定 2 位小数起（最多 6 位，免得小额花费被四舍五入成 0）；
 *   - cost=null（价目表不认识这个模型）显示占位符，不显示 0 —— 未知 ≠ 没花钱；
 *   - 窗口里有一部分没计价时，合计前面加 "≥"（真实花费不小于这个数），也不显示 0。
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  CNY: '¥'
}

/** 未知 / 不可计算的数字占位 */
export const UNKNOWN_AMOUNT = '—'

export function formatTokens(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatCost(
  value: number | null,
  options: { currency: string; incomplete?: boolean }
): string {
  if (value === null) return UNKNOWN_AMOUNT
  const symbol = CURRENCY_SYMBOLS[options.currency] ?? `${options.currency} `
  const amount = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  }).format(value)
  return `${options.incomplete === true ? '≥ ' : ''}${symbol}${amount}`
}
