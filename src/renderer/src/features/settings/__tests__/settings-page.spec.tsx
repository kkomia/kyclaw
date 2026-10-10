import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { DEFAULT_SETTINGS, defaultSettings } from '@shared/settings'
import { SettingsPage } from '../SettingsPage'

/**
 * 设置页「外观」组：主题三选 → setTheme、字号三档 → setFontTier，
 * 断言落在 html[data-theme] / html[data-font-size]（机制的唯一出口）与落盘调用上。
 * 其余五组本任务只有占位文案。
 */
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

describe('设置页骨架', () => {
  it('六组都在：外观与模型是功能组，其余四组是占位', () => {
    render(<SettingsPage />)

    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-appearance')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-model')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-tools')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-workspaces')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-memory')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-usage')).toBeInTheDocument()

    // 模型组（T8）：provider 预设入口就在这一组里
    expect(screen.getByTestId('settings-group-model')).toHaveTextContent('添加通道')

    for (const testId of [
      'settings-group-tools',
      'settings-group-workspaces',
      'settings-group-memory',
      'settings-group-usage'
    ]) {
      expect(screen.getByTestId(testId), testId).toHaveTextContent('尚未接入')
    }
  })
})

describe('外观 · 主题三选', () => {
  it('三档都在（跟随系统 / 亮色 / 暗色），默认档是跟随系统', () => {
    render(<SettingsPage />)

    expect(screen.getByTestId('theme-system')).toHaveTextContent('跟随系统')
    expect(screen.getByTestId('theme-light')).toHaveTextContent('亮色')
    expect(screen.getByTestId('theme-dark')).toHaveTextContent('暗色')

    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'false')
  })

  it('点「暗色」→ html[data-theme]=dark、选中态跟着走、落盘 {theme:dark}', async () => {
    const bridge = installKyclawBridge()
    render(<SettingsPage />)

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
    render(<SettingsPage />)

    fireEvent.click(screen.getByTestId('theme-light'))

    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('点「跟随系统」→ 立刻按当前系统值解析（系统深色就是 dark）', () => {
    installMatchMedia(true)
    installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'light' })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } })
    render(<SettingsPage />)
    expect(html().getAttribute('data-theme')).toBeNull()

    fireEvent.click(screen.getByTestId('theme-system'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
  })

  it('落盘失败不改 UI（本次改动仍在，只留日志）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    render(<SettingsPage />)

    fireEvent.click(screen.getByTestId('theme-dark'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(console.error).toHaveBeenCalled())
  })
})

describe('外观 · 字号三档', () => {
  it('三档都在（小 / 默认 / 大），默认档是默认', () => {
    render(<SettingsPage />)

    expect(screen.getByTestId('font-small')).toHaveTextContent('小')
    expect(screen.getByTestId('font-default')).toHaveTextContent('默认')
    expect(screen.getByTestId('font-large')).toHaveTextContent('大')
    expect(screen.getByTestId('font-default')).toHaveAttribute('aria-pressed', 'true')
  })

  it('三档各切一遍 → html[data-font-size] 跟着走，落盘只带改动的字段', async () => {
    const bridge = installKyclawBridge()
    render(<SettingsPage />)

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
    render(<SettingsPage />)

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

    render(<SettingsPage />)

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().getAttribute('data-font-size')).toBe('large')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('font-large')).toHaveAttribute('aria-pressed', 'true')
  })
})
