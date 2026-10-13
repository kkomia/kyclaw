import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { commandKeyLabel } from '../session-shortcuts'
import { NewSessionButton } from '../NewSessionButton'

/**
 * 侧栏「新建会话」块按钮（附录 A：224 × 41；224 = 侧栏 240 − 左右内边距 8×2，所以是 w-full）。
 * 底与文字走 --field-bg / 墨色（实测 深 #1f1f1f 底 + #dbdbdb 字，正是 Bg-Secondary + Labels-Primary）。
 * T9：点击 = 触发 onNew（开草稿会话）+ 回到对话页。
 * round 64（用户口径）：三段式一行 —— 左侧图标（跟设置页图标同一档）+ 标签 + 右侧 Ctrl+K 键帽；
 * 同一个动作也接了全局快捷键（见 new-session-shortcut.spec）。
 */
function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderButton(path = '/settings', onNew?: () => void): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NewSessionButton onNew={onNew} />
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

  it('点了：触发 onNew（开新草稿）并回到对话页', () => {
    const onNew = vi.fn()
    renderButton('/settings', onNew)

    fireEvent.click(screen.getByTestId('new-session'))

    expect(onNew).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('没接 onNew 也能用（纯导航；单测/复用场景）', () => {
    renderButton('/settings')

    fireEvent.click(screen.getByTestId('new-session'))

    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('round 64：左侧图标 + 中间标签 + 右侧 Ctrl + K 两枚键帽（顺序即按法）', () => {
    renderButton()

    const button = screen.getByTestId('new-session')
    // 两枚键帽：命令键当前平台该画什么就画什么（macOS 是 ⌘），另一枚是 K
    expect(Array.from(button.querySelectorAll('kbd')).map((node) => node.textContent)).toEqual([
      commandKeyLabel(),
      'K'
    ])
    // 图标走 lucide，尺寸与设置页/插件入口的导航图标同一档
    expect(button.querySelector('svg')?.getAttribute('class') ?? '').toContain('lucide-square-pen')
    expect(button.querySelector('span[aria-hidden="true"]')?.className).toContain(
      'size-(--icon-size-md)'
    )
    // 排布：图标 → 文字 → 键帽
    expect(button.textContent).toBe(`新建会话${commandKeyLabel()}K`)
  })

  it('round 64：键帽不进无障碍名（按钮名还是四个字，念出来不带键位）', () => {
    renderButton()

    const button = screen.getByTestId('new-session')
    expect(button).toHaveAccessibleName('新建会话')
    // 键帽整组 aria-hidden：读屏不念 "Ctrl K"
    const capsWrapper = button.querySelector('kbd')?.parentElement
    expect(capsWrapper).toHaveAttribute('aria-hidden', 'true')
  })
})
