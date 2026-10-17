import { isToolPart } from './tool-part'
import type { TurnProcessEntry } from './TurnProcess'

export function formatChineseDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${String(hours)}小时${String(minutes)}分${String(seconds)}秒`
  if (minutes > 0) return `${String(minutes)}分${String(seconds)}秒`
  return `${String(seconds)}秒`
}

/** 最新一步文案：从过程 entries 的最后一个 reasoning/tool 推断（不编造工具名） */
export function latestStepLabel(entries: readonly TurnProcessEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const part = entries[index]?.part
    if (part === undefined) continue
    if (part.type === 'reasoning') return '正在分析请求'
    if (isToolPart(part)) return '正在调用工具'
  }
  return '正在处理'
}
