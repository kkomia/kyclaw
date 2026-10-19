import { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import './chase-loader.css'

/**
 * PB-032 · 状态行左侧装载指示器（照抄 dsh-claude-style 的 chat-wait loader）。
 *
 * 三种 motion（DSH 原值）：
 *   - bounce：3 颗 4px 点，0.5s alternate；落点压扁 scale(1.7,.25)，抬起 8px；延迟 -500/-300/-200ms
 *   - line：3 颗点各沿一条 120° 线穿过同一中心；1.25s linear；中点 scale .55；延迟 0/-1/3/-2/3 周期
 *   - orbit：4 颗点绕椭圆（±4.75px / ±5.8px）；2.4s linear
 *
 * 节奏（同 DSH）：
 *   - 每 10s **随机换一个不同于当前的 motion**（`--dsh-claude-period-dot-rotate`）；
 *   - 阶段变化时，motion 至少站 2s 才允许被状态接管（STYLE.md:685-686）；
 *   - 换词后 1s 内不轮换（避免「文字换 + 动画换」同帧，PB-032 规格 §9.5）；
 *   - 交接用 120/150ms 双 lane 淡入淡出（v1 简化；DSH 是逐点按剩余相位淡出）。
 *
 * reduced-motion：固定 bounce 静态三点、不排 10s 定时器（两层 CSS 兜底见 chase-loader.css）。
 */
export type ChaseMotion = 'bounce' | 'line' | 'orbit'

const MODES: readonly ChaseMotion[] = ['bounce', 'line', 'orbit']
const ROTATE_MS = 10_000
const STAND_MS = 2_000
const FADE_MS = 150
const WORD_SETTLE_MS = 1_000

export interface ChaseLoaderProps {
  /** 阶段进入时的 motion（由 latestStepStage 给出） */
  entryMotion: ChaseMotion
  /** 当前状态词：换词后 1s 内不轮换（只用于节流，不参与渲染） */
  word: string
  /** 应用设置/系统折算后的 reduced */
  reduced: boolean
}

function ChaseLane({ mode, leaving }: { mode: ChaseMotion; leaving: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'chase-lane',
        `chase-lane--${mode}`,
        leaving ? 'chase-lane--leaving' : 'chase-lane--active'
      )}
      aria-hidden="true"
    >
      <span className="chase-dot" />
      <span className="chase-dot" />
      <span className="chase-dot" />
      <span className="chase-dot" />
    </span>
  )
}

export function ChaseLoader({ entryMotion, word, reduced }: ChaseLoaderProps): React.JSX.Element {
  const [mode, setMode] = useState<ChaseMotion>(entryMotion)
  const [leaving, setLeaving] = useState<ChaseMotion | null>(null)
  const modeRef = useRef<ChaseMotion>(entryMotion)
  // 初始「最近一次换 motion」= 挂载时刻：否则 2s 站立窗口会被算成 0，阶段一切换就立刻换动画。
  // 不在 render 里读 Date.now()（react-hooks/purity）：改用挂载后的 effect 打点，
  // 且声明在下面"阶段变化"effect 之前 —— effect 按声明顺序执行，读到的一定是挂载时刻。
  const lastSwitchRef = useRef<number>(0)
  const wordAtRef = useRef(0)
  const leaveTimerRef = useRef<number | null>(null)

  useEffect(() => {
    lastSwitchRef.current = Date.now()
  }, [])

  const switchTo = (next: ChaseMotion): void => {
    const current = modeRef.current
    if (next === current) return
    modeRef.current = next
    lastSwitchRef.current = Date.now()
    setLeaving(current)
    setMode(next)
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null
      setLeaving(null)
    }, FADE_MS)
  }

  // 换词时间（节流轮换用）
  useEffect(() => {
    wordAtRef.current = Date.now()
  }, [word])

  // 阶段变化：该阶段的入场 motion 至少站 2s 后才接管
  useEffect(() => {
    if (reduced) return undefined
    const wait = Math.max(0, STAND_MS - (Date.now() - lastSwitchRef.current))
    if (wait === 0) {
      if (modeRef.current !== entryMotion) switchTo(entryMotion)
      return undefined
    }
    const timer = window.setTimeout(() => switchTo(entryMotion), wait)
    return () => window.clearTimeout(timer)
    // switchTo 是纯操作型闭包（依赖 ref），不入 deps 以免每次渲染重启定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryMotion, reduced])

  // 每 10s 随机换一个不同于当前的 motion；reduced 不排定时器
  useEffect(() => {
    if (reduced) return undefined
    const id = window.setInterval(() => {
      if (Date.now() - wordAtRef.current < WORD_SETTLE_MS) return
      const options = MODES.filter((candidate) => candidate !== modeRef.current)
      const next = options[Math.floor(Math.random() * options.length)]
      if (next !== undefined) switchTo(next)
    }, ROTATE_MS)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  useEffect(
    () => () => {
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    },
    []
  )

  // reduced 固定 bounce 静态三点（不展示 line/orbit 的位移终点）
  const effectiveMode: ChaseMotion = reduced ? 'bounce' : mode
  return (
    <span
      data-testid="chase-loader"
      data-mode={effectiveMode}
      className={cn('chase-loader', reduced && 'chase-loader--reduced')}
      aria-hidden="true"
    >
      {!reduced && leaving !== null ? <ChaseLane mode={leaving} leaving /> : null}
      <ChaseLane mode={effectiveMode} leaving={false} />
    </span>
  )
}
