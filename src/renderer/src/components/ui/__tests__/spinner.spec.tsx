import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Spinner } from '../spinner'

describe('Spinner', () => {
  it('1s linear 常速的环形（§6.5 spinner 统一档）+ 1.5px 描边（§5.3）', () => {
    render(<Spinner />)

    expect(screen.getByRole('status')).toHaveClass(
      'animate-spin',
      'rounded-pill',
      'border-(length:--spinner-stroke)',
      'border-t-current'
    )
  })

  it.each([
    ['sm', 'size-(--icon-size-sm)'],
    ['md', 'size-(--icon-size-md)'],
    ['lg', 'size-(--icon-size-lg)']
  ] as const)('尺寸档 %s → %s（§4.7 的 16/18/20）', (size, sizeClass) => {
    render(<Spinner size={size} />)

    expect(screen.getByRole('status')).toHaveClass(sizeClass)
  })

  it('默认是可朗读的 status（自带"加载中"），label 可改', () => {
    const { rerender } = render(<Spinner />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '加载中')

    rerender(<Spinner label="正在生成" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '正在生成')
  })

  it('decorative：不进无障碍树（放进已有 aria-busy 的按钮时用）', () => {
    render(<Spinner decorative data-testid="decorative" />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    const spinner = screen.getByTestId('decorative')
    expect(spinner).toHaveAttribute('aria-hidden', 'true')
    expect(spinner).not.toHaveAttribute('aria-label')
  })
})
