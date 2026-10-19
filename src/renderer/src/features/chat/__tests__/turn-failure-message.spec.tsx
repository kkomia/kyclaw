import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '../Message'

/**
 * PB-037：失败卡贴在失败轮 user message 的 DOM 里（消息流内），而不是页脚。
 * 有 metadata → 卡片出现；无/坏 metadata → 不出现；aborted/interrupted 只显示「已中断」。
 */
function userMessage(metadata?: Record<string, unknown>): UIMessage {
  return {
    id: 'u-failed',
    role: 'user',
    parts: [{ type: 'text', text: '失败那轮的输入' }],
    ...(metadata === undefined ? {} : { metadata })
  } as UIMessage
}

describe('PB-037 Message：失败轮错误卡', () => {
  it('有 turnFailure：卡片渲染在该条 user message 内部，正文仍在', () => {
    const { container } = render(
      <Message
        message={userMessage({
          turnFailure: { turn: 2, kind: 'error', code: 'E1', message: '失败了' }
        })}
      />
    )
    const article = container.querySelector('[data-testid=message-u-failed]')
    expect(article).toHaveTextContent('失败那轮的输入')
    expect(article?.querySelector('[data-testid=turn-failure-card]')).not.toBeNull()
    expect(screen.getByTestId('turn-failure-message')).toHaveTextContent('失败了')
  })

  it('无 metadata / 坏 metadata：不渲染卡片（不猜）', () => {
    const first = render(<Message message={userMessage()} />)
    expect(first.container.querySelector('[data-testid=turn-failure-card]')).toBeNull()
    first.unmount()
    const second = render(
      <Message message={userMessage({ turnFailure: { kind: 'completed', turn: 1 } })} />
    )
    expect(second.container.querySelector('[data-testid=turn-failure-card]')).toBeNull()
  })

  it('aborted：只有「已中断」，不出现失败/重试', () => {
    const { container } = render(
      <Message message={userMessage({ turnFailure: { turn: 2, kind: 'aborted' } })} />
    )
    expect(screen.getByTestId('turn-failure-title')).toHaveTextContent('已中断')
    expect(container.textContent ?? '').not.toContain('这一轮没有完成')
    expect(container.textContent ?? '').not.toContain('重试')
  })
})
