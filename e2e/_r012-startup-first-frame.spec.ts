import { expect, test } from '@playwright/test'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * 启动首帧探针（真 Electron；KYCLAW_012=1 才跑）：
 *
 *   pnpm build && KYCLAW_012=1 pnpm exec playwright test e2e/_r012-startup-first-frame.spec.ts
 *
 * 测试侧用 session.protocol 挂起**渲染端主 bundle 的加载**（HTML/CSS 正常放行），
 * 于是页面停在"壳已解析/已绘制、React 模块还没执行"的真实首帧：
 *   - #root 为空、documentElement 没有 data-theme（main.tsx 尚未执行）；
 *   - 启动壳可见，logo/wordmark/进度条有实际尺寸；
 *   - 截图 + 主进程 capturePage 像素统计证明不是全白；
 *   - 放行 bundle 后输入卡出现、启动壳移除。
 *
 * 临时 userData 由 harness 创建，不碰真实 profile。
 */
const enabled = process.env.KYCLAW_012 === '1'
const HOLD_MAIN_BUNDLE_MS = 10_000

test.describe('012 · 启动首帧（真 Electron 探针）', () => {
  test.skip(!enabled, 'KYCLAW_012=1 时才跑（需要 pnpm build 的 out/ 产物）')

  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('主 bundle 加载被挂起时，首帧是启动壳而不是全白', async ({}, testInfo) => {
    const launched = await launchApp({ settings: { theme: 'light' } })
    const { app, page } = launched

    try {
      await app.evaluate(async ({ BrowserWindow }, holdMs) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('没有主窗口')
        const session = win.webContents.session
        await session.clearCache()

        const pending: Array<() => void> = []
        let holding = true
        ;(
          globalThis as unknown as { __kyclawStartupProbeRelease?: () => void }
        ).__kyclawStartupProbeRelease = () => {
          holding = false
          for (const release of pending.splice(0)) release()
        }

        const filePathOf = (url: string): string => {
          const pathname = decodeURIComponent(new URL(url).pathname)
          return process.platform === 'win32' ? pathname.replace(/^\/([A-Za-z]:)/, '$1') : pathname
        }

        const intercepted = session.protocol.interceptFileProtocol('file', (request, callback) => {
          const isMainBundle =
            request.url.includes('/renderer/assets/') && request.url.endsWith('.js')
          if (!holding || !isMainBundle) {
            callback({ path: filePathOf(request.url) })
            return
          }

          let released = false
          const release = (): void => {
            if (released) return
            released = true
            callback({ path: filePathOf(request.url) })
          }
          const timer = setTimeout(release, holdMs)
          pending.push(() => {
            clearTimeout(timer)
            release()
          })
        })
        if (!intercepted) throw new Error('file 协议挂载失败')
      }, HOLD_MAIN_BUNDLE_MS)

      // 用 reloadIgnoringCache 保证主 bundle 重新走 file 请求（不被 code cache 直接命中）
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.reloadIgnoringCache()
      })

      const splash = page.locator('#app-splash')
      await expect(splash).toBeVisible()
      // React 模块尚未执行：根为空、主题属性还没写
      expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBe(0)
      expect(
        await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
      ).toBeNull()
      await expect(page.locator('.app-splash__status')).toHaveText('正在启动…')
      // 返工后的进度是确定的**阶段百分比**：bundle 还没执行时停在已完成的静态壳阶段（20%），
      // 不会按时间自己往前爬，也不是不定进度。
      const track = page.locator('.app-splash__track')
      await expect(track).toHaveAttribute('aria-label', '启动阶段进度')
      await expect(track).toHaveAttribute('data-progress-kind', 'stages')
      await expect(track).toHaveAttribute('aria-valuenow', '20')
      await expect(track).toHaveAttribute('aria-valuetext', '启动阶段 20%，正在启动…')
      await expect(page.locator('.app-splash__percent')).toHaveText('阶段 20%')
      await expect(page.locator('html')).toHaveAttribute(
        'data-startup-completed-stages',
        'shell-visible'
      )

      const layout = await page.evaluate(() => {
        const rect = (selector: string): { width: number; height: number; top: number } | null => {
          const element = document.querySelector<HTMLElement>(selector)
          if (element === null) return null
          const box = element.getBoundingClientRect()
          return { width: box.width, height: box.height, top: box.top }
        }
        const splashElement = document.querySelector<HTMLElement>('#app-splash')
        return {
          mark: rect('.app-splash__mark'),
          wordmark: rect('.app-splash__wordmark'),
          track: rect('.app-splash__track'),
          background:
            splashElement === null ? null : getComputedStyle(splashElement).backgroundColor
        }
      })

      expect(layout.background).toBe('rgb(251, 250, 249)')
      expect(layout.mark?.width ?? 0).toBeGreaterThan(20)
      expect(layout.mark?.height ?? 0).toBeGreaterThan(20)
      expect(layout.wordmark?.width ?? 0).toBeGreaterThan(20)
      expect(layout.track?.width ?? 0).toBeGreaterThan(50)

      // 主进程抓真实窗口像素：蓝 logo / 深色字标必须有像素，不是全白
      const pixels = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('没有主窗口')
        const image = await win.webContents.capturePage()
        const size = image.getSize()
        const bitmap = image.toBitmap()
        let colored = 0
        let dark = 0
        for (let index = 0; index + 3 < bitmap.length; index += 4) {
          const first = bitmap[index] ?? 0
          const second = bitmap[index + 1] ?? 0
          const third = bitmap[index + 2] ?? 0
          if (Math.max(first, second, third) - Math.min(first, second, third) > 40) colored += 1
          if (first + second + third < 480) dark += 1
        }
        return { width: size.width, height: size.height, colored, dark }
      })

      expect(pixels.width).toBeGreaterThan(0)
      expect(pixels.height).toBeGreaterThan(0)
      expect(pixels.colored).toBeGreaterThan(100)
      expect(pixels.dark).toBeGreaterThan(50)

      const shot = testInfo.outputPath('startup-shell-before-main-bundle.png')
      await page.screenshot({ path: shot })
      await testInfo.attach('startup-shell-before-main-bundle', {
        path: shot,
        contentType: 'image/png'
      })

      // 放行主 bundle：真首屏（输入卡）出现，启动壳移除
      await app.evaluate(() => {
        ;(
          globalThis as unknown as { __kyclawStartupProbeRelease?: () => void }
        ).__kyclawStartupProbeRelease?.()
      })
      await waitForChat(page)
      await expect(splash).toHaveCount(0)
    } finally {
      await app
        .evaluate(({ BrowserWindow }) => {
          ;(
            globalThis as unknown as { __kyclawStartupProbeRelease?: () => void }
          ).__kyclawStartupProbeRelease?.()
          BrowserWindow.getAllWindows()[0]?.webContents.session.protocol.uninterceptProtocol('file')
        })
        .catch(() => {})
      await closeApp(launched)
    }
  })
})
