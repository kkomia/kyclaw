import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Chip } from '../chip'

describe('Chip', () => {
  it('高 36、药丸、1px 描边、无独立底色（§4.6 快捷 chip 实测）', () => {
    render(<Chip>帮我总结今天的工作</Chip>)

    expect(screen.getByRole('button', { name: '帮我总结今天的工作' })).toHaveClass(
      'h-(--chip-height)',
      'rounded-pill',
      'border',
      'border-hairline',
      'bg-transparent',
      'px-3',
      'text-b2',
      'text-ink-secondary'
    )
  })

  it('可点：点击回调、hover 用填充档、type 默认 button', () => {
    const onClick = vi.fn()
    render(<Chip onClick={onClick}>写周报</Chip>)

    const chip = screen.getByRole('button', { name: '写周报' })
    expect(chip).toHaveAttribute('type', 'button')
    expect(chip).toHaveClass('hover:bg-hover', 'active:bg-active')

    fireEvent.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('图标位取 16 档（--icon-size-sm）且不进无障碍树', () => {
    render(<Chip icon={<svg data-testid="chip-icon" />}>翻译</Chip>)

    const chip = screen.getByRole('button', { name: '翻译' })
    const iconBox = chip.querySelector('span[aria-hidden="true"]')
    expect(iconBox).toHaveClass('size-(--icon-size-sm)')
    expect(screen.getByTestId('chip-icon')).toBeInTheDocument()
  })

  it('className 可覆盖默认档（tailwind-merge）', () => {
    render(<Chip className="h-8">短</Chip>)

    expect(screen.getByRole('button')).toHaveClass('h-8')
    expect(screen.getByRole('button')).not.toHaveClass('h-(--chip-height)')
  })
})
