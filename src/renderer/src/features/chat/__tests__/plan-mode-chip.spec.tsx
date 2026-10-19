import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanModeChip } from '../PlanModeChip'

/**
 * PB-041：规划状态只读内核投影；旧 plans 状态机下架后，这里不再有 SessionPlan 分支。
 * 两种合法内核形态都算「规划中」（kernelPlanActive 单判据），其余不铺常驻件。
 */
describe('PlanModeChip', () => {
  it('无投影 / 非规划：不铺常驻件、没有按钮', () => {
    const { rerender, container } = render(<PlanModeChip kernelPlan={null} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<PlanModeChip kernelPlan={{ active: false, pending: false }} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    ['active', { active: true, pending: false }],
    ['pending', { active: false, pending: true }]
  ] as const)('内核投影 %s 都只说「规划中」（不伪造进度）', (_kind, plan) => {
    render(<PlanModeChip kernelPlan={plan} />)
    expect(screen.getByTestId('plan-mode-chip')).toHaveTextContent('规划中')
    expect(screen.getByRole('status')).toHaveTextContent('规划中')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
