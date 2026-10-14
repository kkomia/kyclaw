import { expect, test } from '@playwright/test'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * 启动冒烟（plan T16 Step 1）：窗口真起来、三栏骨架在、标题栏按钮可用。
 * 断言分两层：渲染端（DOM 就位）+ 主进程（BrowserWindow 的尺寸/可见性/最大化状态）——
 * 只看 DOM 无法证明"真有个窗口"。
 */
test('启动：窗口出现、三栏骨架在、标题栏按钮可用', async () => {
  const launched = await launchApp()
  const { app, page } = launched

  try {
    await expect(page.getByTestId('app-root')).toBeVisible()
    await expect(page.getByTestId('titlebar')).toBeVisible()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('main-column')).toBeVisible()
    await waitForChat(page)

    for (const id of ['window-minimize', 'window-maximize', 'window-close']) {
      await expect(page.getByTestId(id)).toBeEnabled()
    }

    // 主进程侧：默认几何 1280×800（R15）、窗口可见、标题是应用名
    const window = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return {
        width: win?.getBounds().width,
        height: win?.getBounds().height,
        visible: win?.isVisible(),
        title: win?.getTitle()
      }
    })
    expect(window).toMatchObject({ visible: true, title: 'kyclaw' })
    // 几何不能要求逐像素相等：宿主显示缩放不是整数倍时（本机 225%），Windows/Chromium 会把窗口
    // 的物理像素取整，`getBounds()` 回来的 DIP 就差 1~2px（实测 1281×802，内容盒 1280×802；
    // 探针 `_r84-window-bounds-probe` 证到 scaleFactor=2.25）。所以比"默认 1280×800 ± 4"：
    // 换成别的几何默认值（1024×768 / 1440×900…）照样红，DPI 取整不误伤。
    expect(Math.abs((window.width ?? 0) - 1280)).toBeLessThanOrEqual(4)
    expect(Math.abs((window.height ?? 0) - 800)).toBeLessThanOrEqual(4)

    // 最大化按钮真的切状态（不是画着好看的）
    await page.getByTestId('window-maximize').click()
    await expect
      .poll(async () =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())
      )
      .toBe(true)
    await page.getByTestId('window-maximize').click()
    await expect
      .poll(async () =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())
      )
      .toBe(false)
  } finally {
    await closeApp(launched)
  }
})

test('关窗即退出（R14）：点标题栏关闭钮，应用整个退出', async () => {
  const launched = await launchApp()
  const { app, page } = launched

  try {
    await waitForChat(page)
    const pid = app.process().pid
    const stillAlive = (): boolean => {
      try {
        process.kill(pid as number, 0)
        return true
      } catch {
        return false
      }
    }

    const closed = app.waitForEvent('close')
    await page.getByTestId('window-close').click()
    await closed
    // 关窗 = 退出（Windows 口径）：进程真的没了，不是"窗口藏起来、托盘继续活着"
    await expect.poll(stillAlive).toBe(false)
  } finally {
    await closeApp(launched)
  }
})
