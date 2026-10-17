/**
 * 会话行的「相对时间」（task-66；参考 DSH claude-style 侧栏：行最右侧显示相对距离）。
 *
 * 纯函数（now 可注入，单测固定）。文案与阈值（与任务卡/DSH 参考一致，单位后不带“前”）：
 *   - `diff < 1 分钟`（含未来时间）→ **刚刚**
 *   - `< 1 小时` → **N 分钟**
 *   - `< 24 小时 且 同一日历日` → **N 小时**
 *     （例：23:50 的会话在 00:10 看是「今天」的 20 分钟，而不是「昨天」——先按日历日判）
 *   - 昨天（日历日差 1）→ **昨天**
 *   - 2–6 天 → **N 天**
 *   - ≥7 天 → **M 月 D 日**（跨年只到月日，与 DSH 一致；年份不显示）
 * 无法解析的 ISO → 空串（调用方不渲染时间）。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 当天 0 点（本地时区）的毫秒数：按"日历日"算差，而不是按 24h 滚动窗口 */
function startOfDay(timeMs: number): number {
  const date = new Date(timeMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** ISO 时间串 → 侧栏行尾相对文案（见文件头阈值表） */
export function relativeSessionTime(iso: string, now: Date = new Date()): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''

  const nowMs = now.getTime()
  const diff = nowMs - time
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟`

  const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(time)) / DAY)
  if (dayDiff <= 0) return `${Math.floor(diff / HOUR)} 小时`
  if (dayDiff === 1) return '昨天'
  if (dayDiff < 7) return `${dayDiff} 天`

  const date = new Date(time)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}
