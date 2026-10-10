import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { NewSessionButton } from '../NewSessionButton'

/**
 * 侧栏「新建会话」块按钮（附录 A：224 × 41；224 = 侧栏 240 − 左右内边距 8×2，所以是 w-full）。
 * 底与文字走 --field-bg / 墨色（实测 深 #1f1f1f 底 + #dbdbdb 字，正是 Bg-Secondary + Labels-Primary）。
 * 本任务只做"点了回到对话页"（T9 接真实会话）。
 */
function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderButton(path = '/settings'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NewSessionButton />
      <LocationProbe />
    </MemoryRouter>
  )
}

describe('新建会话按钮', () => {
  it('高 41 走 T5 壳 token（覆盖 Button 默认档），铺满侧栏内容宽', () => {
    renderButton()

    const button = screen.getByTestId('new-session')
    expect(button).toHaveClass('h-(--new-session-height)', 'w-full', 'bg-(--field-bg)')
    // 覆盖真生效：Tailwind 默认档与自己写的底都该被吃掉
    expect(button).not.toHaveClass('h-(--control-height-md)')
    expect(button).not.toHaveClass('bg-transparent')
  })

  it('有文字名与图标（图标不进无障碍树）', () => {
    renderButton()

    const button = screen.getByRole('button', { name: '新建会话' })
    expect(button).toBe(screen.getByTestId('new-session'))
    expect(button.querySelector('span[aria-hidden="true"]')).not.toBeNull()
  })

  it('点了回到对话页（T9 之前的最简语义）', () => {
    renderButton('/settings')

    fireEvent.click(screen.getByTestId('new-session'))

    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })
})
