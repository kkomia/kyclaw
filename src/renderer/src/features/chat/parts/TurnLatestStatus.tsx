import { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { useEffectiveMotion } from '@renderer/lib/motion'
import { ChaseLoader } from './ChaseLoader'
import type { TurnProcessEntry } from './TurnProcess'
import {
  entriesSignature,
  formatChineseDuration,
  latestStepStage,
  type StatusStage
} from './turn-latest-status-model'
import { STATUS_LOCK_MS, STATUS_OVERTIME_MS } from '../status-line'

/**
 * AI 轮底部「最新步骤」固定状态行（task-77；PB-032 扩文案 + 多动画轮换 + 换词动效）。
 *
 * **不是邮件/信封消息头**：DSH 的「收到任务消息」只用于 Agent Team 里收到其他 agent 的
 * 消息；kyclaw 当前没有「队友/其他 agent 消息」这种真实消息种类，因此不做、不占位、不造假，
 * 只在 Message 层留了扩展位（若以后有 agent-team 消息，再按真实数据加信封变体）。
 *
 * 这里只负责 AI 回复这一轮的过程展示：过程区固定高度内滚，最新一步固定在本轮最下方，
 * 运行中显示装载指示器 + 文案 + 中文计时（tabular）；不运行时整条不挂载（不占位）。
 *
 * PB-032（对标 dsh-claude-style）：
 *   - 文案：8 个真实阶段（reasoning / tool-preparing / tool-running / tool-approval /
 *     tool-approval-done / tool-result / tool-error / tool-denied），只从真实 part 状态派生；
 *   - 指示器：bounce / line / orbit 三种 motion，10s 随机轮换、状态切换至少站 2s；
 *   - 换词：`.chat-swap`（150ms + 新词晚 50ms = 200ms）+ 1s 说法锁 + 10s「暂未响应」；
 *   - reduced：静态三点、不排 10s 定时器、换词瞬切。
 *
 * 计时每秒刷新但**不 aria-live 播报**（DSH 同口径：隐藏 status 只说「任务执行中」）。
 */
export interface TurnLatestStatusProps {
  entries: readonly TurnProcessEntry[]
  running: boolean
}

/** 10s 无新输出时覆盖阶段的展示档（不是真实 part 状态，是「超时」事实） */
const OVERTIME_STAGE: StatusStage = {
  key: 'idle',
  label: '暂未响应',
  entryMotion: 'orbit'
}

/**
 * 说法锁（与 status-line 的 1s 锁同口径）：`enabled=false`（statusLine 关 / reduced）时
 * 立刻切最新词；锁内新状态不补演，锁过直接写最新。
 */
function useLockedLabel(label: string, enabled: boolean): string {
  const [snapshot, setSnapshot] = useState(() => ({ word: label, at: Date.now() }))
  useEffect(() => {
    if (label === snapshot.word) return undefined
    if (!enabled) {
      // 不在 effect 里同步 setState（react-hooks/set-state-in-effect）；0ms 定时器落位
      const timer = window.setTimeout(() => {
        setSnapshot({ word: label, at: Date.now() })
      }, 0)
      return () => window.clearTimeout(timer)
    }
    const wait = Math.max(0, STATUS_LOCK_MS - (Date.now() - snapshot.at))
    const timer = window.setTimeout(() => {
      setSnapshot({ word: label, at: Date.now() })
    }, wait)
    return () => window.clearTimeout(timer)
  }, [label, enabled, snapshot.word, snapshot.at])
  return snapshot.word
}

export function TurnLatestStatus({
  entries,
  running
}: TurnLatestStatusProps): React.JSX.Element | null {
  const motion = useEffectiveMotion()
  const startedAtRef = useRef<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (!running) return undefined
    startedAtRef.current ??= Date.now()
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current
      if (startedAt !== null) setElapsedMs(Date.now() - startedAt)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running])

  // 10s 无新输出 → 暂未响应。用「签名」判定：签名一变就自动回到当前阶段，
  // effect 里只排定时器（不同步 setState）。
  const signature = entriesSignature(entries)
  const [overtimeFor, setOvertimeFor] = useState<string | null>(null)
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setTimeout(() => {
      setOvertimeFor(signature)
    }, STATUS_OVERTIME_MS)
    return () => window.clearTimeout(timer)
  }, [running, signature])

  const overtime = running && overtimeFor === signature
  const stage = overtime ? OVERTIME_STAGE : latestStepStage(entries)
  const animated = motion.statusLine && !motion.reduced
  const word = useLockedLabel(stage.label, animated)
  const paint = animated ? (motion.statusPaint === 'wash' ? 'trace-wash' : 'trace-live') : undefined

  if (!running) return null
  return (
    <div
      data-testid="turn-latest-status"
      data-motion={motion.reduced ? 'reduced' : 'full'}
      data-stage={stage.key}
      className="turn-latest-status"
    >
      <ChaseLoader entryMotion={stage.entryMotion} word={word} reduced={motion.reduced} />
      <span aria-hidden="true" className="turn-latest-label" data-testid="turn-latest-label">
        <span key={word} className={cn(paint, animated && 'chat-swap')}>
          {word}
        </span>
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
