import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionPlan } from '@shared/plan'
import { PlanModeChip } from '../PlanModeChip'

const normal: SessionPlan = {
  threadId: 't',
  version: 3,
  mode: 'normal',
  planId: null,
  revision: 0,
  body: null,
  feedback: null,
  approval: null,
  updatedAt: new Date().toISOString()
}

describe('PlanModeChip', () => {
  it('普通模式与未读到状态都不铺常驻件（入口在 ＋ 菜单里，不在这里）', () => {
    const { rerender, container } = render(<PlanModeChip state={normal} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('plan-mode-chip')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    rerender(<PlanModeChip state={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['planning', '规划中'],
    ['executing', '执行中'],
    ['cancelled', '已取消']
  ] as const)('%s 只说真状态 %s（不伪造进度）', (mode, label) => {
    render(<PlanModeChip state={{ ...normal, mode }} />)
    expect(screen.getByTestId('plan-mode-chip')).toHaveTextContent(label)
    expect(screen.getByRole('status')).toHaveTextContent(label)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('等待批准与已批准待继续都按真实状态说，且这里不给任何动作按钮', () => {
    const { rerender } = render(<PlanModeChip state={{ ...normal, mode: 'awaiting_approval' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('等待批准')
    rerender(
      <PlanModeChip
        state={{ ...normal, mode: 'awaiting_approval', approval: { runId: 'r', toolCallId: 'c' } }}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('已批准，待继续')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
