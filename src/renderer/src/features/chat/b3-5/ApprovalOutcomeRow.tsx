import { useState } from 'react'
import type { ApprovalOutcomeView } from './approval-outcome'

/**
 * B3.5 审批结果行（消息流里的紧凑结果；dock 只放等待态）。
 * `role="status" aria-live="polite"`：结果出现不打断读屏。
 * `unavailable` 有「重新发起」+「查看详情」；其它结束态把原因/时间作为一行小字直接展示（可回看）。
 * 不显示技术词（outcome / runId / toolCallId）。
 */
export interface ApprovalOutcomeRowProps {
  view: ApprovalOutcomeView
  onRetry?: () => void
  onDetails?: () => void
}

function formatAt(at: number | undefined): string {
  return at === undefined ? '' : `（${new Date(at).toLocaleString('zh-CN')}）`
}

export function ApprovalOutcomeRow({
  view,
  onRetry,
  onDetails
}: ApprovalOutcomeRowProps): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const tone =
    view.blamesUser || view.outcome === 'unavailable'
      ? 'text-danger'
      : view.outcome === 'allowed-once'
        ? 'text-ink'
        : 'text-ink-tertiary'
  const hasDetails = view.details !== undefined
  const collapsible = view.secondaryLabel !== undefined && hasDetails

  return (
    <div
      data-testid="approval-outcome"
      data-outcome={view.outcome}
      role="status"
      aria-live="polite"
      className="mt-1 flex min-w-0 flex-col gap-1 rounded-control border-(length:--hairline-width) border-hairline bg-(--bg-primary) px-3 py-2"
    >
      <p data-testid="approval-outcome-title" className={`text-b2 font-medium ${tone}`}>
        {view.title}
      </p>
      <p data-testid="approval-outcome-body" className="text-c1 break-words text-ink-secondary">
        {view.body}
      </p>
      {view.primaryLabel === undefined && view.secondaryLabel === undefined ? null : (
        <div className="flex items-center gap-2 pt-1">
          {view.primaryLabel === undefined ? null : (
            <button
              type="button"
              data-testid="approval-outcome-retry"
              className="min-h-[26px] rounded-badge border-(length:--hairline-width) border-hairline px-2 text-c1 text-ink hover:bg-hover"
              onClick={onRetry}
            >
              {view.primaryLabel}
            </button>
          )}
          {view.secondaryLabel === undefined ? null : (
            <button
              type="button"
              data-testid="approval-outcome-details-toggle"
              aria-expanded={collapsible ? detailsOpen : undefined}
              className="min-h-[26px] rounded-badge px-2 text-c1 text-ink-tertiary hover:bg-hover"
              onClick={() => {
                onDetails?.()
                setDetailsOpen((open) => !open)
              }}
            >
              {view.secondaryLabel}
            </button>
          )}
        </div>
      )}
      {hasDetails && (!collapsible || detailsOpen) ? (
        <p data-testid="approval-outcome-cause" className="text-c1 break-words text-ink-tertiary">
          {view.details?.cause ?? '内核没有提供更多信息。'}
          {formatAt(view.details?.at)}
        </p>
      ) : null}
    </div>
  )
}
