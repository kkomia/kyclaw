/**
 * 新增标签页「继续」栏的相对时间（task-80；DESIGN §9.2）。
 *
 * 语义：`lastActiveAt` = 该文档标签**上次被激活**的时间（不是文件修改时间）。
 * 文案：`< 60s` 刚刚；`< 60min` N 分钟前；同一日历日 N 小时前；昨天；更早 `M 月 D 日`。
 * 纯函数（now 可注入），数字走 tabular（调用方给 font-code）。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function startOfDay(timeMs: number): number {
  const date = new Date(timeMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 毫秒时间戳 → 「继续」行尾相对文案（坏时间回空串，调用方不渲染） */
export function relativeNewTabTime(timeMs: number, now: Date = new Date()): string {
  if (!Number.isFinite(timeMs)) return ''
  const nowMs = now.getTime()
  const diff = nowMs - timeMs
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${String(Math.floor(diff / MINUTE))} 分钟前`

  const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(timeMs)) / DAY)
  if (dayDiff <= 0) return `${String(Math.floor(diff / HOUR))} 小时前`
  if (dayDiff === 1) return '昨天'

  const date = new Date(timeMs)
  return `${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日`
}
