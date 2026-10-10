import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../button'
import { Popover } from '../popover'
import { tick } from './tick'

describe('Popover', () => {
  it('点触发元素弹出：圆角 20 / 弹层阴影 / 玻璃 15px（spec §6.3 的菜单类弹层配方）', () => {
    render(
      <Popover trigger={<Button>更多</Button>}>
        <p>面板内容</p>
      </Popover>
    )

    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '更多' }))

    const content = screen.getByText('面板内容').parentElement
    expect(content).toHaveClass(
      'rounded-overlay',
      'bg-menu',
      'shadow-(--shadow-overlay)',
      'backdrop-blur-(--blur-glass)',
      'p-4'
    )
  })

  it('不是模态：打开时不铺蒙层（仅模态用蒙层）', () => {
    render(
      <Popover trigger={<Button>更多</Button>}>
        <p>面板内容</p>
      </Popover>
    )
    fireEvent.click(screen.getByRole('button', { name: '更多' }))

    expect(screen.getByText('面板内容')).toBeInTheDocument()
    expect(document.querySelector('.bg-mask')).toBeNull()
  })

  it('点外面关闭（Radix 的点外关闭是"pointerdown + click"两步，先 tick 再点）', async () => {
    render(
      <Popover trigger={<Button>更多</Button>}>
        <p>面板内容</p>
      </Popover>
    )
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    await tick()

    fireEvent.pointerDown(document.body, { button: 0 })
    fireEvent.click(document.body)
    await tick()

    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()
  })

  it('受控用法：open + onOpenChange', () => {
    const onOpenChange = vi.fn()
    render(
      <Popover open={false} onOpenChange={onOpenChange} trigger={<Button>更多</Button>}>
        <p>面板内容</p>
      </Popover>
    )

    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()
  })

  it('触发元素保留自身语义（asChild：按钮仍是按钮）', () => {
    render(
      <Popover trigger={<Button variant="ghost">更多</Button>}>
        <p>面板内容</p>
      </Popover>
    )

    const trigger = screen.getByRole('button', { name: '更多' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })
})
