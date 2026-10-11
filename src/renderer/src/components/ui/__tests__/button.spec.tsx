import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../button'

describe('Button', () => {
  it('默认 medium + primary：高 32 / 最小宽 62 / 圆角 10 / B2 字号（§4.7 .km-button-medium）', () => {
    render(<Button>确定</Button>)

    expect(screen.getByRole('button', { name: '确定' })).toHaveClass(
      'h-(--control-height-md)',
      'min-w-(--control-min-width-md)',
      'rounded-control',
      'text-b2',
      'gap-1',
      'px-2.5',
      'py-1.5',
      'bg-(--button-primary-bg)',
      'text-(--button-primary-fg)'
    )
  })

  it('sm 档：26 高 / 最小宽 52 / 圆角 8 / C1 字号、间隙 2、内边距 4×8（§4.7）', () => {
    render(<Button size="sm">小</Button>)

    expect(screen.getByRole('button')).toHaveClass(
      'h-(--control-height-sm)',
      'min-w-(--control-min-width-sm)',
      'rounded-button-sm',
      'text-c1',
      'gap-0.5',
      'px-2',
      'py-1'
    )
  })

  it('lg 档：44 高 / 最小宽 72 / 圆角 12 / T2 字号、间隙 6、内边距 10×14（§4.7）', () => {
    render(<Button size="lg">大</Button>)

    expect(screen.getByRole('button')).toHaveClass(
      'h-(--control-height-lg)',
      'min-w-(--control-min-width-lg)',
      'rounded-button-lg',
      'text-t2',
      'gap-1.5',
      'px-3.5',
      'py-2.5'
    )
  })

  it('primary 有 hover/active 明度档，ghost 用填充档且不出墨色底（§7）', () => {
    const { rerender } = render(<Button>主</Button>)

    expect(screen.getByRole('button')).toHaveClass(
      'hover:bg-(--button-primary-bg-hover)',
      'active:bg-(--button-primary-bg-active)'
    )

    rerender(<Button variant="ghost">次</Button>)
    const ghost = screen.getByRole('button')
    expect(ghost).toHaveClass('bg-transparent', 'text-ink', 'hover:bg-hover', 'active:bg-active')
    expect(ghost).not.toHaveClass('bg-(--button-primary-bg)')
  })

  it('danger 用红底白字与红系 hover/active（§2.6/§2.9）', () => {
    render(<Button variant="danger">删除</Button>)

    expect(screen.getByRole('button')).toHaveClass(
      'bg-(--button-danger-bg)',
      'text-(--button-danger-fg)',
      'hover:bg-(--button-danger-bg-hover)',
      'active:bg-(--button-danger-bg-active)'
    )
  })

  it('disabled：真 disabled 属性 + Fills-F3 底 / Labels-Quaternary 字，且不带 hover/active 档', () => {
    render(<Button disabled>不可用</Button>)

    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveClass(
      'bg-(--fill-disabled)',
      'text-(--text-disabled)',
      'cursor-not-allowed'
    )
    expect(button).not.toHaveClass('hover:bg-(--button-primary-bg-hover)')
    expect(button).not.toHaveClass('active:bg-(--button-primary-bg-active)')
  })

  it('点击行为：可用时触发，disabled 时不触发', () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>跑</Button>)

    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(
      <Button disabled onClick={onClick}>
        跑
      </Button>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['sm', 'size-(--icon-size-sm)'],
    ['md', 'size-(--icon-size-md)'],
    ['lg', 'size-(--icon-size-lg)']
  ] as const)(
    'loading 延迟 200ms 才出 spinner（%s → %s 直径；§4.7 的 16/18/20）；功能立即禁用 + aria-busy',
    (size, sizeClass) => {
      vi.useFakeTimers()
      try {
        render(
          <Button size={size} loading>
            提交
          </Button>
        )

        // 可访问名只有文字：spinner 是装饰性的，状态由 aria-busy 表达
        const button = screen.getByRole('button', { name: '提交' })
        // 功能上从第一刻起就禁用（防重复提交）；视觉上先不动（防闪）
        expect(button).toBeDisabled()
        expect(button).toHaveAttribute('aria-busy', 'true')
        expect(button.querySelector('.animate-spin')).toBeNull()

        act(() => {
          vi.advanceTimersByTime(200)
        })

        expect(within(button).queryByRole('status')).toBeNull()
        expect(button).not.toHaveClass('hover:bg-(--button-primary-bg-hover)')

        const spinner = button.querySelector('.animate-spin')
        expect(spinner).not.toBeNull()
        expect(spinner).toHaveClass(sizeClass)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('快操作不闪：loading 没到 200ms 就结束 → 视觉完全没动过（无 spinner、无灰底）', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<Button>保存</Button>)
      const button = screen.getByRole('button', { name: '保存' })
      const baseline = button.className

      rerender(<Button loading>保存</Button>)
      // 窗口期内：功能已禁用，但 className 一动不动
      expect(button).toBeDisabled()
      expect(button.className).toBe(baseline)
      expect(button.querySelector('.animate-spin')).toBeNull()

      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(button.querySelector('.animate-spin')).toBeNull()
      expect(button.className).toBe(baseline)

      // 操作结束（还没到显示点）→ 之后也不会有迟到的 spinner
      rerender(<Button>保存</Button>)
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(button.className).toBe(baseline)
      expect(button).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('慢操作：spinner 一旦显示就至少保持 300ms 再退（避免收尾再闪一下）', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<Button>保存</Button>)
      const button = screen.getByRole('button', { name: '保存' })
      const hasSpinner = (): boolean => button.querySelector('.animate-spin') !== null

      rerender(<Button loading>保存</Button>)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(hasSpinner()).toBe(true)

      // 慢操作结束（loading 恢复）→ 保底 300ms 以内不撤
      rerender(<Button>保存</Button>)
      act(() => {
        vi.advanceTimersByTime(299)
      })
      expect(hasSpinner()).toBe(true)

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(hasSpinner()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('loading 时用 spinner 顶掉 icon，但保留文字（延迟窗口过后）', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<Button icon={<svg data-testid="icon" />}>发送</Button>)
      expect(screen.getByTestId('icon')).toBeInTheDocument()

      rerender(
        <Button icon={<svg data-testid="icon" />} loading>
          发送
        </Button>
      )
      // 窗口期内图标还在（视觉不动）
      expect(screen.getByTestId('icon')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.queryByTestId('icon')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('type 默认 button（免误触发表单提交），可显式覆盖', () => {
    const { rerender } = render(<Button>普通</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')

    rerender(<Button type="submit">提交</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit')
  })

  it('className 按组覆盖默认档（tailwind-merge）：传 h-8 时默认高度类消失', () => {
    render(<Button className="h-8">覆盖</Button>)

    const button = screen.getByRole('button')
    expect(button).toHaveClass('h-8')
    expect(button).not.toHaveClass('h-(--control-height-md)')
  })

  it('转发 ref 并透传其余属性（Radix asChild 要用）', () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <Button ref={ref} data-testid="btn" aria-label="带引用">
        引用
      </Button>
    )

    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    expect(ref.current).toBe(screen.getByTestId('btn'))
    expect(screen.getByTestId('btn')).toHaveAttribute('aria-label', '带引用')
  })
})
