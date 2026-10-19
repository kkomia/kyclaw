import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanReviewCard } from '../PlanReviewCard'

/**
 * PB-044：计划评审卡两分支。
 * Approve → selected=[Approve]；Keep planning → selected=[Keep planning] + custom feedback（可空）。
 * 正文走 Markdown（TextPart），不是原始 JSON。
 */
const review = {
  questionId: 'plan-review',
  detail: '# 三步计划\n\n1. 读配置\n2. 探针\n3. 截图',
  approveLabel: 'Approve',
  keepPlanningLabel: 'Keep planning'
}

describe('PB-044 PlanReviewCard', () => {
  it('渲染 plan Markdown 与两个内核 label；不把原始 JSON 糊进正文', () => {
    const { container } = render(
      <PlanReviewCard review={review} submitting={false} onSubmit={vi.fn()} />
    )
    expect(screen.getByTestId('plan-review-card')).toBeInTheDocument()
    expect(screen.getByTestId('plan-review-markdown')).toHaveTextContent('三步计划')
    expect(screen.getByTestId('plan-review-markdown')).toHaveTextContent('读配置')
    expect(screen.getByTestId('plan-review-approve')).toHaveTextContent('Approve')
    expect(screen.getByTestId('plan-review-keep')).toHaveTextContent('Keep planning')
    expect(container.textContent ?? '').not.toContain('"questionId"')
  })

  it('Approve：回包 selected=[原 label]，不带 custom', () => {
    const onSubmit = vi.fn()
    render(<PlanReviewCard review={review} submitting={false} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByTestId('plan-review-approve'))
    expect(onSubmit).toHaveBeenCalledWith([{ id: 'plan-review', selected: ['Approve'] }])
  })

  it('Keep planning：先展开反馈框；提交带 custom feedback', () => {
    const onSubmit = vi.fn()
    render(<PlanReviewCard review={review} submitting={false} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByTestId('plan-review-keep'))
    const feedback = screen.getByTestId('plan-review-feedback')
    fireEvent.change(feedback, { target: { value: '范围再小一点' } })
    fireEvent.click(screen.getByTestId('plan-review-keep-submit'))
    expect(onSubmit).toHaveBeenCalledWith([
      { id: 'plan-review', selected: ['Keep planning'], custom: '范围再小一点' }
    ])
  })

  it('Keep planning 空反馈：不带 custom（不伪造反馈）', () => {
    const onSubmit = vi.fn()
    render(<PlanReviewCard review={review} submitting={false} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByTestId('plan-review-keep'))
    fireEvent.click(screen.getByTestId('plan-review-keep-submit'))
    expect(onSubmit).toHaveBeenCalledWith([{ id: 'plan-review', selected: ['Keep planning'] }])
  })

  it('提交中两个动作都禁用', () => {
    render(<PlanReviewCard review={review} submitting onSubmit={vi.fn()} />)
    expect(screen.getByTestId('plan-review-approve')).toBeDisabled()
    expect(screen.getByTestId('plan-review-keep')).toBeDisabled()
  })
})
