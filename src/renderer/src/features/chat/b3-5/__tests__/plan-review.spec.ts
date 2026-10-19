import { describe, expect, it } from 'vitest'
import type { KernelPendingQuestion, KernelQuestionItem } from '@shared/kernel-interactions'
import { planReviewOf, planReviewOfPending } from '../plan-review'

/**
 * PB-044：plan-review 只认内核 `exit_plan_mode` 的显式意图 + detail + 两个 option。
 * 缺失/坏形状 → null（落回通用问题卡，不伪造计划正文/按钮）。
 */
const PLAN = '# 三步计划\n\n1. 读配置\n2. 探针\n3. 截图'

function item(overrides: Partial<KernelQuestionItem> = {}): KernelQuestionItem {
  return {
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    header: 'Plan review',
    detail: PLAN,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-1' },
    ...overrides
  }
}

describe('PB-044 planReviewOf', () => {
  it('正常形状：detail/approve/keep 从问题字段收出（不改 label）', () => {
    expect(planReviewOf(item())).toEqual({
      questionId: 'plan-review',
      detail: PLAN,
      approveLabel: 'Approve',
      keepPlanningLabel: 'Keep planning'
    })
  })

  it('intent 缺失 / kind 不是 plan-review → null（不按 header 猜）', () => {
    expect(planReviewOf(item({ intent: undefined }))).toBeNull()
    expect(planReviewOf(item({ intent: { kind: 'other' } }))).toBeNull()
  })

  it('detail 缺失/空白 → null（没有正文就不出计划卡）', () => {
    expect(planReviewOf(item({ detail: undefined }))).toBeNull()
    expect(planReviewOf(item({ detail: '  ' }))).toBeNull()
  })

  it('缺 Keep planning option → null（不伪造第二个按钮）', () => {
    expect(planReviewOf(item({ options: [{ label: 'Approve' }] }))).toBeNull()
  })

  it('approve label 来自 intent；多问题不猜 → null', () => {
    const review = planReviewOf(
      item({
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' }
      })
    )
    expect(review?.approveLabel).toBe('Approve')
    const pending: KernelPendingQuestion = {
      threadId: 't',
      eventId: 'e',
      suspendedAt: new Date().toISOString(),
      questions: [item(), item({ id: 'other' })]
    }
    expect(planReviewOfPending(pending)).toBeNull()
  })
})
