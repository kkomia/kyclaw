/**
 * 用量页的显示格式（纯函数，单独一处）：token 用千分位（en 数字分组 vs 中文场景都读得懂，
 * 且不丢精度）。
 *
 * 用户口径 014：用量页只讲 token，不做计费 —— 这一页原来的金额格式化（币种符号、未计价
 * 占位符 "—"、"≥" 前缀）随花费展示一起去掉了；服务端也一并去掉了计费口径（不再记账、
 * 不再回包金额）。
 */
export function formatTokens(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}
