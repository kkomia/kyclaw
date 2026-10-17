import { describe, expect, it, vi } from 'vitest'
import type { ThemeMode } from '../../shared/settings'
import { createThemeBridge, type NativeThemeLike } from '../theme-bridge'

/**
 * 运行时主题链的执行回归（不 import electron）：
 * settings:update 的 onThemeSaved 最终落到这里 —— 先把 themeSource 写成新档（切回 system
 * 必须真的解除 light/dark 锁定），再按 shouldUseDarkColors 更新窗口底色；
 * nativeTheme.updated（系统主题变化）继续同步底色，窗口 destroyed 时不再写。
 */
function fakeNativeTheme(systemDark = false): NativeThemeLike & {
  setSystemDark: (dark: boolean) => void
  listenerCount: () => number
} {
  let source: ThemeMode = 'system'
  let systemDarkState = systemDark
  let dark = systemDark
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    get themeSource() {
      return source
    },
    set themeSource(next) {
      source = next
      dark = next === 'dark' ? true : next === 'light' ? false : systemDarkState
      notify()
    },
    get shouldUseDarkColors() {
      return dark
    },
    on(_event, listener) {
      listeners.add(listener)
    },
    off(_event, listener) {
      listeners.delete(listener)
    },
    setSystemDark(next) {
      systemDarkState = next
      if (source === 'system') {
        dark = next
        notify()
      }
    },
    listenerCount: () => listeners.size
  }
}

function fakeWindow(destroyed = false): {
  colors: string[]
  window: { isDestroyed: () => boolean; setBackgroundColor: (color: string) => void }
} {
  const colors: string[] = []
  return {
    colors,
    window: {
      isDestroyed: () => destroyed,
      setBackgroundColor: (color) => {
        colors.push(color)
      }
    }
  }
}

const COLORS = { light: '#fff', dark: '#111' }

describe('createThemeBridge（运行时主题）', () => {
  it('light → system：themeSource 真写回 system，窗口底色跟 shouldUseDarkColors', () => {
    const nativeTheme = fakeNativeTheme(false)
    const { colors, window } = fakeWindow()
    const bridge = createThemeBridge({ nativeTheme, getWindow: () => window, colors: COLORS })
    const stop = bridge.watchNativeTheme()

    bridge.applyThemeSource('light')
    expect(nativeTheme.themeSource).toBe('light')
    expect(colors.at(-1)).toBe('#fff')

    // 回归点：切回 system 不能继续停在 light
    bridge.applyThemeSource('system')
    expect(nativeTheme.themeSource).toBe('system')
    expect(colors.at(-1)).toBe('#fff')

    // system 下 OS 变深：updated → 窗口底色跟着变
    nativeTheme.setSystemDark(true)
    expect(colors.at(-1)).toBe('#111')
    stop()
  })

  it('watchNativeTheme 跟随 updated；cleanup 后不再写窗口', () => {
    const nativeTheme = fakeNativeTheme(false)
    const { colors, window } = fakeWindow()
    const bridge = createThemeBridge({ nativeTheme, getWindow: () => window, colors: COLORS })
    const stop = bridge.watchNativeTheme()

    expect(nativeTheme.listenerCount()).toBe(1)
    nativeTheme.setSystemDark(true)
    expect(colors.at(-1)).toBe('#111')

    stop()
    expect(nativeTheme.listenerCount()).toBe(0)
    const before = colors.length
    nativeTheme.setSystemDark(false)
    expect(colors.length).toBe(before)
  })

  it('显式档不依赖 themeSource → shouldUseDarkColors 的生效时序', () => {
    const nativeTheme: NativeThemeLike = {
      themeSource: 'system',
      shouldUseDarkColors: false,
      on: vi.fn(),
      off: vi.fn()
    }
    const { colors, window } = fakeWindow()
    const bridge = createThemeBridge({ nativeTheme, getWindow: () => window, colors: COLORS })

    bridge.applyThemeSource('dark')

    expect(nativeTheme.themeSource).toBe('dark')
    expect(colors.at(-1)).toBe('#111')
  })

  it('窗口已销毁时不写底色（也不会抛）', () => {
    const nativeTheme = fakeNativeTheme(false)
    const setBackgroundColor = vi.fn()
    const bridge = createThemeBridge({
      nativeTheme,
      getWindow: () => ({ isDestroyed: () => true, setBackgroundColor }),
      colors: COLORS
    })

    expect(() => bridge.applyThemeSource('dark')).not.toThrow()
    expect(nativeTheme.themeSource).toBe('dark')
    expect(setBackgroundColor).not.toHaveBeenCalled()
  })
})
