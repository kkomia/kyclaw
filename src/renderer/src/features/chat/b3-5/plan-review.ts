import type { KernelPendingQuestion, KernelQuestionItem } from '@shared/kernel-interactions'

/**
 * PB-044：从内核 `userQuestions` 的 plan-review 问题里收出「计划评审卡」所需字段。
 *
 * 来源（rc.2 `dsh-plan-mode/lib/index.js:260-279`）：`exit_plan_mode` 调 `userQuestions.ask` 时
 * 单问题 `id='plan-review'`、`detail=args.plan`（完整 Markdown）、`options` 为 Approve / Keep planning，
 * `intent={kind:'plan-review',approve:...,callId:exec.callId}`。
 *
 * 红线：只认 `intent.kind==='plan-review'` + 非空 detail + 两个不同 option；任何一项缺失/形状不对
 * 返回 null（落回通用问题卡，**不伪造**计划正文/按钮，不猜 label）。
 */
export interface PlanReview {
  questionId: string
  /** 完整 plan Markdown（来自内核问题 detail；非空） */
  detail: string
  /** 批准选项的原始 label（回包必须用原 label） */
  approveLabel: string
  /** Keep planning 选项的原始 label */
  keepPlanningLabel: string
}

export function planReviewOf(question: KernelQuestionItem): PlanReview | null {
  if (question.intent?.kind !== 'plan-review') return null
  const detail = question.detail
  if (typeof detail !== 'string' || detail.trim() === '') return null
  const options = question.options ?? []
  const approveLabel =
    question.intent.approve !== undefined && question.intent.approve.trim() !== ''
      ? question.intent.approve
      : options[0]?.label
  if (approveLabel === undefined || approveLabel.trim() === '') return null
  const keepPlanningLabel = options.find(
    (option) => option.label !== approveLabel && option.label.trim() !== ''
  )?.label
  if (keepPlanningLabel === undefined) return null
  return {
    questionId: question.id,
    detail,
    approveLabel,
    keepPlanningLabel
  }
}

/** 一个阻塞式提问是否整体是计划评审（plan review 只有一个问题；多问题不猜） */
export function planReviewOfPending(question: KernelPendingQuestion): PlanReview | null {
  if (question.questions.length !== 1) return null
  const item = question.questions[0]
  return item === undefined ? null : planReviewOf(item)
}
