import type { AskUserStateView } from './ask-user-state'

/** B3.5 提问侧停靠徽标（等待回答：有倒计时 / 无倒计时两态；dock 卡片保留，不替换） */
export function AskUserPendingBadge({ view }: { view: AskUserStateView }): React.JSX.Element {
  return (
    <span
      data-testid="ask-user-pending-badge"
      data-has-countdown={view.badge?.startsWith('距离超时') === true ? 'true' : undefined}
      className="rounded-badge border-(length:--hairline-width) border-hairline px-1.5 py-0.5 text-c2 text-ink-tertiary"
    >
      {view.badge ?? '等待回答'}
    </span>
  )
}

/** B3.5 提问结果行（消息流：已回答 / 超时后补答 / 无法显示问题；不替换 dock 卡片） */
export function AskUserStateRow({
  view,
  onPrimary
}: {
  view: AskUserStateView
  onPrimary?: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="ask-user-state"
      data-state={view.state}
      role="status"
      aria-live="polite"
      className="mt-1 flex min-w-0 flex-col gap-1 rounded-control border-(length:--hairline-width) border-hairline bg-(--bg-primary) px-3 py-2"
    >
      <p data-testid="ask-user-state-title" className="text-b2 font-medium text-ink">
        {view.title}
      </p>
      {view.body === undefined ? null : (
        <p data-testid="ask-user-state-body" className="text-c1 break-words text-ink-secondary">
          {view.body}
        </p>
      )}
      {view.primaryLabel === undefined ? null : (
        <div className="pt-1">
          <button
            type="button"
            data-testid="ask-user-state-primary"
            className="min-h-[26px] rounded-badge border-(length:--hairline-width) border-hairline px-2 text-c1 text-ink hover:bg-hover"
            onClick={onPrimary}
          >
            {view.primaryLabel}
          </button>
        </div>
      )}
    </div>
  )
}
