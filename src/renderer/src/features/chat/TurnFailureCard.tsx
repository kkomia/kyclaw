import { AlertTriangle, CircleSlash } from 'lucide-react'
import type { TurnFailure } from '@shared/turn-failure'
import { turnFailureCode, turnFailureDetail, turnFailureTitle } from './turn-failure'

/**
 * PB-037：失败轮错误卡（**消息流内**，贴在失败轮那条 user message 下）。
 *
 * 与 `ErrorCard` 同一套视觉 token（danger 左线、panel 边框、b2/c1 字号），但**不复用组件**：
 * `ErrorCard` 绑 `onRetry` 和「清空/保留」语义，而历史失败轮 v1 **只读**（重试仍由 dock 错误卡
 * 在当前失败轮提供）；`aborted` / `interrupted` 也不是「这一轮没有完成」，只显示「已中断」。
 *
 * 红线：不把 metadata 的原始 JSON 糊进正文；code/message 只按人话字段展示。
 */
export function TurnFailureCard({ failure }: { failure: TurnFailure }): React.JSX.Element {
  const title = turnFailureTitle(failure)
  const detail = turnFailureDetail(failure)
  const code = turnFailureCode(failure)
  const Icon = failure.kind === 'error' ? AlertTriangle : CircleSlash
  return (
    <div
      data-testid="turn-failure-card"
      data-kind={failure.kind}
      data-turn={failure.turn}
      role="alert"
      className="animate-fade-in flex w-full min-w-0 flex-col gap-1 rounded-panel border-(length:--hairline-width) border-hairline border-l-2 border-l-danger bg-(--bg-primary) px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-2 font-sans text-b2 font-semibold text-ink">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <span data-testid="turn-failure-title" className="min-w-0">
          {title}
        </span>
      </div>
      {detail === null ? null : (
        <p
          data-testid="turn-failure-message"
          className="min-w-0 break-words text-c1 text-ink-secondary"
        >
          {detail}
        </p>
      )}
      {code === null ? null : (
        <p
          data-testid="turn-failure-code"
          className="font-mono text-c2 break-all text-ink-tertiary"
        >
          {code}
        </p>
      )}
    </div>
  )
}
