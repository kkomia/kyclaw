import { beforeEach, describe, expect, it, vi } from 'vitest'

type ChangeListener = (event: MediaQueryListEvent) => void

/**
 * jsdom 不实现 matchMedia（jsdom 30 实测 typeof window.matchMedia === 'undefined'），
 * 所以这里装一个可手动触发 change 的假 MediaQueryList。
 */
function installMatchMedia(initialMatches: boolean): {
  matchMedia: ReturnType<typeof vi.fn>
  emit: (next: boolean) => void
  listenerCount: () => number
} {
  const listeners = new Set<ChangeListener>()
  let matches = initialMatches

  const query = {
    get matches() {
      return matches
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.add(listener)
    },
    removeEventListener: (type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.delete(listener)
    },
    addListener: (listener: ChangeListener) => {
      listeners.add(listener)
    },
    removeListener: (listener: ChangeListener) => {
      listeners.delete(listener)
    },
    dispatchEvent: () => true
  }

  const matchMedia = vi.fn(() => query)
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia

  return {
    matchMedia,
    emit(next: boolean) {
      matches = next
      const event = { matches: next, media: query.media } as MediaQueryListEvent
      for (const listener of [...listeners]) listener(event)
    },
    listenerCount: () => listeners.size
  }
}

async function loadTheme(): Promise<typeof import('@renderer/lib/theme')> {
  vi.resetModules()
  return await import('@renderer/lib/theme')
}

const html = (): HTMLElement => document.documentElement

beforeEach(() => {
  html().removeAttribute('data-theme')
  html().removeAttribute('data-font-size')
})

describe('initTheme', () => {
  it('默认跟随系统：系统浅色时写 data-theme="light"', async () => {
    installMatchMedia(false)
    const { initTheme } = await loadTheme()

    initTheme()

    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('默认跟随系统：系统深色时写 data-theme="dark"', async () => {
    installMatchMedia(true)
    const { initTheme } = await loadTheme()

    initTheme()

    expect(html().getAttribute('data-theme')).toBe('dark')
  })

  it('补默认字号档，但不覆盖已显式设置过的档', async () => {
    installMatchMedia(false)
    const { initTheme, setFontTier } = await loadTheme()

    initTheme()
    expect(html().getAttribute('data-font-size')).toBe('default')

    setFontTier('large')
    initTheme()
    expect(html().getAttribute('data-font-size')).toBe('large')
  })

  it('系统主题切换时跟随（matchMedia change 事件）', async () => {
    const media = installMatchMedia(false)
    const { initTheme } = await loadTheme()

    initTheme()
    expect(html().getAttribute('data-theme')).toBe('light')

    media.emit(true)
    expect(html().getAttribute('data-theme')).toBe('dark')

    media.emit(false)
    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('重复调用不叠加系统监听', async () => {
    const media = installMatchMedia(false)
    const { initTheme } = await loadTheme()

    initTheme()
    initTheme()
    initTheme()

    expect(media.listenerCount()).toBe(1)
  })

  it('环境没有 matchMedia 时不抛错，落到浅色', async () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia
    const { initTheme } = await loadTheme()

    expect(() => initTheme()).not.toThrow()
    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('跟随系统的判定口径是 prefers-color-scheme: dark', async () => {
    const media = installMatchMedia(false)
    const { initTheme } = await loadTheme()

    initTheme()

    expect(media.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
  })
})

describe('主进程解析主题（system 模式）', () => {
  it('解析值覆盖 matchMedia；matchMedia 滞后不会改写它', async () => {
    const media = installMatchMedia(false)
    const { initTheme, setResolvedNativeTheme } = await loadTheme()

    initTheme()
    expect(html().getAttribute('data-theme')).toBe('light')

    setResolvedNativeTheme('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')

    // 运行时切 themeSource 后 matchMedia 可能仍是旧值；以主进程推送为准
    media.emit(false)
    expect(html().getAttribute('data-theme')).toBe('dark')

    setResolvedNativeTheme('light')
    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('显式档忽略解析值；切回 system 后用最近一次解析值', async () => {
    installMatchMedia(false)
    const { setTheme, setResolvedNativeTheme } = await loadTheme()

    setTheme('dark')
    setResolvedNativeTheme('light')
    expect(html().getAttribute('data-theme')).toBe('dark')

    setTheme('system')
    expect(html().getAttribute('data-theme')).toBe('light')

    setResolvedNativeTheme('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')
  })
})

describe('setTheme', () => {
  it('显式档不跟随系统：setTheme("dark") 后系统变化不改写', async () => {
    const media = installMatchMedia(false)
    const { setTheme } = await loadTheme()

    setTheme('dark')

    expect(html().getAttribute('data-theme')).toBe('dark')
    media.emit(false)
    expect(html().getAttribute('data-theme')).toBe('dark')
  })

  it('显式浅色在系统深色下仍是浅色', async () => {
    installMatchMedia(true)
    const { setTheme } = await loadTheme()

    setTheme('light')

    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('切回 system 后立刻按当前系统值解析并继续跟随', async () => {
    const media = installMatchMedia(false)
    const { setTheme } = await loadTheme()

    setTheme('dark')
    setTheme('system')
    expect(html().getAttribute('data-theme')).toBe('light')

    media.emit(true)
    expect(html().getAttribute('data-theme')).toBe('dark')

    setTheme('light')
    media.emit(false)
    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('不依赖 initTheme，单独调用也生效', async () => {
    installMatchMedia(false)
    const { setTheme } = await loadTheme()

    setTheme('dark')

    expect(html().getAttribute('data-theme')).toBe('dark')
  })
})

describe('setFontTier', () => {
  it('写 html[data-font-size] 三档', async () => {
    installMatchMedia(false)
    const { setFontTier } = await loadTheme()

    setFontTier('small')
    expect(html().getAttribute('data-font-size')).toBe('small')

    setFontTier('default')
    expect(html().getAttribute('data-font-size')).toBe('default')

    setFontTier('large')
    expect(html().getAttribute('data-font-size')).toBe('large')
  })

  it('不触碰 data-theme', async () => {
    installMatchMedia(false)
    const { initTheme, setFontTier } = await loadTheme()

    initTheme()
    setFontTier('large')

    expect(html().getAttribute('data-theme')).toBe('light')
  })
})
