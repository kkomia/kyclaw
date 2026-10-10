import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Skeleton } from '../skeleton'

describe('Skeleton', () => {
  it('底座用 Fills-F2 + shimmer 动画（§6.6 的 shimmer 关键帧）', () => {
    render(<Skeleton data-testid="skeleton" />)

    expect(screen.getByTestId('skeleton')).toHaveClass('shimmer', 'bg-(--skeleton-base)')
  })

  it('装饰性：不进无障碍树（等真内容加载出来）', () => {
    render(<Skeleton data-testid="skeleton" />)

    expect(screen.getByTestId('skeleton')).toHaveAttribute('aria-hidden', 'true')
  })

  it('尺寸与圆角交给调用方（默认 4px 圆角，className 可覆盖）', () => {
    render(<Skeleton data-testid="line" className="h-4 w-32" />)

    const line = screen.getByTestId('line')
    expect(line).toHaveClass('h-4', 'w-32', 'rounded-badge')
  })

  it('覆盖圆角时不留旧档（tailwind-merge）', () => {
    render(<Skeleton data-testid="circle" className="size-8 rounded-pill" />)

    expect(screen.getByTestId('circle')).toHaveClass('rounded-pill')
    expect(screen.getByTestId('circle')).not.toHaveClass('rounded-badge')
  })
})
