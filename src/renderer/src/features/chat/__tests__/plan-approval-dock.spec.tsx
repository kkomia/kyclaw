import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionPlan } from '@shared/plan'
import { PlanApprovalDock, type PlanApprovalDockProps } from '../PlanApprovalDock'

const state: SessionPlan = {
  threadId: 't',
  version: 3,
  mode: 'awaiting_approval',
  planId: 'p',
  revision: 2,
  body: '# 完整计划\n\n**先阅读**\n\n- 最后一项',
  feedback: null,
  approval: null,
  updatedAt: new Date().toISOString()
}
function props(overrides: Partial<PlanApprovalDockProps> = {}): PlanApprovalDockProps {
  return {
    state,
    planRef: { planId: 'p', revision: 2, version: 3 },
    feedback: '',
    onFeedbackChange: vi.fn(),
    onApprove: vi.fn(async () => {}),
    onRevise: vi.fn(async () => {}),
    onCancel: vi.fn(async () => {}),
    ...overrides
  }
}
describe('PlanApprovalDock', () => {
  it('默认只铺摘要（版本 + 正文首行），点开才渲染完整 Markdown 与有界键盘滚动区；从不自动批准', () => {
    const input = props()
    render(<PlanApprovalDock {...input} />)
    expect(screen.getByText(/计划版本 2/)).toBeInTheDocument()
    expect(screen.getByText(/状态版本 3/)).toBeInTheDocument()
    expect(screen.getByTestId('plan-approval-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('plan-approval-toggle')).toHaveTextContent('完整计划')
    expect(screen.queryByRole('heading', { name: '完整计划' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '计划正文与反馈' })).not.toBeInTheDocument()
    expect(screen.getByText(/批准计划不等于允许所有文件操作/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '计划审批' }).className).toContain(
      'max-h-[min(36vh,22rem)]'
    )
    // 展开时整卡换高一档上限：正文 + 反馈框 + 底部动作行都要落在卡里（动作行不能被裁掉）
    fireEvent.click(screen.getByTestId('plan-approval-toggle'))
    expect(screen.getByRole('region', { name: '计划审批' }).className).toContain(
      'max-h-[min(52vh,32rem)]'
    )
    expect(screen.getByRole('button', { name: '批准此计划' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('plan-approval-toggle'))
    expect(input.onApprove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('plan-approval-toggle'))
    expect(screen.getByTestId('plan-approval-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('heading', { name: '完整计划' })).toBeInTheDocument()
    expect(screen.getByText('最后一项')).toBeInTheDocument()
    const region = screen.getByRole('region', { name: '计划正文与反馈' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region.className).toContain('overflow-y-auto')
    // 再点一次收起：内容留在 DOM（收合不硬切），但出去可访问树（aria-hidden）
    fireEvent.click(screen.getByTestId('plan-approval-toggle'))
    expect(screen.queryByRole('region', { name: '计划正文与反馈' })).not.toBeInTheDocument()
  })
  it('修订反馈必填：收起时点「修改计划」先展开并把焦点送到输入框，写了才提交', () => {
    const input = props()
    const { rerender } = render(<PlanApprovalDock {...input} />)
    expect(screen.getByRole('button', { name: '修改计划' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '修改计划' }))
    expect(input.onRevise).not.toHaveBeenCalled()
    const box = screen.getByLabelText('修改反馈（修改计划时必填）')
    expect(box).toHaveFocus()
    fireEvent.change(box, { target: { value: '范围更小' } })
    expect(input.onFeedbackChange).toHaveBeenCalledWith('范围更小')
    rerender(<PlanApprovalDock {...input} feedback="范围更小" />)
    fireEvent.click(screen.getByRole('button', { name: '修改计划' }))
    expect(input.onRevise).toHaveBeenCalledWith('t', input.planRef, '范围更小')
  })
  it('批准保持受控、可重试且不乐观切执行态', () => {
    const input = props()
    render(<PlanApprovalDock {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '批准此计划' }))
    fireEvent.click(screen.getByRole('button', { name: '批准此计划' }))
    expect(input.onApprove).toHaveBeenCalledTimes(1)
    expect(input.onApprove).toHaveBeenCalledWith('t', input.planRef)
    expect(screen.getByRole('button', { name: '批准此计划' })).toBeDisabled()
  })
  it('过期引用与 busy 都不能提交；修订/取消带服务端引用', () => {
    const input = props({ feedback: '请调整' })
    const { rerender } = render(
      <PlanApprovalDock {...input} planRef={{ planId: 'p', revision: 1, version: 1 }} />
    )
    expect(screen.getByRole('button', { name: '批准此计划' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('计划版本已变化')
    rerender(<PlanApprovalDock {...input} busy />)
    expect(screen.getByRole('button', { name: '停止本轮' })).toBeDisabled()
    rerender(<PlanApprovalDock {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '修改计划' }))
    expect(input.onRevise).toHaveBeenCalledWith('t', input.planRef, '请调整')
    rerender(
      <PlanApprovalDock
        {...input}
        state={{ ...state, version: 4, mode: 'planning' }}
        planRef={{ ...input.planRef!, version: 4 }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '停止本轮' }))
    expect(input.onCancel).toHaveBeenCalledWith('t', 4)
  })
  it('已批准待继续 / 执行中 / 已取消各按真实状态给动作，不给不该给的操作', () => {
    const input = props({ state: { ...state, approval: { runId: 'r', toolCallId: 'c' } } })
    const { rerender } = render(<PlanApprovalDock {...input} />)
    expect(screen.getByRole('button', { name: '已批准，待继续' })).toBeDisabled()
    expect(input.onApprove).not.toHaveBeenCalled()
    rerender(<PlanApprovalDock {...input} state={{ ...input.state!, mode: 'executing' }} />)
    expect(screen.queryByRole('button', { name: '批准此计划' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '修改计划' })).not.toBeInTheDocument()
    rerender(<PlanApprovalDock {...input} state={{ ...state, mode: 'cancelled' }} />)
    // 摘要把手还在（那是"看计划"的唯一入口），但没有任何待处理动作
    expect(screen.getByTestId('plan-approval-toggle')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '批准此计划' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '修改计划' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '停止本轮' })).not.toBeInTheDocument()
  })
  it.each([
    ['批准此计划', 'onApprove', 'sync'],
    ['批准此计划', 'onApprove', 'async'],
    ['修改计划', 'onRevise', 'sync'],
    ['修改计划', 'onRevise', 'async'],
    ['停止本轮', 'onCancel', 'sync'],
    ['停止本轮', 'onCancel', 'async']
  ] as const)('%s unlocks repeated identical %s %s failures', async (label, action, kind) => {
    const failure = vi.fn((): Promise<void> => {
      if (kind === 'sync') throw new Error('相同失败')
      return Promise.reject(new Error('相同失败'))
    })
    const input = props({ feedback: '请调整', error: '相同失败', [action]: failure })
    render(<PlanApprovalDock {...input} />)
    for (let attempt = 1; attempt <= 2; attempt++) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled())
      expect(screen.getByRole('alert')).toHaveTextContent('相同失败')
      expect(failure).toHaveBeenCalledTimes(attempt)
    }
  })
})
