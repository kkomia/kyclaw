import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { useShellStore } from '@renderer/lib/shell-store'
import { PrimaryNav } from '../PrimaryNav'

/**
 * 一级导航（0.2.0 应用壳；2026-10-17 用户拍板）：四个模块入口 + 底部设置入口，
 * **只有图标栏一种形态**（固定 56 宽，没有展开/收起两档，也没有顶部那个开关）。
 * 导航本身只管路由与选中态；会话列表是内容卡内的二级栏，不在这里。
 */
function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderNav(path = '/chat'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <PrimaryNav />
      <LocationProbe />
    </MemoryRouter>
  )
}

beforeEach(() => {
  useShellStore.setState({
    sidebarCollapsed: false,
    workPanelOpen: false,
    workPanelWidth: 400,
    workPanelFullscreen: false,
    workPanelFit: null
  })
})

describe('PrimaryNav 一级导航', () => {
  it('四个模块入口 + 底部设置入口；主对话按当前路由选中', () => {
    renderNav()
    const nav = screen.getByTestId('primary-nav')

    for (const label of ['主对话', '笔记', '知识库', 'Office', '导图']) {
      expect(within(nav).getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByTestId('primary-nav-chat')).toHaveAttribute('aria-current', 'page')
    // 设置是最后一个动作（底部入口），不与模块项混排
    expect(within(nav).getAllByRole('button').at(-1)).toBe(
      screen.getByTestId('primary-nav-settings')
    )
  })

  it('点模块入口切路由，选中态跟着走', () => {
    renderNav('/chat')

    fireEvent.click(screen.getByTestId('primary-nav-notes'))

    expect(screen.getByTestId('location')).toHaveTextContent('/notes')
    expect(screen.getByTestId('primary-nav-notes')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('primary-nav-chat')).not.toHaveAttribute('aria-current')
  })

  it('永远只有图标栏：固定 56 宽（--primary-nav-rail-width）、无文字标签、没有收起/展开开关', () => {
    renderNav()
    const nav = screen.getByTestId('primary-nav')

    // 宽度只有 rail 一档：不能出现旧的 200px 展开档，也不再随任何 store 状态变
    expect(nav).toHaveClass('w-(--primary-nav-rail-width)')
    expect(nav).not.toHaveClass('w-(--primary-nav-width)')
    expect(nav).not.toHaveAttribute('data-collapsed')
    expect(screen.queryByTestId('primary-nav-toggle')).not.toBeInTheDocument()

    // 标签文字不渲染（图标栏形态），但可访问名 / hover 提示都在：不是无名图标
    expect(screen.queryByText('主对话')).not.toBeInTheDocument()
    expect(screen.queryByText('设置')).not.toBeInTheDocument()
    for (const entry of ['primary-nav-chat', 'primary-nav-notes']) {
      const button = screen.getByTestId(entry)
      expect(button).toHaveAccessibleName()
      expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'))
    }
    expect(screen.getByTestId('primary-nav-chat')).toHaveAttribute('title', '主对话')
    // 图标居中（没有文字时不再靠左给标签留位）
    expect(screen.getByTestId('primary-nav-chat')).toHaveClass('justify-center', 'px-0')
  })

  it('设置入口在底部：点开走 /settings，深链不受模块选中影响', () => {
    renderNav('/notes')

    fireEvent.click(screen.getByTestId('primary-nav-settings'))

    expect(screen.getByTestId('location')).toHaveTextContent('/settings')
    expect(screen.getByTestId('primary-nav-settings')).toHaveAttribute('aria-current', 'page')
  })
})
