import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@renderer/App'

/**
 * 路由表：/chat、/settings（按栏目）、/plugins、/memory、/usage + 根路径与未知路径落到 /chat。
 * 生产用 HashRouter（file:// 兼容，见 App.tsx），测试里换 MemoryRouter 直接指定起始路由。
 *
 * round 5 后的导航口径：二级菜单只剩「设置」（设置为唯一导航源）；记忆/用量在设置左列里切
 * （/settings/memory、/settings/usage）；插件走侧栏「插件」入口（/plugins）。
 */
function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  )
}

/** 左下角是单一入口（雷点 3）：菜单里只有「设置」一项（round 5 去重），先开菜单再点。 */
function openFooterMenu(): void {
  fireEvent.keyDown(screen.getByTestId('sidebar-menu-trigger'), { key: 'ArrowDown' })
}

function openSettings(): void {
  openFooterMenu()
  fireEvent.click(screen.getByTestId('nav-settings'))
}

describe('路由与页面骨架', () => {
  it('/chat 是对话页，四页的壳都在（三栏 + 侧栏内容 + 插件入口）', () => {
    renderAt('/chat')

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('main-column')).toBeInTheDocument()
    expect(screen.getByTestId('work-panel')).toBeInTheDocument()
    expect(screen.getByTestId('new-session')).toBeInTheDocument()
    expect(screen.getByTestId('session-list')).toBeInTheDocument()
    // round 5：插件入口在「新建会话」下方（侧栏里）
    expect(screen.getByTestId('nav-plugins')).toBeInTheDocument()
  })

  it('二级菜单切设置：菜单里只有设置一项；记忆/用量在设置左列里切', () => {
    renderAt('/chat')

    openSettings()
    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()

    // 设置左列切「记忆」→ 真实记忆面板（round 5：不再是占位）
    fireEvent.click(screen.getByTestId('settings-nav-memory'))
    expect(screen.getByTestId('settings-group-memory')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-memory')).toHaveAttribute('aria-current', 'page')

    // 再切「用量」
    fireEvent.click(screen.getByTestId('settings-nav-usage'))
    expect(screen.getByTestId('settings-group-usage')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-memory')).not.toBeInTheDocument()

    // 「返回」回会话视图
    fireEvent.click(screen.getByTestId('settings-back'))
    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
  })

  it('侧栏「插件」入口：切到 /plugins，选中态联动；返回会话后取消选中', () => {
    renderAt('/chat')

    fireEvent.click(screen.getByTestId('nav-plugins'))
    expect(screen.getByTestId('plugins-page')).toBeInTheDocument()
    expect(screen.getByTestId('nav-plugins')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('new-session'))
    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(screen.getByTestId('nav-plugins')).not.toHaveAttribute('aria-current')
  })

  it('主列渲染的是路由内容（同一份壳不重新挂载：侧栏与顶栏还在）', () => {
    renderAt('/chat')
    const sidebar = screen.getByTestId('sidebar')

    openSettings()
    fireEvent.click(screen.getByTestId('settings-nav-usage'))

    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
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

  it('/memory 与 /usage 直达保留（不进任何菜单，standalone 页面仍在）', () => {
    renderAt('/memory')
    expect(screen.getByTestId('memory-page')).toBeInTheDocument()
    // 侧栏里没有指向它的菜单项（只有设置一项 + 插件入口）
    expect(screen.queryByTestId('nav-memory')).not.toBeInTheDocument()
  })

  it('二级菜单只有「设置」一项（round 5 去重：无重复入口）', () => {
    renderAt('/chat')

    openFooterMenu()

    expect(screen.getByTestId('nav-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-memory')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-usage')).not.toBeInTheDocument()
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

  it('设置左列没有「工具与 MCP」（round 5 迁到插件页）', () => {
    renderAt('/settings')

    expect(screen.queryByTestId('settings-nav-tools')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-tools')).not.toBeInTheDocument()
  })

  it('设置页脏栏目回落默认栏（URL 手改坏了也不空着）', () => {
    renderAt('/settings/nonsense')

    expect(screen.getByTestId('settings-group-appearance')).toBeInTheDocument()
  })

  it('内容列限宽居中：各页面都走 .content-column（侧栏覆盖层不压内容、也不横向裁切）', () => {
    renderAt('/chat')

    expect(screen.getByTestId('chat-page')).toHaveClass('content-column')

    openSettings()
    expect(screen.getByTestId('settings-page')).toHaveClass('content-column')

    fireEvent.click(screen.getByTestId('settings-nav-memory'))
    expect(screen.getByTestId('settings-page')).toHaveClass('content-column')

    fireEvent.click(screen.getByTestId('settings-back'))
    fireEvent.click(screen.getByTestId('nav-plugins'))
    expect(screen.getByTestId('plugins-page')).toHaveClass('content-column')
  })
})
