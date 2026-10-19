import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KernelInteractionResults } from '../KernelInteractionResults'

/**
 * PB-026：结果进消息流（不是 dock）；服务端 copy 优先、不出现假「重新发起/补答」按钮。
 */
describe('PB-026 KernelInteractionResults', () => {
  it('审批结果用服务端 copy；systemInitiated 不归因用户；无假按钮', () => {
    const { container } = render(
      <KernelInteractionResults
        results={[
          {
            threadId: 't',
            id: 'evt-a',
            matchedBy: 'id',
            toolName: 'write',
            outcome: 'unavailable',
            copy: {
              title: '系统自动拒绝了',
              detail: '这不是你点的。',
              attribution: 'system',
              canRetry: true
            },
            systemInitiated: true
          }
        ]}
        settled={[]}
      />
    )
    expect(container.querySelector('[data-testid=kernel-approval-result]')).toHaveTextContent(
      '系统自动拒绝了'
    )
    expect(container.textContent ?? '').not.toContain('你拒绝')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('提问 settled → 已回答行（答案摘要，无按钮）', () => {
    const { container } = render(
      <KernelInteractionResults
        results={[]}
        settled={[
          {
            callId: 'call-q',
            answers: [
              { id: 'q1', selected: ['A', 'B'] },
              { id: 'q2', selected: [], custom: '其它' }
            ]
          }
        ]}
      />
    )
    const row = container.querySelector('[data-testid=kernel-askuser-result]')
    expect(row).toHaveTextContent('已回答')
    expect(row).toHaveTextContent('A / B')
    expect(row).toHaveTextContent('其它')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('空结果不渲染', () => {
    const { container } = render(<KernelInteractionResults results={[]} settled={[]} />)
    expect(container.querySelector('[data-testid=kernel-interaction-results]')).toBeNull()
  })
})
