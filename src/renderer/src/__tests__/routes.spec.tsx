import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@renderer/App'

/**
 * 路由表：/chat、/settings、/memory、/usage 四条 + 根路径与未知路径落到 /chat。
 * 生产用 HashRouter（file:// 兼容，见 App.tsx），测试里换 MemoryRouter 直接指定起始路由。
 */
function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  )
}

/** 左下角是单一入口（雷点 3）：设置 / 记忆 / 用量 都在二级菜单里，先开菜单再点。 */
function openFooterMenu(): void {
  fireEvent.keyDown(screen.getByTestId('sidebar-menu-trigger'), { key: 'ArrowDown' })
}

describe('路由与页面骨架', () => {
  it('/chat 是对话页，四页的壳都在（三栏 + 侧栏内容）', () => {
    renderAt('/chat')

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('main-column')).toBeInTheDocument()
    expect(screen.getByTestId('work-panel')).toBeInTheDocument()
    expect(screen.getByTestId('new-session')).toBeInTheDocument()
    expect(screen.getByTestId('session-list')).toBeInTheDocument()
  })

  it('二级菜单依次切页：设置 →（返回）记忆 → 用量，每次只留一个页面', () => {
    renderAt('/chat')

    openFooterMenu()
    fireEvent.click(screen.getByTestId('nav-settings'))
    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()

    // 设置页的左列是设置菜单（会话视图收起来了）：先「返回」再开二级菜单
    fireEvent.click(screen.getByTestId('settings-back'))
    expect(screen.getByTestId('chat-page')).toBeInTheDocument()

    openFooterMenu()
    fireEvent.click(screen.getByTestId('nav-memory'))
    expect(screen.getByTestId('memory-page')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-page')).not.toBeInTheDocument()

    openFooterMenu()
    fireEvent.click(screen.getByTestId('nav-usage'))
    expect(screen.getByTestId('usage-page')).toBeInTheDocument()
    expect(screen.queryByTestId('memory-page')).not.toBeInTheDocument()
  })

  it('主列渲染的是路由内容（同一份壳不重新挂载：侧栏与顶栏还在）', () => {
    renderAt('/chat')
    const sidebar = screen.getByTestId('sidebar')

    openFooterMenu()
    fireEvent.click(screen.getByTestId('nav-usage'))

    expect(screen.getByTestId('usage-page')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toBe(sidebar)
    expect(screen.getByTestId('titlebar')).toBeInTheDocument()
  })

  it('根路径落到 /chat', () => {
    renderAt('/')

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
  })

  it('未知路径也落到 /chat（不让主列空着）', () => {
    renderAt('/nonsense')

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
  })

  it('当前页在二级菜单里有选中标记（aria-current=page）', () => {
    renderAt('/usage')

    openFooterMenu()

    expect(screen.getByTestId('nav-usage')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('nav-settings')).not.toHaveAttribute('aria-current')
  })

  it('设置页按栏目切内容：左列设置菜单 + /settings/:section 深链', () => {
    renderAt('/settings')

    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-appearance')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('settings-group-appearance')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-model')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('settings-nav-model'))

    expect(screen.getByTestId('settings-group-model')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-appearance')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-model')).toHaveAttribute('aria-current', 'page')
  })

  it('设置页脏栏目回落默认栏（URL 手改坏了也不空着）', () => {
    renderAt('/settings/nonsense')

    expect(screen.getByTestId('settings-group-appearance')).toBeInTheDocument()
  })

  it('内容列限宽居中：四个页面都走 .content-column（侧栏覆盖层不压内容、也不横向裁切）', () => {
    renderAt('/chat')

    expect(screen.getByTestId('chat-page')).toHaveClass('content-column')

    openFooterMenu()
    fireEvent.click(screen.getByTestId('nav-settings'))
    expect(screen.getByTestId('settings-page')).toHaveClass('content-column')

    fireEvent.click(screen.getByTestId('settings-back'))
    openFooterMenu()
    fireEvent.click(screen.getByTestId('nav-memory'))
    expect(screen.getByTestId('memory-page')).toHaveClass('content-column')

    openFooterMenu()
    fireEvent.click(screen.getByTestId('nav-usage'))
    expect(screen.getByTestId('usage-page')).toHaveClass('content-column')
  })
})
