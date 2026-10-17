// @vitest-environment node
/**
 * 012（启动/运行主题接线）的源码级钉子（手法同 window-close-wiring.spec.ts）：
 * `window.ts` 会 import electron / icon.png?asset，vitest 里装不进来，所以读源码钉这些线：
 *
 *   1. 创建窗口前用 themeBridge 对齐落盘主题（system / light / dark）；
 *   2. 显式档按主题算首帧底色，system 才用 nativeTheme.shouldUseDarkColors；
 *   3. 运行中 settings:update 的 theme 经 index.ts 的 onThemeSaved → applyThemeMode；
 *   4. nativeTheme.updated 监听在窗口 closed 时清理。
 *
 * 真实执行链另由 `theme-bridge.spec.ts`（fake nativeTheme/window）和
 * `e2e/_r012-runtime-theme.spec.ts`（真 Electron）覆盖；真首帧观感仍见 e2e 探针边界。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const windowSource = readFileSync(new URL('../window.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('启动/运行主题的接线（源码级，012）', () => {
  it('创建窗口前把 themeBridge 对齐落盘主题', () => {
    const applyAt = windowSource.indexOf('themeBridge.applyThemeSource(')
    const windowAt = windowSource.indexOf('new BrowserWindow')

    expect(applyAt).toBeGreaterThan(-1)
    expect(windowAt).toBeGreaterThan(-1)
    expect(applyAt).toBeLessThan(windowAt)
  })

  it('窗口底色与启动壳同源：显式档按主题算，system 用 nativeTheme.shouldUseDarkColors', () => {
    expect(windowSource).toContain('backgroundColor: windowBackgroundFor(startupTheme)')
    expect(windowSource).toContain('nativeTheme.shouldUseDarkColors')
    // ready-to-show 露出前再同步一次（themeSource 生效晚一拍也不让首帧底色错）
    expect(windowSource).toContain('themeBridge.syncWindowBackground()')
  })

  it('运行中 theme 变化接到 applyThemeMode（不是只读启动值）', () => {
    expect(windowSource).toContain('export function applyThemeMode')
    expect(indexSource).toContain('onThemeSaved: applyThemeMode')
  })

  it('解析主题可查可推：effectiveTheme 查询 + themeChanged 推送 + updated 清理', () => {
    expect(windowSource).toContain('export function currentResolvedTheme')
    expect(windowSource).toContain('win.webContents.send(IPC_CHANNELS.settings.themeChanged')
    expect(indexSource).toContain('effectiveTheme: currentResolvedTheme')
    expect(windowSource).toContain("nativeTheme.on('updated', publishTheme)")
    expect(windowSource).toContain("nativeTheme.off('updated', publishTheme)")
  })

  it('nativeTheme.updated 监听在窗口 closed 时清理', () => {
    expect(windowSource).toContain('themeBridge.watchNativeTheme()')
    expect(windowSource).toContain('stopThemeWatch()')
    const watchAt = windowSource.indexOf('themeBridge.watchNativeTheme()')
    const stopAt = windowSource.indexOf('stopThemeWatch()')
    expect(watchAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(watchAt)
  })
})
