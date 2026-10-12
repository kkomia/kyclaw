import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import type { ThreadCompaction } from '@shared/threads'
import { formatCompactTokens } from './compaction-line'
import { TraceFold } from './parts/TraceFold'

/**
 * 「上下文已压缩」分界线（round 19 起，round 59 换成对话事件的形态）。
 *
 * 形态照 Kimi 桌面版：一行分界线 = `[发丝线][标签][查看摘要][发丝线]` —— 标签居中、
 * 细线在文字左右两侧（发丝线走仓内 hairline 口径）。标签为
 * 「上下文已压缩（527k → ~53.7k tokens）」：`after` 是服务端的**估算**值，所以带 `~`
 * （口径见 src/mastra/compaction.ts 的 estimateTokens）；两个数字缺任一 → 括号整段不显示，
 * 只留「上下文已压缩」。数字格式的单一出处：compaction-line.ts 的 formatCompactTokens。
 *
 * 「查看摘要」是强调色文字按钮（compaction-view-summary）：点开/收起下方摘要 fold —— 内容与
 * 元数据行沿用 round 19 那一套（TraceFold + compaction-summary），文案「查看摘要」⇄「收起摘要」。
 *
 * 压缩进行中：同一位置显示「正在压缩上下文…」（根节点保留 `data-compacting`，文字带既有 pulse
 * 动效口径）。**输入框区不再显示压缩的进行/成功状态**（round 59：压缩是对话流里的一件事）；
 * 只有失败与"没有可压缩的旧消息"这类操作反馈还留在输入框 notice 上。
 *
 * 位置不在这里定：分界线是对话流里的一个**时间点**，由 MessageList 按 compaction-line.ts 的
 * 定位规则插到应有的位置（刚压完 = 列表末尾，之后新到的消息排在它下面）。
 * 出现走既有进场过渡（animate-fade-in，不硬切）。
 */
export interface CompactionMarkerProps {
  /** 当前会话的压缩记录（null = 还没有记录；此时只有"进行中"这一种形态） */
  compaction: ThreadCompaction | null
  /** 压缩进行中（自动触发 / 手动入口共用） */
  compacting: boolean
}

function localTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 「上下文已压缩（before → ~after tokens）」；缺任一数字就只说"已压缩" */
function labelOf(compaction: ThreadCompaction | null): string {
  if (compaction === null) return '上下文已压缩'
  const { tokensBefore, tokensAfter } = compaction
  if (tokensBefore === null || tokensAfter === null) return '上下文已压缩'
  return `上下文已压缩（${formatCompactTokens(tokensBefore)} → ~${formatCompactTokens(tokensAfter)} tokens）`
}

export function CompactionMarker({
  compaction,
  compacting
}: CompactionMarkerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (compaction === null && !compacting) return null

  const expanded = compaction !== null && open

  return (
    <div
      data-testid="compaction-marker"
      data-compacting={compacting ? 'true' : undefined}
      className="animate-fade-in flex flex-col"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-(--hairline-width) flex-1 bg-hairline" />
        <span
          className={cn(
            'shrink-0 text-c1 text-ink-secondary',
            compacting && 'animate-pulse motion-reduce:animate-none'
          )}
        >
          {compacting ? '正在压缩上下文…' : labelOf(compaction)}
        </span>
        {compaction === null ? null : (
          <button
            type="button"
            data-testid="compaction-view-summary"
            aria-expanded={expanded}
            onClick={() => setOpen(!open)}
            className="shrink-0 cursor-pointer text-c1 text-accent-text hover:underline"
          >
            {expanded ? '收起摘要' : '查看摘要'}
          </button>
        )}
        <span aria-hidden="true" className="h-(--hairline-width) flex-1 bg-hairline" />
      </div>

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
