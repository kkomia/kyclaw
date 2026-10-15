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
    // 几何不能要求逐像素相等，两件事叠加（都为实测，别读成"默认值变了"）：
    //   ① 宿主显示缩放不是整数倍时（本机 225%），Windows/Chromium 会把窗口的物理像素取整，
    //      `getBounds()` 回来的 DIP 就差 1~2px（实测宽 1282，内容盒 1280；scaleFactor=2.25）；
    //   ② **窗口永远放不进工作区**：本机主屏 1280×800 DIP（物理 2880×1800 @225%），
    //      工作区只有 1280×752（任务栏占掉 48）—— 默认要的 800 高放不下，OS 把它夹到工作区
    //      （实测 getBounds 753 高、内容盒 752）。这是宿主环境（显示器/任务栏）使然。
    // 所以比的是「默认 1280×800 夹到工作区」± 4（DPI 取整）：工作区比默认大时，这一条就是
    // 1280×800 那一档；默认值本身由 `src/main/__tests__/store.spec.ts` 的 DEFAULT_WINDOW_STATE 钉着
    // （换成 1024×768 / 1440×900… 那两处照样红）。
    const display = await app.evaluate(({ screen }) => {
      const primary = screen.getPrimaryDisplay()
      return { workArea: primary.workArea, scaleFactor: primary.scaleFactor }
    })
    const expectedWidth = Math.min(1280, display.workArea.width)
    const expectedHeight = Math.min(800, display.workArea.height)
    const geometry =
      `实际 ${window.width}×${window.height}，期望 ${expectedWidth}×${expectedHeight}` +
      `（工作区 ${display.workArea.width}×${display.workArea.height}，缩放 ${display.scaleFactor}）`
    expect(
      Math.abs((window.width ?? 0) - expectedWidth),
      `窗口宽：${geometry}`
    ).toBeLessThanOrEqual(4)
    expect(
      Math.abs((window.height ?? 0) - expectedHeight),
      `窗口高：${geometry}`
    ).toBeLessThanOrEqual(4)

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
