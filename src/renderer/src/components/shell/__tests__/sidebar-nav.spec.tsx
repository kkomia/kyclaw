import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { SidebarNav } from '../SidebarNav'

/**
 * 侧栏底部导航（设置 / 记忆 / 用量）。
 * 尺寸与状态口径来自 spec §6.2 与 UI 参考附录 A（导航项高 36、图标 18、选中 Fills-F2、hover Fills-F1）；
 * jsdom 不跑样式，所以这里断言的是"引用正确 token/工具类"，几何由 T16 走查对数。
 */
function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarNav />
    </MemoryRouter>
  )
}

describe('侧栏底部导航', () => {
  it('三项导航都在，且是链接（href 指到路由）', () => {
    renderAt('/chat')

    expect(screen.getByTestId('nav-settings')).toHaveAttribute('href', '/settings')
    expect(screen.getByTestId('nav-memory')).toHaveAttribute('href', '/memory')
    expect(screen.getByTestId('nav-usage')).toHaveAttribute('href', '/usage')
  })

  it('标签文字就是无障碍名（不是 aria-label 顶掉）', () => {
    renderAt('/chat')

    expect(screen.getByRole('link', { name: '设置' })).toBe(screen.getByTestId('nav-settings'))
    expect(screen.getByRole('link', { name: '记忆' })).toBe(screen.getByTestId('nav-memory'))
    expect(screen.getByRole('link', { name: '用量' })).toBe(screen.getByTestId('nav-usage'))
  })

  it('导航项外观走壳 token：高 36 / 图标 18 / hover Fills-F1', () => {
    renderAt('/chat')

    const item = screen.getByTestId('nav-settings')
    expect(item).toHaveClass(
      'h-(--nav-item-height)',
      'rounded-control',
      'text-b2',
      'hover:bg-hover'
    )

    const iconBox = item.querySelector('span[aria-hidden="true"]')
    expect(iconBox).toHaveClass('size-(--icon-size-md)')
  })

  it('当前页的项用 Fills-F2 选中底 + aria-current=page，其余项没有', () => {
    renderAt('/settings')

    expect(screen.getByTestId('nav-settings')).toHaveClass('bg-selected')
    expect(screen.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page')

    for (const other of ['nav-memory', 'nav-usage']) {
      expect(screen.getByTestId(other), other).not.toHaveClass('bg-selected')
      expect(screen.getByTestId(other), other).not.toHaveAttribute('aria-current')
    }
  })

  it('选中项仍保留 hover 反馈（Fills-F1 的类不被选中态顶掉）', () => {
    renderAt('/memory')

    expect(screen.getByTestId('nav-memory')).toHaveClass('bg-selected', 'hover:bg-hover')
    expect(screen.getByTestId('nav-settings')).not.toHaveClass('bg-selected')
  })
})
