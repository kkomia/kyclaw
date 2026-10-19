import { useState } from 'react'
import type { KernelQuestionAnswer } from '@shared/kernel-interactions'
import { Button } from '@renderer/components/ui/button'
import { TextPart } from '../parts/TextPart'
import type { PlanReview } from './plan-review'

/**
 * PB-044：DSH `exit_plan_mode` 的计划评审卡。
 *
 * 正文 = 内核问题 `detail`（完整 plan Markdown），不是旧 `SessionPlan.body`，也不读 tool call 的参数；
 * 按钮 = 问题自带的 Approve / Keep planning 两个 option（回包 selected 必须用原始 label）。
 * Keep planning 可带 feedback（写 `custom`，内核把它回给模型继续规划）。
 * 只读复用 PB-026 的 KernelInteractionDock/respond 通道，不另起一套审批。
 */
export interface PlanReviewCardProps {
  review: PlanReview
  submitting: boolean
  onSubmit: (answers: readonly KernelQuestionAnswer[]) => void
}

export function PlanReviewCard({
  review,
  submitting,
  onSubmit
}: PlanReviewCardProps): React.JSX.Element {
  const [feedback, setFeedback] = useState('')
  const [keepFeedback, setKeepFeedback] = useState(false)
  const submitApprove = (): void => {
    onSubmit([{ id: review.questionId, selected: [review.approveLabel] }])
  }
  const submitKeep = (): void => {
    const custom = feedback.trim()
    onSubmit([
      {
        id: review.questionId,
        selected: [review.keepPlanningLabel],
        ...(custom === '' ? {} : { custom })
      }
    ])
  }
  return (
    <section
      data-testid="plan-review-card"
      aria-label="计划评审"
      className="flex flex-col gap-2 rounded-panel border-(length:--hairline-width) border-hairline bg-(--bg-primary) px-3 py-2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-b2 font-medium text-ink">计划评审</p>
        <p className="text-c2 text-ink-tertiary">Approve / Keep planning</p>
      </div>
      {keepFeedback ? (
        <label className="flex flex-col gap-1 text-c1 text-ink-secondary">
          反馈（可选，告诉模型怎么改）
          <textarea
            data-testid="plan-review-feedback"
            value={feedback}
            disabled={submitting}
            onChange={(event) => setFeedback(event.target.value)}
            rows={2}
            className="min-h-0 resize-y rounded-control border-(length:--hairline-width) border-hairline bg-surface px-2 py-1 text-c1 text-ink outline-none focus-visible:border-ink"
          />
        </label>
      ) : null}
      {/* 动作放在正文上方：长计划也不会把 Approve / Keep planning 顶到滚动区外 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-testid="plan-review-approve"
          disabled={submitting}
          onClick={submitApprove}
        >
          {review.approveLabel}
        </Button>
        {keepFeedback ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="plan-review-keep-submit"
            disabled={submitting}
            onClick={submitKeep}
          >
            {review.keepPlanningLabel}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            data-testid="plan-review-keep"
            disabled={submitting}
            onClick={() => setKeepFeedback(true)}
          >
            {review.keepPlanningLabel}
          </Button>
        )}
        {submitting ? <span className="text-c2 text-ink-tertiary">提交中…</span> : null}
      </div>
      <div
        data-testid="plan-review-markdown"
        className="max-h-[min(30vh,18rem)] min-w-0 overflow-y-auto overscroll-contain rounded-control border-(length:--hairline-width) border-hairline bg-surface px-3 py-2 text-c1"
      >
        <TextPart text={review.detail} />
      </div>
    </section>
  )
}
