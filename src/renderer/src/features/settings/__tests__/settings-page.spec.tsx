import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { DEFAULT_SETTINGS, defaultSettings } from '@shared/settings'
import { SettingsPage } from '../SettingsPage'

/**
 * 设置页（UI 返工 R1 起是栏目页）：默认栏是「外观」（主题三选 → setTheme、字号三档 → setFontTier，
 * 断言落在 html[data-theme] / html[data-font-size] 与落盘调用上）；其余栏目各自的占位文案。
 * 栏目切换与左列设置菜单由 routes.spec 走真实路由钉（这里只渲一栏的内容）。
 */
function renderPage(path = '/settings'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>
  )
}
const html = (): HTMLElement => document.documentElement

function installMatchMedia(matches: boolean): void {
  const query = {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true
  }
  window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  html().removeAttribute('data-theme')
  html().removeAttribute('data-font-size')
  window.matchMedia = undefined as unknown as typeof window.matchMedia
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('设置页骨架（栏目页）', () => {
  it('默认栏是「外观」：只渲当前栏，其余栏不进 DOM', () => {
    renderPage()

    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-page')).toHaveClass('content-column')
    expect(screen.getByTestId('settings-group-appearance')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-model')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-usage')).not.toBeInTheDocument()
  })

  it('「模型」栏：provider 预设入口在这一栏里', () => {
    renderPage('/settings/model')

    expect(screen.getByTestId('settings-group-model')).toHaveTextContent('添加通道')
  })

  it('还没做的栏目：一句状态就够（不写实现细节）', () => {
    for (const [section, testId] of [
      ['tools', 'settings-group-tools'],
      ['workspaces', 'settings-group-workspaces'],
      ['memory', 'settings-group-memory'],
      ['usage', 'settings-group-usage']
    ]) {
      const view = render(
        <MemoryRouter initialEntries={[`/settings/${section}`]}>
          <SettingsPage />
        </MemoryRouter>
      )
      expect(screen.getByTestId(testId), testId).toHaveTextContent('还没做')
      view.unmount()
    }
  })
})

describe('外观 · 主题三选', () => {
  it('三档都在（跟随系统 / 亮色 / 暗色），默认档是跟随系统', () => {
    renderPage()

    expect(screen.getByTestId('theme-system')).toHaveTextContent('跟随系统')
    expect(screen.getByTestId('theme-light')).toHaveTextContent('亮色')
    expect(screen.getByTestId('theme-dark')).toHaveTextContent('暗色')

    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'false')
  })

  it('点「暗色」→ html[data-theme]=dark、选中态跟着走、落盘 {theme:dark}', async () => {
    const bridge = installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('theme-dark'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('theme-dark')).toHaveClass('bg-selected')
    expect(screen.getByTestId('theme-system')).not.toHaveClass('bg-selected')
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ theme: 'dark' }))
  })

  it('点「亮色」→ html[data-theme]=light（即使系统是深色）', () => {
    installMatchMedia(true)
    installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('theme-light'))

    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('点「跟随系统」→ 立刻按当前系统值解析（系统深色就是 dark）', () => {
    installMatchMedia(true)
    installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'light' })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } })
    renderPage()
    expect(html().getAttribute('data-theme')).toBeNull()

    fireEvent.click(screen.getByTestId('theme-system'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
  })

  it('落盘失败不改 UI（本次改动仍在，只留日志）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    renderPage()

    fireEvent.click(screen.getByTestId('theme-dark'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(console.error).toHaveBeenCalled())
  })
})

describe('外观 · 字号三档', () => {
  it('三档都在（小 / 默认 / 大），默认档是默认', () => {
    renderPage()

    expect(screen.getByTestId('font-small')).toHaveTextContent('小')
    expect(screen.getByTestId('font-default')).toHaveTextContent('默认')
    expect(screen.getByTestId('font-large')).toHaveTextContent('大')
    expect(screen.getByTestId('font-default')).toHaveAttribute('aria-pressed', 'true')
  })

  it('三档各切一遍 → html[data-font-size] 跟着走，落盘只带改动的字段', async () => {
    const bridge = installKyclawBridge()
    renderPage()

    for (const tier of ['small', 'large', 'default']) {
      fireEvent.click(screen.getByTestId(`font-${tier}`))
      expect(html().getAttribute('data-font-size'), tier).toBe(tier)
      expect(screen.getByTestId(`font-${tier}`), tier).toHaveAttribute('aria-pressed', 'true')
    }

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ fontTier: 'default' }))
    expect(bridge.update).toHaveBeenCalledWith({ fontTier: 'small' })
    expect(bridge.update).toHaveBeenCalledWith({ fontTier: 'large' })
  })

  it('切字号不动主题（显式暗色仍是暗色）', () => {
    installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('theme-dark'))
    fireEvent.click(screen.getByTestId('font-large'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().getAttribute('data-font-size')).toBe('large')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('外观 · 与落盘设置一致', () => {
  it('启动读到 dark + large 后，页面显示的选中态与 html 属性一致', async () => {
    installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'large' })
    await useSettingsStore.getState().load()

    renderPage()

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().getAttribute('data-font-size')).toBe('large')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('font-large')).toHaveAttribute('aria-pressed', 'true')
  })
})
