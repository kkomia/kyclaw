import type { ThemeMode } from '../shared/settings'

/**
 * nativeTheme 与主窗口底色的绑定：applyThemeSource 设置主题并同步底色；
 * watchNativeTheme 跟随 updated，返回清理函数。注入 nativeTheme/window 便于单测执行。
 */
export interface NativeThemeLike {
  themeSource: ThemeMode
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): void
  off(event: 'updated', listener: () => void): void
}

export interface ThemeWindowLike {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
}

export interface ThemeBridgeDeps {
  nativeTheme: NativeThemeLike
  /** 取当前主窗口（可能没有 / 已销毁） */
  getWindow: () => ThemeWindowLike | null
  colors: { light: string; dark: string }
}

export interface ThemeBridge {
  /** 对齐 themeSource（system/light/dark），并立刻按当前主题同步窗口底色 */
  applyThemeSource(theme: ThemeMode): void
  /** nativeTheme.updated 后的重同步（系统主题变化 / themeSource 生效） */
  syncWindowBackground(): void
  /** 挂 nativeTheme.updated；返回清理函数（窗口 closed 时调用） */
  watchNativeTheme(): () => void
}

export function createThemeBridge(deps: ThemeBridgeDeps): ThemeBridge {
  /** 当前应用主题（system/light/dark）—— updated 事件与 ready-to-show 重同步都要按它算 */
  let currentTheme: ThemeMode = 'system'

  const setWindowBackground = (dark: boolean): void => {
    const win = deps.getWindow()
    if (win === null || win.isDestroyed()) return
    win.setBackgroundColor(dark ? deps.colors.dark : deps.colors.light)
  }

  const syncWindowBackground = (): void => {
    // 显式档直接用主题本身（不依赖 themeSource 生效时序）；system 才读 OS 值。
    setWindowBackground(
      currentTheme === 'dark' || (currentTheme === 'system' && deps.nativeTheme.shouldUseDarkColors)
    )
  }

  return {
    applyThemeSource(theme) {
      // 关键：system 必须真的写回 'system'，否则运行中切「跟随系统」仍被启动档锁死
      currentTheme = theme
      deps.nativeTheme.themeSource = theme
      // themeSource 的 shouldUseDarkColors 更新晚一拍时，watchNativeTheme 的 updated 会再兜一次
      syncWindowBackground()
    },
    syncWindowBackground,
    watchNativeTheme() {
      deps.nativeTheme.on('updated', syncWindowBackground)
      return () => deps.nativeTheme.off('updated', syncWindowBackground)
    }
  }
}
