import type { UIMessage } from 'ai'

/**
 * 消息导览轨的纯逻辑（组件在 MessageRail.tsx：react-refresh 要求组件文件只导出组件）。
 */
/** 当前节点阈值（px）：消息顶边越过容器上沿这么多，就算"滚过它了" */
export const RAIL_ACTIVE_THRESHOLD = 32

/**
 * ## 行高（round 87 / 用户反馈 018）
 *
 * 以前一行固定 `h-7`（28px）：一条用户消息一行、总高 ≈ 28N+8，900px 视口在 ~22 轮就顶到
 * 70vh 的天花板 —— 再长就只能在轨内滚动，**轨迹越长导览越没用**（要找的那条永远在看不见的地方）。
 *
 * 现在按**条数**压缩行高：条数少照旧一行 28px（好点、好读），条数多了按函数线性压到最小 10px
 * ——"一条一轮、可点数、点哪条跳哪轮"三件事一件不少（行数不变、每行仍是一个可点的按钮、
 * 最小行高 10px ≥ 触达下限 8px；压缩态下 hover / 聚焦把那一行**展开回满行高**，见 MessageRail）。
 *
 * 阈值取值的来由（900px 视口，`.superagent` 以外不假设）：
 *   - 面板上限 70vh ≈ 630px；28px 一行最多站 22 行 —— 所以从 **18 行**起压缩
 *     （18×28+8 = 512px，离天花板还有余量）；
 *   - 到 **60 行**压到最小：60×10+8 = 608px，仍在 630px 之内（这一档之前**完全不用滚动**）；
 *   - 再长就如实滚动，但 10px/行 比 28px/行 少滑 2/3 —— 100 轮从 2808px 降到 1008px。
 *
 * **几何数学只住在这里**（组件不再写死 `h-7`：行高由 CSS 变量 `--rail-row` 喂进去，
 * 与 `TrajectoryLedger.ROW_HEIGHT` 同一套"布局与元素共用一个来源"的做法）。
 */
export const RAIL_ROW_HEIGHT_FULL = 28
/** 压缩下限：10px ≥ 触达下限 8px（再小就不是"可点的一条"了） */
export const RAIL_ROW_HEIGHT_MIN = 10
/** 到这个条数为止都用满行高 */
export const RAIL_FULL_ROWS = 18
/** 到这个条数压到最小行高 */
export const RAIL_MIN_ROWS = 60
/** 面板内边距（`p-1`）：总高 = 行数 × 行高 + 2 × 这个值 */
export const RAIL_PANEL_PADDING = 4

/** 一条用户消息占的行高（条数 → px；调过阈值的都得看这里，别在组件里再写死一个数） */
export function railRowHeight(count: number): number {
  if (!Number.isFinite(count) || count <= RAIL_FULL_ROWS) return RAIL_ROW_HEIGHT_FULL
  if (count >= RAIL_MIN_ROWS) return RAIL_ROW_HEIGHT_MIN
  const t = (count - RAIL_FULL_ROWS) / (RAIL_MIN_ROWS - RAIL_FULL_ROWS)
  const shrunk = RAIL_ROW_HEIGHT_FULL - (RAIL_ROW_HEIGHT_FULL - RAIL_ROW_HEIGHT_MIN) * t
  return Math.max(RAIL_ROW_HEIGHT_MIN, Math.min(RAIL_ROW_HEIGHT_FULL, Math.round(shrunk)))
}

/** 整条轨的高度（不含 hover 展开那一行的临时增量）：给注释与 spec 用的一处口径 */
export function railPanelHeight(count: number): number {
  return count * railRowHeight(count) + 2 * RAIL_PANEL_PADDING
}

/** 用户消息摘要：所有 text part 压成一行（面板里由 CSS 截断，不再切字） */
export function summarizeMessage(message: UIMessage): string {
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? '（无文本）' : text
}

/** 当前节点 = 顶边已越过容器上沿的最后一条；都没有（还没滚动）取第一条 */
export function activeUserIdFrom(
  entries: ReadonlyArray<{ id: string; top: number }>,
  threshold = RAIL_ACTIVE_THRESHOLD
): string | null {
  if (entries.length === 0) return null
  let active: string | null = null
  for (const entry of entries) {
    if (entry.top <= threshold) active = entry.id
  }
  return active ?? entries[0].id
}
