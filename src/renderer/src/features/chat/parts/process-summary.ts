/** 过程汇总文案（task-114）：纯函数，可被 UI / 测试共用。 */
export interface ProcessCounts {
  thinking: number
  output: number
  tool: number
  record: number
}

export interface ProcessSummary {
  /** 可访问名字/宽容器文案：全角「，」连接 */
  full: string
  /** 窄容器文案：` · ` 连接 */
  compact: string
  /** 与 full 相同，供 aria-label */
  name: string
}

const ORDER: Array<keyof ProcessCounts> = ['thinking', 'output', 'tool', 'record']

const FULL: Record<keyof ProcessCounts, (n: number) => string> = {
  thinking: (n) => `执行 ${String(n)} 次思考`,
  output: (n) => `输出 ${String(n)} 段文字`,
  tool: (n) => `调用 ${String(n)} 次工具`,
  record: (n) => `记录 ${String(n)} 条`
}

const COMPACT: Record<keyof ProcessCounts, (n: number) => string> = {
  thinking: (n) => `思考×${String(n)}`,
  output: (n) => `输出×${String(n)}`,
  tool: (n) => `工具×${String(n)}`,
  record: (n) => `记录×${String(n)}`
}

export function processSummaryOf(counts: Partial<ProcessCounts>): ProcessSummary {
  const active = ORDER.filter((key) => (counts[key] ?? 0) > 0)
  const full = active.map((key) => FULL[key](counts[key] ?? 0)).join('，')
  const compact = active.map((key) => COMPACT[key](counts[key] ?? 0)).join(' · ')
  return { full, compact, name: full }
}
