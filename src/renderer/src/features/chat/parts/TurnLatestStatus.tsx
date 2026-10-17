import { useEffect, useRef, useState } from 'react'
import { useEffectiveMotion } from '@renderer/lib/motion'
import { ThreeBodyGlyph } from './ThreeBodyGlyph'
import type { TurnProcessEntry } from './TurnProcess'
import { formatChineseDuration, latestStepLabel } from './turn-latest-status-model'

/**
 * AI 轮底部「最新步骤」固定状态行（task-77，参考 DSH 原生 `RunningStatus`）。
 *
 * **不是邮件/信封消息头**：DSH 的「收到任务消息」只用于 Agent Team 里收到其他 agent 的
 * 消息；kyclaw 当前没有「队友/其他 agent 消息」这种真实消息种类，因此不做、不占位、不造假，
 * 只在 Message 层留了扩展位（若以后有 agent-team 消息，再按真实数据加信封变体）。
 *
 * 这里只负责 AI 回复这一轮的过程展示：过程区固定高度内滚，最新一步固定在本轮最下方，
 * 运行中显示脉冲点 + 文案 + 中文计时（tabular）；不运行时整条不挂载（不占位）。
 * 计时每秒刷新但**不 aria-live 播报**（DSH 同口径：隐藏 status 只说「任务执行中」）。
 */
export interface TurnLatestStatusProps {
  entries: readonly TurnProcessEntry[]
  running: boolean
}

export function TurnLatestStatus({
  entries,
  running
}: TurnLatestStatusProps): React.JSX.Element | null {
  const motion = useEffectiveMotion()
  const startedAtRef = useRef<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    startedAtRef.current ??= Date.now()
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current
      if (startedAt !== null) setElapsedMs(Date.now() - startedAt)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (!running) return null
  return (
    <div
      data-testid="turn-latest-status"
      data-motion={motion.reduced ? 'reduced' : 'full'}
      className="turn-latest-status"
    >
      <ThreeBodyGlyph />
      <span aria-hidden="true" className="turn-latest-label">
        {latestStepLabel(entries)}
      </span>
      <span
        data-testid="turn-latest-duration"
        aria-hidden="true"
        className="turn-latest-duration font-mono tabular-nums"
      >
        {formatChineseDuration(elapsedMs)}
      </span>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        任务执行中
      </span>
    </div>
  )
}
