/**
 * 步骤列表（按轮次分组）：表头 / 步骤分隔 / 数据行 / 折叠摘要四种条目。
 *
 * **有界渲染**：超长会话（几百上千条）不能一次挂满 —— 行高统一（`ROW_HEIGHT`，行高也由它
 * 内联给行元素，CSS 与布局数学只有一个来源、不会漂移），只挂"可见窗口 + 上下各 8 行缓冲"。
 * 视口高度实测不到（jsdom / 首帧）或条目本来就少时**整份渲染**（退化成普通列表，不出错）。
 *
 * 选中行与时间轴的联动：`data-selected` 由 `selectedIndex` 给，点击回调出去 —— 单向数据流，
 * 视图层是唯一真源（时间轴那边同样读它）。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { IconButton } from '@renderer/components/ui/icon-button'
import { formatDuration, KIND_LABEL, type TrajectoryRow } from './model'
import type { LedgerItem } from './ledger'

/** 列表行高（含表头与分隔行）：布局数学与行元素共用这一个值 */
export const ROW_HEIGHT = 32
/** 超过这个条数才开窗口（小列表整份挂，省掉一层 spacer 与滚动同步） */
const WINDOW_THRESHOLD = 120
/** 可见窗口上下各多挂几行（滚动时不闪白） */
const OVERSCAN = 8

export interface TrajectoryLedgerProps {
  items: LedgerItem[]
  selectedIndex: number | null
  /** 搜索命中的行序号；null = 没在搜索 */
  matchIndexes: ReadonlySet<number> | null
  onSelect: (rowIndex: number) => void
  onToggleTurn: (turn: number) => void
}

/** 一行数据（工具行给"工具名 + 参数摘要 → 结果摘要"，右侧给时长） */
function DataRow({
  row,
  selected,
  matched,
  onSelect
}: {
  row: TrajectoryRow
  selected: boolean
  matched: boolean
  onSelect: (rowIndex: number) => void
}): React.JSX.Element {
  const duration = formatDuration(row.durationMs)
  return (
    <button
      type="button"
      data-testid={`trajectory-row-${row.index}`}
      data-kind={row.kind}
      data-selected={selected ? 'true' : undefined}
      data-error={row.isError ? 'true' : undefined}
      data-matched={matched ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(row.index)}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-control px-2 text-left transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
        selected ? 'bg-selected' : 'hover:bg-hover'
      )}
    >
      <span
        className={cn(
          'w-12 shrink-0 text-right text-c2',
          row.kind === 'tool' ? 'text-warning' : 'text-ink-tertiary'
        )}
      >
        {KIND_LABEL[row.kind]}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-c1',
          row.kind === 'tool' ? 'font-mono text-ink-secondary' : 'text-ink'
        )}
      >
        {row.text}
      </span>
      {row.pending ? <span className="shrink-0 text-c2 text-ink-tertiary">进行中</span> : null}
      <span className="shrink-0 font-mono text-c2 tabular-nums text-ink-tertiary">
        {duration ?? ''}
      </span>
    </button>
  )
}

export function TrajectoryLedger({
  items,
  selectedIndex,
  matchIndexes,
  onSelect,
  onToggleTurn
}: TrajectoryLedgerProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // 视口高度：实测（ResizeObserver 不在的环境就停在 0 → 整份渲染）
  useEffect(() => {
    const element = scrollRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      setViewportHeight(entries[0]?.contentRect.height ?? 0)
    })
    observer.observe(element)
    setViewportHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // 选中行滚进视野（与时间轴联动的另一半）
  useEffect(() => {
    if (selectedIndex === null) return
    const element = scrollRef.current
    if (element === null) return
    const position = items.findIndex(
      (item) => item.type === 'row' && item.row.index === selectedIndex
    )
    if (position === -1) return
    const top = position * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top >= element.scrollTop && bottom <= element.scrollTop + element.clientHeight) return
    element.scrollTop = top - (element.clientHeight - ROW_HEIGHT) / 2
  }, [items, selectedIndex])

  const windowed = viewportHeight > 0 && items.length > WINDOW_THRESHOLD
  const first = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0
  const last = windowed
    ? Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
    : items.length
  const visible = items.slice(first, last)

  return (
    <div
      ref={scrollRef}
      data-testid="trajectory-ledger"
      aria-label="轨迹步骤"
      className="min-h-0 flex-1 overflow-auto px-2 pb-2"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {items.length === 0 ? (
        <p data-testid="trajectory-ledger-empty" className="px-2 py-3 text-c1 text-ink-tertiary">
          没有步骤
        </p>
      ) : null}

      {windowed ? <div style={{ height: first * ROW_HEIGHT }} aria-hidden="true" /> : null}

      {visible.map((item) => {
        if (item.type === 'turn') {
          return (
            <div
              key={item.key}
              data-testid={`trajectory-turn-${item.turn ?? 'between'}`}
              style={{ height: ROW_HEIGHT }}
              className="flex items-center gap-2 rounded-control bg-secondary px-2"
            >
              {item.foldable ? (
                <IconButton
                  data-testid={`trajectory-turn-toggle-${item.turn}`}
                  label={item.collapsed ? '展开这一轮' : '收起这一轮'}
                  icon={
                    <ChevronRight
                      className={cn(
                        'transition-transform duration-(--motion-main) ease-main motion-reduce:transition-none',
                        item.collapsed ? '' : 'rotate-90'
                      )}
                    />
                  }
                  className="size-5 shrink-0 border-transparent"
                  onClick={() => {
                    if (item.turn !== null) onToggleTurn(item.turn)
                  }}
                />
              ) : (
                <span aria-hidden="true" className="size-5 shrink-0" />
              )}
              <span className="shrink-0 text-c1 text-ink-secondary">{item.label}</span>
              {item.prompt === null ? null : (
                <span className="min-w-0 flex-1 truncate text-c1 text-ink-tertiary">
                  {item.prompt}
                </span>
              )}
              <span className="min-w-0 flex-1" />
              {item.usageText === null ? null : (
                <span className="shrink-0 font-mono text-c2 tabular-nums text-ink-tertiary">
                  {item.usageText}
                </span>
              )}
            </div>
          )
        }

        if (item.type === 'step') {
          return (
            <div
              key={item.key}
              data-testid={`trajectory-step-${item.turn}-${item.step}`}
              style={{ height: ROW_HEIGHT }}
              className="flex items-center px-2 pl-7"
            >
              <span className="text-c2 text-ink-tertiary">{item.label}</span>
            </div>
          )
        }

        if (item.type === 'collapsed') {
          return (
            <button
              key={item.key}
              type="button"
              data-testid={`trajectory-collapsed-${item.turn}`}
              onClick={() => onToggleTurn(item.turn)}
              style={{ height: ROW_HEIGHT }}
              className="flex w-full items-center rounded-control px-2 pl-7 text-left transition-colors duration-(--motion-fast) ease-main hover:bg-hover motion-reduce:transition-none"
            >
              <span className="truncate text-c1 text-ink-secondary">{item.summary}</span>
            </button>
          )
        }

        return (
          <DataRow
            key={item.key}
            row={item.row}
            selected={selectedIndex === item.row.index}
            matched={matchIndexes === null || matchIndexes.has(item.row.index)}
            onSelect={onSelect}
          />
        )
      })}

      {windowed ? (
        <div style={{ height: Math.max(0, items.length - last) * ROW_HEIGHT }} aria-hidden="true" />
      ) : null}
    </div>
  )
}
