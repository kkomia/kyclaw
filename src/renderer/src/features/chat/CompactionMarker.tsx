import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import type { ThreadCompaction } from '@shared/threads'
import { formatCompactTokens, LEVEL_DONE, LEVEL_LABEL, levelOf } from './compaction-line'
import { TraceFold } from './parts/TraceFold'

/**
 * 「上下文已压缩/精简/去重/折叠」分界线（round 19 起，round 59 换成对话事件的形态，
 * round 76 按档分文案）。
 *
 * 形态照 Kimi 桌面版：一行分界线 = `[发丝线][标签][查看摘要][发丝线]` —— 标签居中、
 * 细线在文字左右两侧（发丝线走仓内 hairline 口径）。标签按**档位**说人话：
 *   - `snip`   → 「上下文已精简（527k → ~53.7k tokens）」
 *   - `dedupe` → 「上下文已去重（…）」
 *   - `fold`   → 「上下文已折叠（…）」
 *   - `summary`（老记录缺 level 也走它）→ 「上下文已压缩（…）」
 * token 那一段四档共用（`after` 是服务端的**估算**值，所以带 `~`，口径见
 * src/mastra/compaction.ts 的 estimateTokens）；两个数字缺任一 → 括号整段不显示。
 * 数字格式的单一出处：compaction-line.ts 的 formatCompactTokens。
 *
 * 按钮也按档：`summary` 档是「查看摘要 / 收起摘要」（点开的是摘要原文）；
 * 机械档（snip / dedupe / fold）点开的是"这一次是怎么省的"说明（没有摘要可看），
 * 所以写「查看详情 / 收起详情」。展开内容与元数据行沿用 round 19 那一套
 * （TraceFold + compaction-summary），不另造一套交互。
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

/** 档位 → 分界线标签上的说法在 compaction-line.ts（纯映射；放组件文件里会踩
 *  react-refresh/only-export-components 那条 lint）。 */

function localTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 「上下文已<档>（before → ~after tokens）」；缺任一数字就只说"已<档>" */
function labelOf(compaction: ThreadCompaction | null): string {
  if (compaction === null) return LEVEL_LABEL.summary
  const label = LEVEL_LABEL[levelOf(compaction)]
  const { tokensBefore, tokensAfter } = compaction
  if (tokensBefore === null || tokensAfter === null) return label
  return `${label}（${formatCompactTokens(tokensBefore)} → ~${formatCompactTokens(tokensAfter)} tokens）`
}

export function CompactionMarker({
  compaction,
  compacting
}: CompactionMarkerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (compaction === null && !compacting) return null

  const expanded = compaction !== null && open
  const level = compaction === null ? 'summary' : levelOf(compaction)
  // 有摘要可看的只有摘要档；机械档展开的是"这次是怎么省的"
  const summary = level === 'summary'

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
            {expanded ? (summary ? '收起摘要' : '收起详情') : summary ? '查看摘要' : '查看详情'}
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
              {LEVEL_DONE[level]} {compaction.summarized} 条消息 · 保留最近 {compaction.kept} 条 ·{' '}
              {localTime(compaction.createdAt)}
            </p>
          </div>
        </TraceFold>
      )}
    </div>
  )
}
