import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from '../button'
import { Tooltip } from '../tooltip'

describe('Tooltip', () => {
  it('聚焦触发元素弹出：深底 + 84% 白字 + C2 字号（§2.9 常色 / §3.1 的 C2 档）', () => {
    render(
      <Tooltip label="新建会话">
        <Button variant="ghost">＋</Button>
      </Tooltip>
    )

    expect(screen.queryByText('新建会话')).not.toBeInTheDocument()

    fireEvent.focus(screen.getByRole('button', { name: '＋' }))

    const content = screen.getByText('新建会话')
    expect(content).toHaveClass(
      'bg-(--tooltip-bg)',
      'text-(--tooltip-fg)',
      'text-c2',
      'rounded-button-sm',
      'px-2',
      'py-1'
    )
  })

  it('失焦收起', () => {
    render(
      <Tooltip label="新建会话">
        <Button variant="ghost">＋</Button>
      </Tooltip>
    )

    const trigger = screen.getByRole('button', { name: '＋' })
    fireEvent.focus(trigger)
    expect(screen.getByText('新建会话')).toBeInTheDocument()

    fireEvent.blur(trigger)
    expect(screen.queryByText('新建会话')).not.toBeInTheDocument()
  })

  it('自足：不需要调用方额外包一层 Provider（组件内部自带）', () => {
    render(
      <Tooltip label="提示一">
        <Button variant="ghost">一</Button>
      </Tooltip>
    )
    render(
      <Tooltip label="提示二">
        <Button variant="ghost">二</Button>
      </Tooltip>
    )

    fireEvent.focus(screen.getByRole('button', { name: '一' }))
    expect(screen.getByText('提示一')).toBeInTheDocument()

    fireEvent.focus(screen.getByRole('button', { name: '二' }))
    expect(screen.getByText('提示二')).toBeInTheDocument()
  })

  it('触发元素自身语义不变，弹出时挂上 aria-describedby', () => {
    render(
      <Tooltip label="设置">
        <Button variant="ghost">外观</Button>
      </Tooltip>
    )

    const trigger = screen.getByRole('button', { name: '外观' })
    expect(trigger.tagName).toBe('BUTTON')

    fireEvent.focus(trigger)
    const content = screen.getByText('设置')
    expect(trigger.getAttribute('aria-describedby')).toBe(content.getAttribute('id'))
  })
})
