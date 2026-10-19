import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KernelInteractionSnapshot } from '@shared/kernel-interactions'
import { KernelInteractionDock } from '../KernelInteractionDock'

/**
 * PB-026：挂起 dock 的交互契约。
 *   - 审批只有「允许一次 / 拒绝」两个用户动作；asked 来源只读，不放假按钮；
 *   - 提问选选项/自定义后提交 answers；continued 只读 + 明确提示（无写路由）；
 *   - 不渲染任何 unavailable/cancelled 按钮。
 */
function snapshot(overrides: Partial<KernelInteractionSnapshot> = {}): KernelInteractionSnapshot {
  return {
    threadId: 'thread-1',
    approvals: { pending: [], results: [] },
    askUser: { active: [], settled: [], timed: false },
    questions: { pending: [] },
    ...overrides
  }
}

function renderDock(
  snap: KernelInteractionSnapshot,
  overrides: Partial<Parameters<typeof KernelInteractionDock>[0]> = {}
): {
  onRespondApproval: ReturnType<typeof vi.fn>
  onRespondQuestion: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onRespondApproval = vi.fn()
  const onRespondQuestion = vi.fn()
  const { container } = render(
    <KernelInteractionDock
      snapshot={snap}
      error={null}
      notice={null}
      submittingEventId={null}
      onRespondApproval={onRespondApproval}
      onRespondQuestion={onRespondQuestion}
      {...overrides}
    />
  )
  return { onRespondApproval, onRespondQuestion, container }
}

describe('PB-026 KernelInteractionDock：审批', () => {
  it('waterfall 审批：允许一次 / 拒绝只发两个用户动作', () => {
    const { onRespondApproval } = renderDock(
      snapshot({
        approvals: {
          pending: [
            {
              threadId: 'thread-1',
              id: 'evt-a',
              source: 'waterfall',
              respondable: true,
              toolName: 'write',
              reason: '要写文件'
            }
          ],
          results: []
        }
      })
    )
    expect(screen.getByTestId('kernel-approval-card')).toHaveTextContent('write')
    expect(screen.getByTestId('kernel-approval-card')).toHaveTextContent('要写文件')
    fireEvent.click(screen.getByTestId('kernel-approval-allow'))
    expect(onRespondApproval).toHaveBeenCalledWith('evt-a', 'allowed-once')
    fireEvent.click(screen.getByTestId('kernel-approval-reject'))
    expect(onRespondApproval).toHaveBeenCalledWith('evt-a', 'rejected')
    expect(screen.queryByText('unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
  })

  it('asked 来源：只读提示，没有按钮（无写通道不作假）', () => {
    renderDock(
      snapshot({
        approvals: {
          pending: [
            {
              threadId: 'thread-1',
              id: 'evt-asked',
              source: 'asked',
              respondable: false,
              toolName: 'bash'
            }
          ],
          results: []
        }
      })
    )
    expect(screen.getByTestId('kernel-approval-readonly')).toHaveTextContent('暂不能应答')
    expect(screen.queryByTestId('kernel-approval-allow')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kernel-approval-reject')).not.toBeInTheDocument()
  })

  it('真实链路 asked+waterfall 两条：只出一张可操作卡 + 一条审计只读行（不双卡）', () => {
    const { container } = renderDock(
      snapshot({
        approvals: {
          pending: [
            {
              threadId: 'thread-1',
              id: 'evt-audit',
              source: 'asked',
              respondable: false,
              toolName: 'write'
            },
            {
              threadId: 'thread-1',
              id: 'evt-action',
              source: 'waterfall',
              respondable: true,
              toolName: 'write'
            }
          ],
          results: []
        }
      })
    )
    expect(container.querySelectorAll('[data-testid=kernel-approval-card]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-testid=kernel-approval-allow]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid=kernel-approval-readonly]')).toHaveLength(1)
  })

  it('respondable 字段缺失（契约未到位）→ 不渲染审批卡，绝不按 source 猜', () => {
    const { container } = renderDock(
      snapshot({
        approvals: {
          pending: [{ threadId: 'thread-1', id: 'evt-a', source: 'waterfall', toolName: 'write' }],
          results: []
        }
      })
    )
    expect(container.querySelector('[data-testid=kernel-interaction-dock]')).toBeNull()
  })

  it('提交中禁用两个按钮', () => {
    renderDock(
      snapshot({
        approvals: {
          pending: [
            {
              threadId: 'thread-1',
              id: 'evt-a',
              source: 'waterfall',
              respondable: true,
              toolName: 'write'
            }
          ],
          results: []
        }
      }),
      { submittingEventId: 'evt-a' }
    )
    expect(screen.getByTestId('kernel-approval-allow')).toBeDisabled()
    expect(screen.getByTestId('kernel-approval-reject')).toBeDisabled()
    expect(screen.getByText('提交中…')).toBeInTheDocument()
  })
})

describe('PB-026 KernelInteractionDock：提问', () => {
  it('单选选项 → 提交 answers；未选不可提交', () => {
    const { onRespondQuestion } = renderDock(
      snapshot({
        questions: {
          pending: [
            {
              threadId: 'thread-1',
              eventId: 'evt-q',
              suspendedAt: new Date().toISOString(),
              questions: [
                {
                  id: 'q1',
                  question: '选哪个？',
                  options: [{ label: 'A' }, { label: 'B' }],
                  multiSelect: false
                }
              ]
            }
          ]
        }
      })
    )
    expect(screen.getByTestId('kernel-question-submit')).toBeDisabled()
    fireEvent.click(screen.getAllByTestId('kernel-question-option')[0] as HTMLElement)
    expect(screen.getByTestId('kernel-question-submit')).toBeEnabled()
    fireEvent.click(screen.getByTestId('kernel-question-submit'))
    expect(onRespondQuestion).toHaveBeenCalledWith('evt-q', [{ id: 'q1', selected: ['A'] }])
  })

  it('多选 + 自定义文本都进 answers.custom', () => {
    const { onRespondQuestion } = renderDock(
      snapshot({
        questions: {
          pending: [
            {
              threadId: 'thread-1',
              eventId: 'evt-q2',
              suspendedAt: new Date().toISOString(),
              questions: [
                {
                  id: 'q2',
                  question: '多选',
                  options: [{ label: 'A' }, { label: 'B' }],
                  multiSelect: true
                }
              ]
            }
          ]
        }
      })
    )
    fireEvent.click(screen.getAllByTestId('kernel-question-option')[0] as HTMLElement)
    fireEvent.click(screen.getAllByTestId('kernel-question-option')[1] as HTMLElement)
    fireEvent.change(screen.getByTestId('kernel-question-custom'), {
      target: { value: '其它答案' }
    })
    fireEvent.click(screen.getByTestId('kernel-question-submit'))
    expect(onRespondQuestion).toHaveBeenCalledWith('evt-q2', [
      { id: 'q2', selected: ['A', 'B'], custom: '其它答案' }
    ])
  })
})

describe('PB-026 KernelInteractionDock：continued / 空态', () => {
  it('continued 只读：有明确提示、无任何提交按钮', () => {
    const { container } = renderDock(
      snapshot({
        askUser: {
          active: [
            { callId: 'call-1', state: 'continued', questions: [{ id: 'q', question: '还答吗？' }] }
          ],
          settled: [],
          timed: true
        }
      })
    )
    expect(container.querySelector('[data-testid=kernel-askuser-continued]')).toHaveTextContent(
      '当前界面暂不支持补答'
    )
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('无挂起/无错误 → 不渲染 dock', () => {
    const { container } = renderDock(snapshot())
    expect(container.querySelector('[data-testid=kernel-interaction-dock]')).toBeNull()
  })
})
