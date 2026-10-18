/**
 * 首页日历热力图的纯模型（task-127）：把 `/api/usage/calendar` 的「有记录的天」铺成
 * 53/54 × 7 的 GitHub contribution 网格，并给色阶。
 *
 * 口径：
 *   - 周一起始；年首/年尾用透明占位格补齐，列数按实际周数（不写死 53）；
 *   - 每天 token = input + output（与卡片 `tokens.total` 同口径）；
 *   - 色阶：活跃日 ≥4 时按 p25/p50/p75 分位；不足 4 个活跃日退回固定阈值（1k/5k/20k），
 *     避免只有两三天时全部最深；
 *   - 只消费真实数据；没有记录 = 0（空态由组件展示）。
 */
import type { UsageCalendar, UsageCalendarDay } from '@shared/usage'

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4

export interface HeatmapCell {
  /** 本地日期键；不在本年内的占位格为 null */
  date: string | null
  day: UsageCalendarDay | null
  week: number
  weekday: number
  level: HeatmapLevel
  /** 该天 token（input+output）；无记录 0 */
  tokens: number
}

export interface HeatmapMonthLabel {
  /** 1-based 周列（CSS grid-column） */
  column: number
  text: string
}

export interface HeatmapModel {
  year: number
  weeks: number
  cells: HeatmapCell[]
  months: HeatmapMonthLabel[]
  thresholds: [number, number, number]
  totalActiveDays: number
  totalTokens: number
  /** 该年最早有记录的一天（ISO 日期键）；无记录 null */
  firstDate: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAY_LABELS = ['一', '', '三', '', '五', '', ''] as const
const FALLBACK_THRESHOLDS: [number, number, number] = [1_000, 5_000, 20_000]

export function startOfWeek(date: Date): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = (next.getDay() + 6) % 7 // 周一 = 0
  next.setDate(next.getDate() - weekday)
  return next
}

export function endOfWeek(date: Date): Date {
  const next = startOfWeek(date)
  next.setDate(next.getDate() + 6)
  return next
}

export function dateKeyOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
  return sorted[index] ?? 0
}

export function heatmapThresholds(values: number[]): [number, number, number] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (active.length < 4) return FALLBACK_THRESHOLDS
  const p25 = quantile(active, 0.25)
  const p50 = quantile(active, 0.5)
  const p75 = quantile(active, 0.75)
  // 分位可能相等（大量同值）；保证严格递增后再用于分档
  return [p25, Math.max(p25 + 1, p50), Math.max(p50 + 2, p75)]
}

export function levelOfTokens(tokens: number, thresholds: [number, number, number]): HeatmapLevel {
  if (tokens <= 0) return 0
  if (tokens <= thresholds[0]) return 1
  if (tokens <= thresholds[1]) return 2
  if (tokens <= thresholds[2]) return 3
  return 4
}

/** 纯函数：用某年的（稀疏）日记录构建完整网格。 */
export function buildHeatmap(calendar: UsageCalendar): HeatmapModel {
  const year = calendar.year
  const first = new Date(year, 0, 1)
  const last = new Date(year, 11, 31)
  const gridStart = startOfWeek(first)
  const gridEnd = endOfWeek(last)
  // 列数：从第一个周一到最后一个周日覆盖的整周数（endOfWeek 是周日，因此 +1 天再除 7）
  const weeks = Math.round((gridEnd.getTime() - gridStart.getTime() + DAY_MS) / (7 * DAY_MS))
  const byDate = new Map(calendar.days.map((day) => [day.date, day]))
  const thresholds = heatmapThresholds(calendar.days.map((day) => day.input + day.output))

  const cells: HeatmapCell[] = []
  for (let week = 0; week < weeks; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + week * 7 + weekday
      )
      const inYear = date.getFullYear() === year
      const key = inYear ? dateKeyOf(date) : null
      const day = key === null ? null : (byDate.get(key) ?? null)
      const tokens = day === null ? 0 : day.input + day.output
      cells.push({
        date: key,
        day,
        week,
        weekday,
        level: key === null ? 0 : levelOfTokens(tokens, thresholds),
        tokens
      })
    }
  }

  const months: HeatmapMonthLabel[] = []
  let previousColumn = -99
  for (let week = 0; week < weeks; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + week * 7 + weekday
      )
      if (date.getFullYear() !== year || date.getDate() !== 1) continue
      if (week - previousColumn < 4) continue
      months.push({ column: week + 1, text: `${String(date.getMonth() + 1)}月` })
      previousColumn = week
      break
    }
  }

  return {
    year,
    weeks,
    cells,
    months,
    thresholds,
    totalActiveDays: calendar.totalActiveDays,
    totalTokens: calendar.totalTokens,
    firstDate: calendar.days.length > 0 ? (calendar.days[0]?.date ?? null) : null
  }
}

/** 星期标签（一/三/五；其余留空）——供组件左列渲染。 */
export function weekdayLabelOf(weekday: number): string {
  return WEEKDAY_LABELS[weekday] ?? ''
}
