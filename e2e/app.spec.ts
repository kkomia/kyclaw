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

    // ready-to-show 可能晚于 DOM 可交互：等窗口真正可见后再读主进程侧几何
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
      )
      .toBe(true)

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

/**
 * 0.2.1（PB-053 + 泛化）：0.2.x 把 8 条宿主 API（含会话↔项目映射、用量、记忆、轨迹…）下架成
 * 501 feature-disabled；**旧数据不兼容、直接舍弃**。回归钉三件事：
 *   ① 侧栏不再画「项目加载失败 + 重试」（曾经每次启动都出现，重试永远失败）；
 *   ② 依赖旧映射的项目入口（侧栏项目区 / 初始页「选择项目」胶囊）整体不出现；
 *   ③ 其它下架功能（首页热力图 / 用量页）只给中性「本版暂不可用」，不画红字、不给重试。
 */
test('下架功能/旧数据（PB-053）：界面不报「加载失败」，项目入口不出现，用量/热力图中性', async () => {
  const launched = await launchApp({
    settings: {
      projects: [
        {
          id: 'p-old',
          name: '旧项目',
          path: 'D:\\legacy-project',
          createdAt: '2026-10-11T00:00:00.000Z'
        }
      ],
      archivedProjects: [
        {
          projectId: 'p-old',
          name: '旧项目',
          path: 'D:\\legacy-project',
          archivedAt: '2026-10-11T00:00:00.000Z'
        }
      ],
      pinnedProjects: ['p-old']
    }
  })
  const { page } = launched

  try {
    await waitForChat(page)

    // ① 不再有那条假的加载失败（红字 + 重试）
    await expect(page.getByTestId('project-error')).toHaveCount(0)
    await expect(page.getByText('项目加载失败', { exact: false })).toHaveCount(0)

    // ② 依赖旧映射的入口不出现：初始页的项目胶囊、侧栏项目区的两个创建入口
    await expect(page.getByTestId('composer-project')).toHaveCount(0)
    await expect(page.getByTestId('composer-project-row')).toHaveCount(0)
    await expect(page.getByText('使用现有文件夹', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('new-session')).toBeVisible()

    // ③ 首页热力图（/api/usage/calendar 501）：中性说明，没有「读取失败」红字/重试
    await page.getByTestId('new-session').click()
    await expect(page.getByTestId('welcome-heatmap-unavailable')).toBeVisible()
    await expect(page.getByTestId('welcome-heatmap-error')).toHaveCount(0)
    await expect(page.getByText('读取失败', { exact: false })).toHaveCount(0)

    // ④ 用量页（/api/usage 501）：中性不可用块，不是错误行
    await page.evaluate(() => {
      location.hash = '#/usage'
    })
    await expect(page.getByTestId('usage-unavailable')).toBeVisible()
    await expect(page.getByTestId('usage-error')).toHaveCount(0)
    await expect(page.getByTestId('usage-retry')).toHaveCount(0)

    // 设置页「用量」栏复用同一块面板，同样不报错
    await page.evaluate(() => {
      location.hash = '#/settings/usage'
    })
    await expect(page.getByTestId('usage-unavailable')).toBeVisible()
    await expect(page.getByTestId('usage-error')).toHaveCount(0)
  } finally {
    await closeApp(launched)
  }
})

test('关窗到托盘（R14 换口径）：偏好「最小化到托盘」时点关闭钮 → 窗口隐藏不销毁、应用继续活着', async () => {
  // 偏好直接预置成 tray：ask 档要弹原生模态框（Playwright 点不到），它的三种选择与
  // 「记住我的选择」落盘由 src/main/__tests__/window-close.spec.ts 钉住、
  // 真注入路径的端到端验证见 e2e/_r013-tray-close-probe.spec.ts 头注
  const launched = await launchApp({ settings: { closeToTrayMode: 'tray' } })
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

    await page.getByTestId('window-close').click()

    // 窗口还在，只是藏进托盘；进程照旧活着（后台任务继续跑）
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const wins = BrowserWindow.getAllWindows()
          return {
            count: wins.length,
            visible: wins[0]?.isVisible() ?? false,
            destroyed: wins[0]?.isDestroyed() ?? true
          }
        })
      )
      .toEqual({ count: 1, visible: false, destroyed: false })
    expect(stillAlive()).toBe(true)
  } finally {
    await closeApp(launched)
  }
})

test('关窗即退出（偏好「直接退出」）：点关闭钮 → 应用整个退出', async () => {
  // 用户明确选了"直接退出"：点关闭就是正常关闭（window-all-closed → 退出），不进托盘
  const launched = await launchApp({ settings: { closeToTrayMode: 'quit' } })
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
    await expect.poll(stillAlive).toBe(false)
  } finally {
    await closeApp(launched)
  }
})

test('关窗即退出（R14，托盘不可用）：偏好「最小化到托盘」但托盘建不起来时点关闭钮，应用整个退出', async () => {
  // 托盘是"关闭到托盘"唯一的找回入口：建不起来就整条关掉（tray 档也不能把窗口藏到没有入口的后台）
  const launched = await launchApp({
    settings: { closeToTrayMode: 'tray' },
    env: { KYCLAW_DISABLE_TRAY: '1' }
  })
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
    // 进程真的没了（不是"窗口藏起来、托盘继续活着"）
    await expect.poll(stillAlive).toBe(false)
  } finally {
    await closeApp(launched)
  }
})
