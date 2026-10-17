import { expect, test } from '@playwright/test'
import type { ProviderConfig } from '../src/shared/providers'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * 009 布局探针（真 Electron；KYCLAW_012=1 才跑）：
 *
 *   pnpm build && KYCLAW_012=1 pnpm exec playwright test e2e/_r012-009-layout.spec.ts
 *
 * jsdom 只断言 DOM 兄弟关系，量不到 CSS；这里在真窗口里量 getBoundingClientRect：
 *   - 渠道名称独占上一行；
 *   - 模型名称与模型 ID 在 1280 与最小 720 宽下 top 对齐、宽度一致；
 * 并落两张截图到 testInfo。临时 userData 由 harness 创建，不碰真实 profile。
 */
const enabled = process.env.KYCLAW_012 === '1'

const DEEPSEEK: ProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  isDefault: true
}

interface Box {
  top: number
  left: number
  width: number
  height: number
}

async function rowBoxes(page: import('@playwright/test').Page): Promise<{
  name: Box
  displayName: Box
  modelId: Box
}> {
  return page.evaluate(() => {
    const box = (testId: string): Box => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      if (element === null) throw new Error(`找不到 ${testId}`)
      const rect = element.getBoundingClientRect()
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    }
    return {
      name: box('provider-deepseek-name'),
      displayName: box('provider-deepseek-display-name'),
      modelId: box('provider-deepseek-model')
    }
  })
}

test.describe('009 · 行内编辑布局（真 Electron 探针）', () => {
  test.skip(!enabled, 'KYCLAW_012=1 时才跑（需要 pnpm build 的 out/ 产物）')

  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('渠道名称独占上一行；模型名称与模型 ID 在 1280 / 720 宽下同一行', async ({}, testInfo) => {
    const launched = await launchApp({ settings: { providers: [DEEPSEEK] } })
    const { app, page } = launched

    try {
      await waitForChat(page)
      await page.evaluate(() => {
        window.location.hash = '#/settings/model'
      })
      const row = page.getByTestId('provider-deepseek')
      await expect(row).toBeVisible()
      await row.locator('button').first().click()
      await expect(page.getByTestId('provider-deepseek-display-name')).toBeVisible()
      // 等页面淡入与 TraceFold 展开过渡走完，截图才是稳定视觉（不是半透明中间帧）
      await page.waitForTimeout(400)

      for (const size of [
        { width: 1280, height: 800 },
        { width: 720, height: 480 }
      ]) {
        await app.evaluate(({ BrowserWindow }, next) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win.isMaximized()) win.unmaximize()
          win.setContentSize(next.width, next.height)
        }, size)

        await expect
          .poll(async () => {
            const boxes = await rowBoxes(page)
            return (
              Math.abs(boxes.displayName.top - boxes.modelId.top) <= 1 &&
              Math.abs(boxes.displayName.width - boxes.modelId.width) <= 1
            )
          })
          .toBe(true)

        const boxes = await rowBoxes(page)
        // 渠道名称在上一行（独占整行）：它的底边不晚于模型名称/ID 的顶边
        expect(boxes.name.top + boxes.name.height).toBeLessThanOrEqual(boxes.displayName.top + 1)
        expect(boxes.name.width).toBeGreaterThan(boxes.displayName.width)

        const shot = testInfo.outputPath(`model-row-${size.width}.png`)
        await page.screenshot({ path: shot })
        await testInfo.attach(`model-row-${size.width}`, { path: shot, contentType: 'image/png' })
      }
    } finally {
      await closeApp(launched)
    }
  })
})
