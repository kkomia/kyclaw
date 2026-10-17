/**
 * 思考强度面板 v2.1（task-78 照抄 dsh-claude-style；task-84 常驻元素格 + 输入框对齐）：
 *   - 标题行：`Reasoning effort` + 当前档位英文（Default/Low/High/Max）+ 右上百分比；
 *   - 两端：`Faster` ↔ `Smarter`（源码 en 词表）；
 *   - 轨道：30px 高；**元素格常驻**（5 行，横向亮度梯度：左暗 → 右亮，低频闪烁，不拖也动）；
 *   - Max 档（75–100%）进入 apex：元素格切紫色 + 滑钮紫色辉光（dsh 的 matrix 算法）；
 *   - 无极 0–100（原生 range 覆盖在轨道上：←/→/Home/End、aria slider 原生可用）；
 *   - reduced-motion 全静态（保留梯度）；底层仍写 `thinkingEffort` 设置。
 *
 * 性能：矩阵抽成 memo 子组件，只依赖列数/行数/内边距（拖动进度时父组件重渲染不会重渲染矩阵，
 * 也不重播入场动画）；元素格动画全部走 CSS，React 不在拖动过程中每帧重算矩阵。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { Popover } from '@renderer/components/ui/popover'
import type { ThinkingEffortSpec } from '@shared/models'
import { useEffectiveMotion } from '@renderer/lib/motion'
import {
  EFFORT_FASTER_TEXT,
  EFFORT_LABEL_TEXT,
  EFFORT_SMARTER_TEXT,
  effortDisplayLabel,
  effortForPercent,
  effortMatrixCellStyle,
  effortMatrixLayout,
  isApexPercent,
  percentForEffort
} from './thinking-effort-model'
import './thinking-effort.css'

export interface ThinkingEffortProps {
  efforts: readonly ThinkingEffortSpec[]
  effortId: string
  onSelect: (effortId: string) => void
}

/** 滑钮宽 16、高 30（照抄 dsh `.dsh-claude-effort-knob`）；fill 从滑钮中心起算 */
const KNOB_WIDTH = 16
/** 轨道可见高（不含左右 0 的内边距）；矩阵按它算列数 */
const MATRIX_HEIGHT = 26
const MATRIX_GAP = 1
/** 元素格低频闪烁周期（常驻动画；不是拖动才出现） */
const TWINKLE_PERIOD_SECONDS = 2.6

/** 把百分比换算成「滑钮左缘相对轨道」的 CSS 长度：percent% 走 span=W-16，即 pct% - pct*0.16px */
function knobLeft(percent: number): string {
  return `calc(${percent}% - ${((percent / 100) * KNOB_WIDTH).toFixed(2)}px)`
}

/** 滑钮中心相对轨道的 CSS 长度（fill 右缘） */
function knobCenter(percent: number): string {
  return `calc(${percent}% - ${((percent / 100) * KNOB_WIDTH - KNOB_WIDTH / 2).toFixed(2)}px)`
}

interface EffortMatrixProps {
  cols: number
  rows: number
  padTop: number
  padRight: number
  padBottom: number
  padLeft: number
  gap: number
}

/**
 * 常驻元素格（memo：拖动进度时 props 不变 → 不重渲染、不重播入场）。
 * 每格 opacity 由列方向 smoothstep 决定（左暗右亮）；闪烁/时长由 CSS 动画承担。
 */
const EffortMatrix = memo(function EffortMatrix({
  cols,
  rows,
  padTop,
  padRight,
  padBottom,
  padLeft,
  gap
}: EffortMatrixProps): React.JSX.Element {
  const cells = useMemo(
    () =>
      Array.from({ length: rows * cols }, (_, index) => {
        // CSS grid 是 auto-flow row（先铺满一行再下一行）→ DOM 顺序 = row-major。
        // 亮度只由**列**决定：同一列所有行一致，越靠右越亮（task-87：不能按 index 交替出纵向成分）。
        const row = Math.floor(index / cols)
        const col = index % cols
        return effortMatrixCellStyle(row, col, cols, TWINKLE_PERIOD_SECONDS)
      }),
    [cols, rows]
  )

  return (
    <div
      data-testid="effort-matrix"
      className="thinking-effort-matrix"
      aria-hidden="true"
      style={{
        padding: `${padTop}px ${padRight}px ${padBottom}px ${padLeft}px`,
        gap: `${gap}px`,
        // 列用 1fr 填满轨道（dsh 用固定 sq 尺寸；这里按轨道实际宽自适应）
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`
      }}
    >
      {cells.map((cell, index) => (
        <span key={index} className="thinking-effort-matrix-cell">
          {/* task-88：梯度走 CSS 变量 + data-opacity（**不用** inline opacity）——
              twinkle 只动画 filter，任何 CSS animation 都不会覆盖梯度；
              e2e/单测可直接读 data-opacity 或 computed opacity 断言右亮左暗。 */}
          <span
            className="thinking-effort-matrix-sq"
            data-tone={cell.tone}
            data-opacity={cell.opacity.toFixed(3)}
            style={
              {
                '--effort-cell-opacity': cell.opacity.toFixed(3),
                animationDelay: cell.animationDelay,
                animationDuration: cell.animationDuration
              } as React.CSSProperties
            }
          />
        </span>
      ))}
    </div>
  )
})

export function ThinkingEffort({
  efforts,
  effortId,
  onSelect
}: ThinkingEffortProps): React.JSX.Element {
  const motion = useEffectiveMotion()
  const [open, setOpen] = useState(false)
  const [percent, setPercent] = useState(() => percentForEffort(efforts, effortId))
  const [dragging, setDragging] = useState(false)
  const [trackWidth, setTrackWidth] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const lastEffortRef = useRef(effortId)

  // 外部档位变化（切模型/设置写回）时同步滑杆位置
  useEffect(() => {
    if (lastEffortRef.current === effortId) return
    lastEffortRef.current = effortId
    setPercent(percentForEffort(efforts, effortId))
  }, [efforts, effortId])

  // 元素格按轨道实际宽度排版（dsh 的 r()）；jsdom 没有 ResizeObserver 时用 264 兜底
  useEffect(() => {
    if (!open) return
    const element = trackRef.current
    if (element === null) return
    const measure = (): void => setTrackWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  // 当前档位以滑杆位置为准（拖动时立即显示英文档位；外部 effortId 变化会先同步 percent）
  const currentId = effortForPercent(efforts, percent)?.id ?? effortId
  const current = efforts.find((effort) => effort.id === currentId)
  const displayLabel = effortDisplayLabel(current?.id ?? currentId)
  const apex = isApexPercent(percent)
  const layout = useMemo(
    () =>
      effortMatrixLayout(trackWidth > 0 ? trackWidth : 264, {
        height: MATRIX_HEIGHT,
        gap: MATRIX_GAP
      }),
    [trackWidth]
  )

  const applyPercent = (next: number): void => {
    const clamped = Math.min(100, Math.max(0, Math.round(next)))
    setPercent(clamped)
    const effort = effortForPercent(efforts, clamped)
    if (effort !== null && effort.id !== lastEffortRef.current) {
      lastEffortRef.current = effort.id
      onSelect(effort.id)
    }
  }

  const content = (
    <div
      data-testid="composer-effort-panel"
      data-motion={motion.reduced ? 'reduced' : 'full'}
      className="thinking-effort-panel w-[min(320px,calc(100vw-24px))] min-w-[min(264px,calc(100vw-24px))]"
    >
      <div
        data-testid="effort-slider-surface"
        data-apex={apex ? '' : undefined}
        data-dragging={dragging ? '' : undefined}
        className="thinking-effort"
      >
        <div className="thinking-effort-head">
          <span className="thinking-effort-label">{EFFORT_LABEL_TEXT}</span>
          <span data-testid="effort-current-label" className="thinking-effort-value">
            {displayLabel}
          </span>
          <span data-testid="effort-percent" className="thinking-effort-percent" aria-hidden="true">
            {percent}%
          </span>
        </div>
        <div className="thinking-effort-ends" aria-hidden="true">
          <span>{EFFORT_FASTER_TEXT}</span>
          <span>{EFFORT_SMARTER_TEXT}</span>
        </div>

        <div ref={trackRef} className="thinking-effort-track">
          <div className="thinking-effort-fill" style={{ width: knobCenter(percent) }} />
          {/* 元素格常驻：面板一打开就铺满轨道、低频闪烁（左侧暗、右侧亮）；apex 时 CSS 切紫色 */}
          <EffortMatrix
            cols={layout.cols}
            rows={layout.rows}
            padTop={layout.padTop}
            padRight={layout.padRight}
            padBottom={layout.padBottom}
            padLeft={layout.padLeft}
            gap={layout.gap}
          />
          <div className="thinking-effort-knob" style={{ left: knobLeft(percent) }} />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            data-testid="effort-slider"
            aria-label={EFFORT_LABEL_TEXT}
            aria-valuetext={`${displayLabel} (${percent}%)`}
            onChange={(event) => applyPercent(Number(event.target.value))}
            onPointerDown={() => setDragging(true)}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onBlur={() => setDragging(false)}
            className="thinking-effort-range"
          />
        </div>
      </div>
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      side="top"
      trigger={
        // 与 ComposerControls 的 ModelChip 触发器同版式（task-84：h-8 / px-2 / mono 12 / 同圆角），
        // 两者同一行并排时 top/bottom/height 与文字基线一致；颜色态保持 c1（secondary）。
        <button
          type="button"
          data-testid="composer-effort"
          aria-label={`${EFFORT_LABEL_TEXT}: ${displayLabel}`}
          className={cn(
            'inline-flex h-8 shrink-0 items-center rounded-control px-2 font-mono text-c1 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink motion-reduce:transition-none',
            !motion.reduced && 'thinking-effort-trigger--lit'
          )}
        >
          <span className="truncate">{displayLabel}</span>
        </button>
      }
    >
      {content}
    </Popover>
  )
}
