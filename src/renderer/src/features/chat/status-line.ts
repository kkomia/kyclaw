/**
 * 状态行派生（动效 B · doc §2.2/§2.3）。
 *
 * 插件口径：
 *   - **精确状态行**（`preciseStatus`）开 = 说人话「正在思考 / 正在准备工具调用 / 正在读取 X / 正在写回答…」；
 *     关 = 只给通用词（正在准备 / 正在生成 / 正在调用工具）。
 *   - 说法 **1s 锁**（每 1s 最多换一次；锁内新状态不补演，锁过直接写最新）；
 *   - 连续 **10s** 没有新输出 → 「暂未响应」；
 *   - 换词动画由 CSS `.chat-swap` 负责（150ms + 晚 50ms + ±8px + blur2，见 chat-motion.css）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatStatus, UIMessage } from 'ai'

/** 说法锁：每 1s 最多换一次（doc: Pp/Q7 = 1000） */
export const STATUS_LOCK_MS = 1_000
/** 10s 无新输出 → 暂未响应 */
export const STATUS_OVERTIME_MS = 10_000

/** 工具名 → 动词（拿不到文件名就退回「正在调用工具」，不伪造） */
function toolVerb(toolName: string): string {
  if (/^(read|glob|grep|list|search)/i.test(toolName)) return '正在读取'
  if (/^(edit|write|apply|patch)/i.test(toolName)) return '正在写入'
  if (/^(bash|run|terminal|shell)/i.test(toolName)) return '正在运行命令'
  return '正在调用工具'
}

/** 从工具入参里取一个可读目标（只取文件名/命令首段；取不到回 null） */
function toolTargetOf(part: UIMessage['parts'][number]): string | null {
  const input = (part as { input?: unknown }).input
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filename', 'file', 'relative']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const name = value.split(/[\\/]/).filter(Boolean).at(-1)
      if (name !== undefined && name !== '') return name
    }
  }
  if (typeof record.command === 'string' && record.command.trim() !== '') {
    return record.command.trim().split(/\s+/)[0] ?? null
  }
  return null
}

/**
 * 派生当前状态词（纯函数，单测直接喂 parts；不读设置）。
 * @param precise true=精确词；false=粗粒度词
 */
export function deriveStatusWord(
  status: ChatStatus,
  messages: readonly UIMessage[],
  precise: boolean
): string {
  if (status === 'submitted') return precise ? '正在准备工具调用' : '正在准备'
  if (status === 'ready' || status === 'error') return ''

  let lastUserIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') lastUserIndex = index
  }
  const tail = messages.slice(lastUserIndex + 1)
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index]
    if (message === undefined || message.role !== 'assistant') continue
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]
      if (part === undefined) continue
      if (part.type === 'text') {
        if (part.text.trim() === '') continue
        return precise ? '正在写回答' : '正在生成'
      }
      if (part.type === 'reasoning') {
        return precise ? '正在思考' : '正在思考'
      }
      if (part.type.startsWith('tool-')) {
        const toolPart = part as { toolName?: string; state?: string }
        if (toolPart.state === 'output-available' || toolPart.state === 'output-error') continue
        // typed tool part（`tool-read`）没有 toolName 字段：名字从 type 前缀取
        const name = toolPart.toolName ?? part.type.slice('tool-'.length)
        if (!precise) return '正在调用工具'
        const verb = toolVerb(name)
        const target = toolTargetOf(part)
        return target === null ? verb : `${verb} ${target}`
      }
    }
  }
  return precise ? '正在思考' : '正在思考'
}

interface StatusWordSnapshot {
  word: string
  /** 上一次真正换词的时间（锁计算用） */
  changedAt: number
}

/**
 * 状态词 hook：1s 锁 + 10s 超时。`enabled=false`（statusLine 关/reduced）时直接切最新词，
 * 不做锁等待（说法仍在，只是没有动画）。
 */
export function useStatusWord({
  status,
  messages,
  precise,
  enabled
}: {
  status: ChatStatus
  messages: readonly UIMessage[]
  precise: boolean
  enabled: boolean
}): { word: string; overtime: boolean } {
  const derived = deriveStatusWord(status, messages, precise)
  const [snapshot, setSnapshot] = useState<StatusWordSnapshot>(() => ({
    word: derived,
    changedAt: Date.now()
  }))
  const [overtime, setOvertime] = useState(false)
  const startedAtRef = useRef(0)
  const lastActivityRef = useRef(0)

  // 最近一次"内容到达"的时间（只允许在 effect 里读写 ref，不在 render 期碰）
  useEffect(() => {
    const now = Date.now()
    if (startedAtRef.current === 0) startedAtRef.current = now
    lastActivityRef.current = now
  }, [derived])

  useEffect(() => {
    if (derived === snapshot.word) return undefined
    if (!enabled) {
      // 关动画时立刻切最新词（setState 放进 0ms 定时器，避免 effect 里同步 setState）
      const timer = setTimeout(() => setSnapshot({ word: derived, changedAt: Date.now() }), 0)
      return () => clearTimeout(timer)
    }
    const wait = Math.max(0, STATUS_LOCK_MS - (Date.now() - snapshot.changedAt))
    const timer = setTimeout(() => {
      setSnapshot({ word: derived, changedAt: Date.now() })
    }, wait)
    return () => clearTimeout(timer)
  }, [derived, enabled, snapshot.word, snapshot.changedAt])

  // 10s 没有新输出：显示「暂未响应」（说法本身仍按锁更新）
  useEffect(() => {
    if (!enabled) return undefined
    const timer = setInterval(() => {
      const baseline = Math.max(startedAtRef.current, lastActivityRef.current)
      setOvertime(baseline > 0 && Date.now() - baseline >= STATUS_OVERTIME_MS)
    }, 500)
    return () => clearInterval(timer)
  }, [enabled])

  return { word: overtime ? '暂未响应' : snapshot.word, overtime }
}
