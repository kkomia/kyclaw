import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { IconButton } from '../icon-button'

describe('IconButton', () => {
  it('36 方格 / 圆角 20 / .5px 描边（§4.7 .linear-icon-button、§5.1 的 20px 圆角）', () => {
    render(<IconButton label="新建会话" icon={<svg data-testid="icon" />} />)

    expect(screen.getByRole('button', { name: '新建会话' })).toHaveClass(
      'size-(--icon-button-size)',
      'rounded-icon-button',
      'border-(length:--hairline-width)',
      'border-hairline',
      'bg-transparent',
      'text-ink'
    )
  })

  it('label 就是无障碍名，图标本体不进无障碍树（图标 18 = --icon-size-md，§4.8）', () => {
    render(<IconButton label="设置" icon={<svg data-testid="icon" />} />)

    const button = screen.getByRole('button', { name: '设置' })
    expect(button).toHaveAttribute('aria-label', '设置')

    const iconBox = button.querySelector('span[aria-hidden="true"]')
    expect(iconBox).not.toBeNull()
    expect(iconBox).toHaveClass('size-(--icon-size-md)', '[&>svg]:size-full')
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('图标不透明度三档 .56 / .84 / .26（§4.8 图标按钮的 icon opacity）', () => {
    render(<IconButton label="折叠" icon={<svg />} />)

    const iconBox = screen.getByRole('button').querySelector('span[aria-hidden="true"]')
    expect(iconBox).toHaveClass(
      'opacity-(--icon-opacity)',
      'group-hover:opacity-(--icon-opacity-hover)',
      'group-data-disabled:opacity-(--icon-opacity-disabled)'
    )
  })

  it('disabled：真属性 + data-disabled 标记（图标降不透明度靠它），点击不触发', () => {
    const onClick = vi.fn()
    const { rerender } = render(<IconButton label="发送" icon={<svg />} onClick={onClick} />)

    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button')).not.toHaveAttribute('data-disabled')

    rerender(<IconButton label="发送" icon={<svg />} onClick={onClick} disabled />)
    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('data-disabled')
    expect(button).toHaveClass('group', 'disabled:cursor-not-allowed')
    expect(button.querySelector('span[aria-hidden="true"]')).toHaveClass(
      'group-data-disabled:opacity-(--icon-opacity-disabled)'
    )

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('type 默认 button（标题栏/工具栏里的图标按钮不该误提交表单）', () => {
    render(<IconButton label="最小化" icon={<svg />} />)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('className 覆盖与 ref 透传（Radix asChild 要用）', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<IconButton ref={ref} label="更多" icon={<svg />} className="rounded-control" />)

    const button = screen.getByRole('button')
    expect(button).toBe(ref.current)
    expect(button).toHaveClass('rounded-control')
    expect(button).not.toHaveClass('rounded-icon-button')
  })
})
