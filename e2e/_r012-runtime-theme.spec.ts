import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * 运行时主题探针（真 Electron；KYCLAW_012=1 才跑）：
 *
 *   pnpm build && KYCLAW_012=1 pnpm exec playwright test e2e/_r012-runtime-theme.spec.ts
 *
 * 启动落盘 light → 设置里切「跟随系统」必须把 nativeTheme.themeSource 写回 'system'，
 * 并让主进程窗口底色、Chromium prefers-color-scheme 与渲染端 data-theme 一致。
 * 再互切 dark/light 验证显式档。临时 userData 由 harness 创建；不碰真实 profile。
 */
const enabled = process.env.KYCLAW_012 === '1'

interface ThemeState {
  source: string
  dark: boolean
  background: string
}

async function themeState(app: ElectronApplication): Promise<ThemeState> {
  return app.evaluate(({ BrowserWindow, nativeTheme }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return {
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors,
      background: win.getBackgroundColor()
    }
  })
}

/** getBackgroundColor 可能带 alpha；只比 RGB 六位 */
function backgroundHex(state: ThemeState): string {
  return state.background.toLowerCase().slice(0, 7)
}

async function rendererTheme(
  page: Page
): Promise<{ dataTheme: string | null; prefersDark: boolean }> {
  return page.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute('data-theme'),
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches
  }))
}

async function openAppearance(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings/appearance'
  })
  await expect(page.getByTestId('theme-system')).toBeVisible()
}

/** 主进程 themeSource / 窗口底色 / 渲染端 data-theme 一致（运行时 media query 可能滞后，UI 走主进程推送） */
async function consistentWithSource(
  app: ElectronApplication,
  page: Page,
  source: 'system' | 'light' | 'dark'
): Promise<boolean> {
  const main = await themeState(app)
  const renderer = await rendererTheme(page)
  const expectedBackground = main.dark ? '#181817' : '#fbfaf9'
  const expectedTheme = main.dark ? 'dark' : 'light'
  return (
    main.source === source &&
    backgroundHex(main) === expectedBackground &&
    renderer.dataTheme === expectedTheme
  )
}

test.describe('012 · 运行时主题（真 Electron 探针）', () => {
  test.skip(!enabled, 'KYCLAW_012=1 时才跑（需要 pnpm build 的 out/ 产物）')

  test('启动 light → 切 system 解除 nativeTheme 锁定；dark/light 互切底色一致', async () => {
    const launched = await launchApp({ settings: { theme: 'light' } })
    const { app, page, userDataDir } = launched

    try {
      await waitForChat(page)

      // 启动落盘 light：nativeTheme 被强制 light，窗口底色/渲染端都应是 light
      await expect.poll(async () => (await themeState(app)).source).toBe('light')
      const initial = await themeState(app)
      expect(initial.dark).toBe(false)
      expect(backgroundHex(initial)).toBe('#fbfaf9')
      await expect.poll(async () => consistentWithSource(app, page, 'light')).toBe(true)

      await openAppearance(page)
      await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('theme-system').click()

      // 切回 system 后 themeSource 必须是 'system'，且三处主题同步
      await expect
        .poll(async () => consistentWithSource(app, page, 'system'), { timeout: 15_000 })
        .toBe(true)
      const system = await themeState(app)
      expect(system.source).toBe('system')
      expect(backgroundHex(system)).toBe(system.dark ? '#181817' : '#fbfaf9')

      // 落盘也真的写成 system（不是只改了内存）
      await expect
        .poll(() => {
          try {
            return JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).theme
          } catch {
            return null
          }
        })
        .toBe('system')

      // 显式 dark：themeSource/底色/data-theme 全部转深
      await page.getByTestId('theme-dark').click()
      await expect.poll(async () => (await themeState(app)).source).toBe('dark')
      await expect.poll(async () => consistentWithSource(app, page, 'dark')).toBe(true)
      expect(backgroundHex(await themeState(app))).toBe('#181817')

      // 显式 light：全部转浅
      await page.getByTestId('theme-light').click()
      await expect.poll(async () => (await themeState(app)).source).toBe('light')
      await expect.poll(async () => consistentWithSource(app, page, 'light')).toBe(true)
      expect(backgroundHex(await themeState(app))).toBe('#fbfaf9')

      // 再从 light 切回 system：第二次也必须是 system（防止只在首切时碰巧对）
      await page.getByTestId('theme-system').click()
      await expect
        .poll(async () => consistentWithSource(app, page, 'system'), { timeout: 15_000 })
        .toBe(true)
    } finally {
      await closeApp(launched)
    }
  })
})
