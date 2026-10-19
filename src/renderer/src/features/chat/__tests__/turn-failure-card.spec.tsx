import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TurnFailureCard } from '../TurnFailureCard'

/**
 * PB-037：消息内失败卡的三种 kind 文案与红线。
 * - error：显示 code/message；不把原始 JSON 糊进正文；没有重试按钮（历史失败轮 v1 只读）。
 * - aborted / interrupted：只显示「已中断」，绝不允许出现「这一轮没有完成」或重试文案。
 */
describe('PB-037 TurnFailureCard', () => {
  it('error：标题 + 人话原因 + code；无重试按钮、无原始 JSON', () => {
    const { container } = render(
      <TurnFailureCard
        failure={{ turn: 2, kind: 'error', code: 'E_RATE', message: '服务限流，请稍后重试' }}
      />
    )
    expect(screen.getByTestId('turn-failure-card')).toHaveAttribute('data-kind', 'error')
    expect(screen.getByTestId('turn-failure-title')).toHaveTextContent('这一轮没有完成')
    expect(screen.getByTestId('turn-failure-message')).toHaveTextContent('服务限流，请稍后重试')
    expect(screen.getByTestId('turn-failure-code')).toHaveTextContent('E_RATE')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.textContent ?? '').not.toContain('"turn"')
    expect(container.textContent ?? '').not.toContain('turnFailure')
  })

  it('error 只有 code：原因用 code，不出现空原因', () => {
    render(<TurnFailureCard failure={{ turn: 1, kind: 'error', code: 'E_ONLY' }} />)
    expect(screen.getByTestId('turn-failure-message')).toHaveTextContent('E_ONLY')
    expect(screen.queryByTestId('turn-failure-code')).not.toBeInTheDocument()
  })

  it('aborted：只显示「已中断」，没有失败/重试文案', () => {
    const { container } = render(
      <TurnFailureCard
        failure={{ turn: 2, kind: 'aborted', code: 'ABORTED', message: '连接断了' }}
      />
    )
    expect(screen.getByTestId('turn-failure-title')).toHaveTextContent('已中断')
    expect(container.textContent ?? '').not.toContain('这一轮没有完成')
    expect(container.textContent ?? '').not.toContain('重试')
    expect(container.textContent ?? '').not.toContain('连接断了')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('interrupted：只显示「已中断」，没有失败/重试文案', () => {
    const { container } = render(
      <TurnFailureCard
        failure={{ turn: 2, kind: 'interrupted', code: 'INT', message: '被系统打断' }}
      />
    )
    expect(screen.getByTestId('turn-failure-title')).toHaveTextContent('已中断')
    expect(container.textContent ?? '').not.toContain('这一轮没有完成')
    expect(container.textContent ?? '').not.toContain('重试')
    expect(container.textContent ?? '').not.toContain('被系统打断')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
