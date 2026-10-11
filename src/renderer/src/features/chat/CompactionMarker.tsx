import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import type { ThreadCompaction } from '@shared/threads'
import { TraceFold } from './parts/TraceFold'

/**
 * 顶部「上下文已压缩」标记（round 19）：消息列最上方一条**可折叠**行 ——
 * 收起只露标题，点开见结构化摘要与元数据（条数/时间；数值是数据，不是解释性小字）。
 *
 * 形态照既有的折叠口径（ToolCard/TraceBlock）：aria-expanded + ChevronRight 旋转 + TraceFold
 * 双向过渡，不硬切；压缩进行中标题变「上下文压缩中…」（已有记录时行不消失，只是形态变化）。
 */
export interface CompactionMarkerProps {
  /** 当前会话的压缩记录（null = 还没压缩过） */
  compaction: ThreadCompaction | null
  /** 压缩进行中（自动触发 / 手动入口共用） */
  compacting: boolean
}

function localTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function CompactionMarker({
  compaction,
  compacting
}: CompactionMarkerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (compaction === null && !compacting) return null

  const expandable = compaction !== null
  const expanded = expandable && open

  return (
    <div
      data-testid="compaction-marker"
      data-compacting={compacting ? 'true' : undefined}
      className="flex flex-col"
    >
      <button
        type="button"
        data-testid="compaction-toggle"
        aria-expanded={expanded}
        disabled={!expandable}
        onClick={() => {
          if (expandable) setOpen(!open)
        }}
        className={cn(
          'group/row flex min-h-6 w-full items-center gap-2 text-left text-c1 text-ink-secondary',
          expandable &&
            'cursor-pointer transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none'
        )}
      >
        <span className={cn(compacting && 'animate-pulse motion-reduce:animate-none')}>
          {compacting ? '上下文压缩中…' : '上下文已压缩'}
        </span>
        {expandable ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
        ) : null}
      </button>

      {compaction === null ? null : (
        <TraceFold open={open}>
          <div
            data-testid="compaction-summary"
            className="mt-2 max-h-60 overflow-y-auto rounded-control bg-(--fill-active) px-3 py-2"
          >
            <p className="text-b2 whitespace-pre-wrap text-ink-secondary">{compaction.summary}</p>
            <p className="pt-2 text-c1 text-ink-tertiary">
              已压缩 {compaction.summarized} 条消息 · 保留最近 {compaction.kept} 条 ·{' '}
              {localTime(compaction.createdAt)}
            </p>
          </div>
        </TraceFold>
      )}
    </div>
  )
}
