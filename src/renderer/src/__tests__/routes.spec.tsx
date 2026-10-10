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

  it('点侧栏导航依次切页：设置 → 记忆 → 用量（每次只留一个页面）', () => {
    renderAt('/chat')

    fireEvent.click(screen.getByTestId('nav-settings'))
    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('nav-memory'))
    expect(screen.getByTestId('memory-page')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-page')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('nav-usage'))
    expect(screen.getByTestId('usage-page')).toBeInTheDocument()
    expect(screen.queryByTestId('memory-page')).not.toBeInTheDocument()
  })

  it('主列渲染的是路由内容（同一份壳不重新挂载：侧栏与顶栏还在）', () => {
    renderAt('/chat')
    const sidebar = screen.getByTestId('sidebar')

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

  it('当前页在侧栏有选中标记（aria-current=page）', () => {
    renderAt('/usage')

    expect(screen.getByTestId('nav-usage')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('nav-settings')).not.toHaveAttribute('aria-current')
  })

  it('内容列限宽居中：侧栏是覆盖层（主列不位移），贴左缘的内容会被盖住', () => {
    renderAt('/chat')

    expect(screen.getByTestId('chat-page')).toHaveClass('max-w-(--content-max-width)', 'mx-auto')

    fireEvent.click(screen.getByTestId('nav-settings'))

    expect(screen.getByTestId('settings-page')).toHaveClass(
      'max-w-(--content-max-width)',
      'mx-auto'
    )
  })
})
