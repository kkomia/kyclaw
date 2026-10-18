import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { ArrowDown, ChevronRight } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { useEffectiveMotion } from '@renderer/lib/motion'
import { approvalRequestOf } from '../approval'
import type { ReasoningOverrides } from '../reasoning-overrides'
import { ReasoningPart } from './ReasoningPart'
import { ToolCard } from './ToolCard'
import { isToolPart, toToolCardPart, toolStateRunning } from './tool-part'
import { TraceFold } from './TraceFold'
import { processSummaryOf } from './process-summary'
import {
  TURN_PROCESS_MAX_ROWS,
  TURN_PROCESS_STICKY_DISTANCE,
  formatTurnDuration
} from './turn-process-metrics'
import '../turn-process.css'

/**
 * 「本轮过程」统一容器（task-52）：把一轮里**连续的一段**思考 + 工具调用收进一个块。
 *
 * 用户口径（2026-10-18 原话）：「工具调用过程 现在通过统一大的内容约束到里面滚动输出。
 * 参考 dsh claude style 插件的实现。大滚动固定长度。」
 *
 * 结构：
 *   - 头部一行 = 摘要「执行 N 次思考 · 调用 M 次工具」+ 状态（进行中 / 已完成[ · 用时 X 分 Y 秒]）
 *     + chevron；整行可点（开合）；
 *   - 正文 = 固定上限高度的**内部滚动区**（`--turn-process-max-height`，默认 360px）：
 *     思考段与工具行按原顺序渲染，工具行沿用 ToolCard（结果详情/600 字截断/TraceFold 开合全部保留）；
 *     超过 ~200 行只渲染最近 200 行，并在顶部标「更早的 N 行已折叠」（无虚拟化时的硬上限）。
 *
 * 开合：进行中默认展开；跑完自动收起成一行摘要；用户手动点过以后**听用户的**（override 优先）。
 * 错误 / 审批 / AskUser 卡片不进这里：它们是必须看见的交互件，仍在各自原位（输入框上方停靠）。
 *
 * 流式：新增行时若用户停在底部附近 → 自动跟到底；用户手动上滚后不再抢，并给「回到底部」。
 * 性能：行 key 用 part 原始下标（稳定身份，追加不重挂）；整块只在自身 props 变化时重渲染。
 */
export interface TurnProcessEntry {
  part: UIMessage['parts'][number]
  /**
   * 这条 part 在消息里的**原始下标**：当 React key 用（稳定身份，追加行不重挂）。
   */
  index: number
  /** 这一条是消息里最后一条可渲染内容且轮次还在流式（思考行据此显示"思考中…"） */
  streaming: boolean
  /** 这一段后面已经有别的内容上屏（思考框据此自动收起，见 ReasoningPartProps.settled） */
  settled: boolean
}

export interface TurnProcessProps {
  entries: TurnProcessEntry[]
  /** 这一轮还在流式（进行中 → 默认展开；跑完自动收起） */
  running: boolean
  /** 折叠态下方是否还有正文（有正文才画「汇总行↔正文」hairline；无条目/无正文不出线） */
  hasAnswer?: boolean
  /**
   * 块内思考行的**手动开合表**（键 = reasoning 序号）：由 `Message` 持有。
   * 消息从"纯思考"换成"思考 + 工具"时整棵子树会重挂，本地 state 会丢，
   * 用户手动展开的选择必须存在这一层之上。
   */
  overrides?: ReasoningOverrides
  /** part 下标 → reasoning 序号表（`Message` 算好传下来） */
  reasoningOrdinals?: ReadonlyMap<number, number>
  /** 用户点了块内某段思考的开合（回调带序号与那一段的正文） */
  onReasoningToggle?: (ordinal: number, text: string, open: boolean) => void
}

export function TurnProcess({
  entries,
  running,
  hasAnswer = false,
  overrides,
  reasoningOrdinals,
  onReasoningToggle
}: TurnProcessProps): React.JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null)
  const motion = useEffectiveMotion()
  const livePaint = motion.statusLine
    ? motion.statusPaint === 'wash'
      ? 'trace-wash'
      : 'trace-live'
    : undefined
  const [elapsedMs, setElapsedMs] = useState(0)
  /** 跑完那一刻冻住的用时（null = 还没跑完 / 没开始过） */
  const [frozenMs, setFrozenMs] = useState<number | null>(null)
  const [backToBottomVisible, setBackToBottomVisible] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const runningRef = useRef(running)
  /** 是否贴在底部（ref：滚动事件高频，不进渲染） */
  const pinnedRef = useRef(true)
  /** 开始时刻（只在 effect 里读时钟；渲染期不碰 impure 函数/ref） */
  const startedAtRef = useRef<number | null>(null)

  // 进行中：记开始时刻 + 每秒刷新用时（interval 回调里 setState；effect 体内不直接 setState）
  useEffect(() => {
    if (!running) return
    startedAtRef.current ??= Date.now()
    const handle = window.setInterval(() => {
      const startedAt = startedAtRef.current
      if (startedAt !== null) setElapsedMs(Date.now() - startedAt)
    }, 1000)
    return () => window.clearInterval(handle)
  }, [running])

  // 跑完的这一帧把用时冻住（render 期按 props 调整 state，React 文档认可的写法；用 elapsedMs 不读时钟）
  if (!running && frozenMs === null && elapsedMs > 0) setFrozenMs(elapsedMs)

  /** 贴底跟随：过程区内滚（ResizeObserver 合并，只读一次 scrollHeight；用户上滚时 pinned=false 不抢） */
  const followBottomNow = (): void => {
    const body = bodyRef.current
    if (body === null || !pinnedRef.current) return
    body.scrollTop = body.scrollHeight
  }
  const scheduleFollowBottom = (): void => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      followBottomNow()
    })
  }

  // 新增行/流式内容变化若停在底部 → 跟到底；layout effect 先同步定位，再 rAF 补一帧（等折叠/字体落定）
  useLayoutEffect(() => {
    const wasRunning = runningRef.current
    runningRef.current = running
    // 新的一轮开始：重置贴底（换消息/重跑不走这里：组件按消息 key 重挂）
    if (running && !wasRunning) {
      pinnedRef.current = true
      setBackToBottomVisible(false)
    }
    followBottomNow()
    scheduleFollowBottom()
  }, [entries, running])

  // 内容高度在 stream 中间增长（思考文字/工具输出/状态行）不会改变 entries.length：
  // 用 ResizeObserver 监听内容层，运行中且用户仍贴底就继续跟随。
  useLayoutEffect(() => {
    if (!running) return undefined
    const content = contentRef.current
    if (content === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => scheduleFollowBottom())
    observer.observe(content)
    scheduleFollowBottom()
    return () => observer.disconnect()
  }, [running])

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
    },
    []
  )

  const reasoningCount = entries.filter((entry) => entry.part.type === 'reasoning').length
  const toolCount = entries.filter((entry) => isToolPart(entry.part)).length
  const toolStagger = new Map<number, number>()
  let toolOrdinal = 0
  for (const entry of entries) {
    if (!isToolPart(entry.part)) continue
    // 沿用 P1b 配方 6：工具行入场 150ms + 每行 70ms stagger，最多 5 行
    toolStagger.set(entry.index, Math.min(toolOrdinal, 4))
    toolOrdinal += 1
  }

  /** 还有等审批的调用：默认展开（让用户看得见卡在哪一步；点一下照样能收） */
  const pending = entries.some((entry) => approvalRequestOf(entry.part) !== null)
  // DSH 语义：过程组运行中自动展开、这一段结束即收起（读者手动 override 优先）
  const open = override ?? (running || pending)
  // 纯思考轮完成收起，但内容保留在 DOM（DSH 收起语义 + 既有选文/测试契约）
  const mountProcessContent = toolCount === 0

  const summary = processSummaryOf({ thinking: reasoningCount, tool: toolCount })
  /** 宽度实测：full 放不下一行就用 compact（隐藏 fit span 同字体量；ResizeObserver 重算） */
  const [compact, setCompact] = useState(false)
  const summaryMeasureRef = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    const measure = summaryMeasureRef.current
    const row = measure?.parentElement
    if (measure === null || !row) return
    const fit = (): void => {
      const available = Math.max(0, row.clientWidth - 96) // 右侧 status/chevron/间距预留
      setCompact(measure.getBoundingClientRect().width > available)
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(fit)
    observer.observe(row)
    return () => observer.disconnect()
  }, [summary.full])

  const shownMs = running ? elapsedMs : (frozenMs ?? 0)
  // task-115：正常完成不再写「已完成」（只保留用时）；历史无用时则整块 meta 不渲染
  const statusText = running
    ? '进行中'
    : frozenMs === null || frozenMs <= 0
      ? null
      : `用时 ${formatTurnDuration(shownMs)}`

  const overflow = Math.max(0, entries.length - TURN_PROCESS_MAX_ROWS)
  const visibleEntries = overflow === 0 ? entries : entries.slice(overflow)

  /** 这一行思考的手动选择（没序号 / 没记过 = 不受控） */
  const overrideOfReasoning = (partIndex: number, text: string): boolean | undefined => {
    const ordinal = reasoningOrdinals?.get(partIndex)
    if (ordinal === undefined || overrides === undefined) return undefined
    const choice = overrides.get(ordinal)
    return choice !== undefined && text.startsWith(choice.text) ? choice.open : undefined
  }

  const handleScroll = (): void => {
    const body = bodyRef.current
    if (body === null) return
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight
    const pinned = distance <= TURN_PROCESS_STICKY_DISTANCE
    pinnedRef.current = pinned
    setBackToBottomVisible(!pinned)
  }

  const scrollToBottom = (): void => {
    const body = bodyRef.current
    pinnedRef.current = true
    setBackToBottomVisible(false)
    if (body !== null) body.scrollTop = body.scrollHeight
  }

  return (
    <div data-testid="turn-process" className="flex flex-col">
      {/* 兼容既有测试契约：根仍叫 trace-block / data-open / data-pending（过程块语义没变） */}
      <div
        data-testid="trace-block"
        data-open={open ? 'true' : 'false'}
        data-pending={pending ? 'true' : undefined}
        data-running={running ? 'true' : undefined}
      >
        <div
          data-testid="turn-process-header"
          data-has-divider={entries.length > 0 && (open || hasAnswer) ? 'true' : undefined}
          className={cn(
            'turn-process-header',
            entries.length > 0 && (open || hasAnswer) && 'turn-process-header--divider'
          )}
        >
          <button
            type="button"
            data-testid="trace-toggle"
            data-running={running ? 'true' : undefined}
            aria-expanded={open}
            aria-label={summary.full}
            onClick={() => setOverride(!open)}
            className="group/row flex min-h-7 w-full cursor-pointer items-center gap-2 text-left text-b2 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none"
          >
            <span
              data-testid="ai-identity-spark"
              aria-hidden="true"
              className={cn(
                'inline-flex size-3.5 shrink-0 items-center justify-center text-(--accent)',
                running &&
                  'animate-[identity-spark_2.4s_ease-in-out_infinite] motion-reduce:animate-none'
              )}
            >
              <svg viewBox="0 0 14 14" className="size-3.5" fill="none" aria-hidden="true">
                <path
                  d="M7 1.2 8.2 5.7 12.8 7 8.2 8.3 7 12.8 5.8 8.3 1.2 7l4.6-1.3Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span
              ref={summaryMeasureRef}
              aria-hidden="true"
              className="pointer-events-none invisible absolute max-w-none whitespace-nowrap text-b2"
            >
              {summary.full}
            </span>
            <span
              data-testid="turn-process-summary"
              className={cn('shrink-0 whitespace-nowrap', running && livePaint)}
            >
              <span
                key={summary.full}
                data-rolling="true"
                className="inline-block motion-safe:animate-[process-summary-in_var(--motion-ease-settle)] motion-reduce:animate-none"
                style={{ animationDuration: '160ms' }}
              >
                {compact ? summary.compact : summary.full}
              </span>
            </span>
            {statusText === null ? null : (
              <span
                data-testid="turn-process-status"
                className="shrink-0 text-ink-tertiary tabular-nums"
              >
                {statusText}
              </span>
            )}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
                open && 'rotate-90'
              )}
            />
          </button>
        </div>

        <TraceFold open={open} mountContent={mountProcessContent}>
          <div className="relative pt-3">
            <div
              ref={bodyRef}
              data-testid="turn-process-body"
              className="turn-process-body"
              onScroll={handleScroll}
            >
              <div ref={contentRef} className="turn-process-rows">
                {overflow === 0 ? null : (
                  <p data-testid="turn-process-more" className="text-c1 text-ink-tertiary">
                    更早的 {overflow} 行已折叠（只保留最近 {TURN_PROCESS_MAX_ROWS} 行）
                  </p>
                )}
                {visibleEntries.map((entry) => {
                  const part = entry.part
                  if (part.type === 'reasoning') {
                    return (
                      <ReasoningPart
                        key={`reasoning-${entry.index}`}
                        text={part.text}
                        streaming={entry.streaming}
                        // 这一轮没跑完就保持展开：思考段后面跟着工具行时 entry.streaming 已翻 false
                        live={running}
                        settled={entry.settled}
                        override={overrideOfReasoning(entry.index, part.text)}
                        onToggle={(nextOpen) => {
                          const ordinal = reasoningOrdinals?.get(entry.index) ?? -1
                          if (ordinal >= 0) onReasoningToggle?.(ordinal, part.text, nextOpen)
                        }}
                      />
                    )
                  }
                  const tool = toToolCardPart(part)
                  if (tool === null) return null
                  return (
                    <ToolCard
                      key={`tool-${entry.index}`}
                      part={tool}
                      running={running && toolStateRunning(tool.state)}
                      staggerIndex={toolStagger.get(entry.index) ?? 0}
                    />
                  )
                })}
              </div>
            </div>
            {backToBottomVisible ? (
              <button
                type="button"
                data-testid="turn-process-back-to-bottom"
                onClick={scrollToBottom}
                className="turn-process-back-to-bottom inline-flex items-center gap-1 rounded-pill border-(length:--hairline-width) border-hairline bg-surface px-2 py-0.5 text-c1 text-ink-secondary shadow-(--doc-page-shadow) transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none"
              >
                <ArrowDown aria-hidden="true" className="size-3" />
                回到底部
              </button>
            ) : null}
          </div>
        </TraceFold>
      </div>
    </div>
  )
}
