import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { SidebarFooter } from '../SidebarFooter'
import { tick } from '../../ui/__tests__/tick'

/**
 * 侧栏底部：单一入口 + 二级菜单（雷点 3：首页菜单必须简洁 —— 能收进二级菜单的一律收进去）。
 * 菜单本体（无遮罩、底 Bg-Tertiary、条目高 36、进出场动效）由 ui/menu.spec 钉；
 * 这里钉的是"只有一个入口""条目指向四条路由""当前页有选中标记"。
 */
function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderFooter(path = '/chat'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarFooter />
      <LocationProbe />
    </MemoryRouter>
  )
}

function openMenu(): void {
  fireEvent.keyDown(screen.getByTestId('sidebar-menu-trigger'), { key: 'ArrowDown' })
}

describe('侧栏底部单一入口', () => {
  it('无顶线（round 4 E1：Kimi 口径）——footer 与侧栏浑然一体，不画分隔线', () => {
    renderFooter()

    const footer = screen.getByTestId('sidebar-footer')
    expect(footer).not.toHaveClass('border-t')
    // 分隔感只靠入口自身的 hover / 选中填充（navItemClass），不靠线
    expect(screen.getByTestId('sidebar-menu-trigger')).toHaveClass('rounded-control')
  })

  it('默认只有入口本身，二级菜单只有「设置」（round 5 去重：记忆/用量不再重复出菜单）', () => {
    renderFooter()

    const trigger = screen.getByTestId('sidebar-menu-trigger')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('kyclaw')

    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument()

    openMenu()

    expect(screen.getByTestId('nav-settings')).toBeInTheDocument()
    // 去重（用户实拍 #8）：设置是唯一导航源，弹层不再有记忆/用量
    expect(screen.queryByTestId('nav-memory')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-usage')).not.toBeInTheDocument()
  })

  it('点「设置」切到 /settings', async () => {
    renderFooter()

    openMenu()
    fireEvent.click(screen.getByTestId('nav-settings'))
    await tick()
    expect(screen.getByTestId('location')).toHaveTextContent('/settings')
  })

  it('在设置页时条目带选中底 + aria-current=page', () => {
    renderFooter('/settings/appearance')

    openMenu()

    expect(screen.getByTestId('nav-settings')).toHaveClass('bg-selected')
    expect(screen.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page')
  })

  it('入口本身也是导航项外观（高 36 / hover Fills-F1）', () => {
    renderFooter()

    expect(screen.getByTestId('sidebar-menu-trigger')).toHaveClass(
      'h-(--nav-item-height)',
      'rounded-control',
      'text-b2',
      'hover:bg-hover'
    )
  })
})
