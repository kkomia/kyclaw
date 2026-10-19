import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat, type LaunchedApp } from './harness'

/**
 * UI 走查取证（plan T16 Step 4）：**给走查文档供截图与目视数值**，不是断言套件的主力。
 *
 * 每颗用例起一个隔离实例（userData 是临时目录），把状态摆到位 → 截图 + 量数值 → 落盘：
 *   - 截图：`.superpowers/.../smoke-t16/walkthrough/*.png`
 *   - 数值：同目录 `metrics-*.json`（读的是 computed style 与 getBoundingClientRect 的 CSS px）
 *
 * 2026-10-17 0.2.0 壳基线重写：旧的"覆盖层侧栏 / --content-safe-left / shell-notch"几何口径全部作废，
 * 现在是——一级导航固定 56 flow 栏；内容卡 = 壳行宽 − 右缘 --shell-edge-gap(6)；卡内 Sidebar(240/0)
 * + 主列 + 工作台；TitleBar 左=侧栏钮、中=（固定「主对话」标签 + 文档标签 + ＋）、右=窗控。
 * W7：窗口 < 782 时会话侧栏自动收起（布局事实，不改偏好）；设置/插件/记忆/用量在 ModuleHost 内，
 * 主对话切过去不卸载（草稿保留）。几何硬值由本文件的少量断言钉住，其余是取证数字。
 */
const OUT = resolve(__dirname, '..', '.superpowers/sdd/2026-10-10-kyclaw-mvp/smoke-t16/walkthrough')

/** 0.2.0 壳的固定几何（token 口径；断言用 ±1 容差吸收取整/设备像素比） */
const NAV_RAIL_WIDTH = 56
const SIDEBAR_WIDTH = 240
const SHELL_EDGE_GAP = 6
const WORK_PANEL_DEFAULT = 400
const CHAT_MIN_READABLE = 480
const TITLEBAR_HEIGHT = 42
/**
 * W7/D4=A 的自动收起阈值（窗口宽）：内容卡宽 − 侧栏标称宽 < 480 ⇒ 收起。
 * 卡宽 = 窗口 − 56 − 6；临界窗口 = 56 + 6 + 240 + 480 = 782。
 */
const SIDEBAR_AUTO_COLLAPSE_MAX_WINDOW = 782

type Metrics = Record<string, unknown>

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface ShellRead {
  viewport: { width: number; height: number }
  dataSidebar: string | null
  titlebar: Box
  primaryNav: Box
  appTabBar: Box
  shellRow: Box
  contentRegion: Box & { radius: string }
  sidebar: Box
  mainColumn: Box
  workPanel: Box & { open: boolean }
  contentColumn: Box
  composer: Box
  messageList: Box
  railOffsetInList: number
  gaps: { rightFromWindow: number; bottomFromWindow: number; rightFromRow: number }
}

/** 一次读完壳层几何（CSS px；都在渲染端算，避免设备像素比掺进来） */
async function readShell(page: Page): Promise<ShellRead> {
  return page.evaluate(() => {
    const boxOf = (selector: string): Box => {
      const element = document.querySelector(selector)
      if (element === null) return { x: 0, y: 0, width: 0, height: 0 }
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const region = document.querySelector('[data-testid="content-region"]')
    const regionRect = region?.getBoundingClientRect() ?? null
    const rowRect = document.querySelector('[data-testid="shell-row"]')?.getBoundingClientRect()
    const list = boxOf('[data-testid="message-list"]')
    const railRect =
      document.querySelector('[data-testid="message-rail"]')?.getBoundingClientRect() ?? null

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dataSidebar:
        document.querySelector('[data-testid="app-root"]')?.getAttribute('data-sidebar') ?? null,
      titlebar: boxOf('[data-testid="titlebar"]'),
      primaryNav: boxOf('[data-testid="primary-nav"]'),
      appTabBar: boxOf('[data-testid="app-tabbar"]'),
      shellRow: boxOf('[data-testid="shell-row"]'),
      contentRegion: {
        ...boxOf('[data-testid="content-region"]'),
        radius: region === null ? '' : getComputedStyle(region).borderTopLeftRadius
      },
      sidebar: boxOf('[data-testid="sidebar"]'),
      mainColumn: boxOf('[data-testid="main-column"]'),
      workPanel: {
        ...boxOf('[data-testid="work-panel"]'),
        open:
          document.querySelector('[data-testid="work-panel"]')?.classList.contains('is-open') ??
          false
      },
      contentColumn: boxOf('.content-column'),
      composer: boxOf('[data-testid="composer"]'),
      messageList: list,
      railOffsetInList: railRect === null ? 0 : list.x + list.width - railRect.right,
      gaps: {
        rightFromWindow: regionRect === null ? 0 : window.innerWidth - regionRect.right,
        bottomFromWindow: regionRect === null ? 0 : window.innerHeight - regionRect.bottom,
        rightFromRow:
          regionRect === null || rowRect === undefined ? 0 : rowRect.right - regionRect.right
      }
    }
  })
}

/** 几何断言（±1px，吸收取整/缩放；失败时 label 带上实测值） */
function expectNear(actual: number, expected: number, label: string, tolerance = 1): void {
  expect(
    Math.abs(actual - expected),
    `${label}: 实测 ${actual}，期望 ${expected}`
  ).toBeLessThanOrEqual(tolerance)
}

/** 1280 宽默认态（侧栏展开、工作台关）的壳几何断言 + 返回实测数字 */
async function expectDefault1280(page: Page): Promise<ShellRead> {
  const read = await readShell(page)
  // 窗口宽用实测值参与推导：Windows 缩放下 setBounds(1280) 的 innerWidth 可能差 1px 上下，
  // 真值锚在"窗口宽 − 导航 − 留缝"，而不是写死 1280。
  const viewportWidth = read.viewport.width
  expectNear(viewportWidth, 1280, '窗口宽', 2)
  const expectedRegionWidth = viewportWidth - NAV_RAIL_WIDTH - SHELL_EDGE_GAP
  expectNear(read.primaryNav.width, NAV_RAIL_WIDTH, '一级导航宽')
  expectNear(read.primaryNav.x, 0, '一级导航 x')
  expectNear(read.titlebar.height, TITLEBAR_HEIGHT, '顶栏高')
  expectNear(read.contentRegion.x, NAV_RAIL_WIDTH, '内容卡 x')
  expectNear(read.contentRegion.width, expectedRegionWidth, '内容卡宽')
  expect(read.contentRegion.radius, '内容卡圆角 20px').toBe('20px')
  expectNear(read.gaps.rightFromWindow, SHELL_EDGE_GAP, '卡右缘距窗口')
  expectNear(read.gaps.bottomFromWindow, SHELL_EDGE_GAP, '卡底距窗口')
  expect(read.dataSidebar, '1280 宽侧栏应展开').toBe('expanded')
  expectNear(read.sidebar.width, SIDEBAR_WIDTH, '侧栏宽')
  expectNear(read.sidebar.x, NAV_RAIL_WIDTH, '侧栏 x')
  expectNear(read.mainColumn.x, NAV_RAIL_WIDTH + SIDEBAR_WIDTH, '主列 x')
  expectNear(read.mainColumn.width, expectedRegionWidth - SIDEBAR_WIDTH, '主列宽')
  expect(read.workPanel.open).toBe(false)
  expectNear(read.workPanel.width, 0, '工作台关着时不占宽')
  // 一级导航只有图标：按钮文字一个都不能有（可访问名走 aria-label / title）
  const navLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="primary-nav"] button'))
      .map((button) => button.textContent?.trim() ?? '')
      .filter((label) => label !== '')
  )
  expect(navLabels).toEqual([])
  return read
}

/** hover 反馈：hover 前 / 后各读一次底色，并回填"确实处于 :hover"与 token 真值 */
async function hoverFeedback(
  page: Page,
  selector: string
): Promise<{ before: string; after: string; hovered: boolean; token: string }> {
  const locator = page.locator(selector).first()
  const read = (): Promise<string> =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor)
  const before = await read()
  await locator.hover()
  await page.waitForTimeout(200)
  const after = await read()
  const hovered = await locator.evaluate((element) => element.matches(':hover'))
  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-hover')
  )
  return { before, after, hovered, token }
}

function dump(tag: string, metrics: Metrics): string {
  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, `metrics-${tag}.json`)
  writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8')
  return file
}

/** 等进场/过渡动效跑完（截图别拍到动画中间帧）；持续运行的动效（流式光标）不硬等 */
async function settle(page: Page, timeout = 1200): Promise<void> {
  await page
    .waitForFunction(() => document.getAnimations().every((one) => one.playState !== 'running'), {
      timeout
    })
    .catch(() => {})
  await page.waitForTimeout(120)
}

async function shot(page: Page, name: string, options: { settle?: boolean } = {}): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  if (options.settle !== false) await settle(page)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

async function shotElement(page: Page, selector: string, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await settle(page)
  await page
    .locator(selector)
    .first()
    .screenshot({ path: join(OUT, `${name}.png`) })
}

/** 四角特写（40×40 CSS px 一块）：0.2.0 内容卡左缘不再被覆盖层盖住，四角都直接可见 */
async function shotCorners(page: Page, prefix: string): Promise<void> {
  const read = await readShell(page)
  const region = read.contentRegion
  await settle(page)
  const size = 40
  const corners: Array<[string, number, number]> = [
    ['左上', region.x, region.y],
    ['右上', region.x + region.width - size, region.y],
    ['左下', region.x, region.y + region.height - size],
    ['右下', region.x + region.width - size, region.y + region.height - size]
  ]
  for (const [label, x, y] of corners) {
    await page.screenshot({
      path: join(OUT, `${prefix}-角-${label}.png`),
      clip: { x, y, width: size, height: size }
    })
  }
}

/** 收窗口到指定宽度（Electron 侧改几何；等渲染端 innerWidth 跟到位再继续） */
async function resizeTo(app: LaunchedApp['app'], page: Page, width: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('没有主窗口')
      if (win.isMaximized()) win.unmaximize()
      win.setBounds({ x: 40, y: 40, width: size.width, height: 800 })
    },
    { width }
  )
  await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 4, width, {
    timeout: 10_000
  })
  // 宽度过渡（--motion-main 0.3s）+ 自动降级的 layout effect 落地
  await page.waitForTimeout(500)
}

/** 侧栏/工作台宽度（等过渡收尾后读，避免读到动画中间帧） */
async function readWidth(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((element) => element.getBoundingClientRect().width)
}

/** 等某元素宽度收敛到期望值（±1） */
async function expectWidth(
  page: Page,
  testId: string,
  expected: number,
  label: string
): Promise<void> {
  await expect
    .poll(() => readWidth(page, testId), { timeout: 5_000, message: label })
    .toBeLessThanOrEqual(expected + 1)
  await expect
    .poll(() => readWidth(page, testId), { timeout: 5_000, message: label })
    .toBeGreaterThanOrEqual(Math.max(0, expected - 1))
}

test.describe.configure({ mode: 'serial' })

test('走查A · 深色壳与聊天页（0.2.0 几何 / 四角 / 缝 / 导览轨 / composer / 工具流 / Tooltip）', async () => {
  // 旧 mock 的 `[[write:…]]` 内联工具触发已随旧 mock 下架；0.2.0 内核 stub 无此语法 → 工具流/审批卡无法造。
  // 证据：trace 最后一步等 `approval-card`（nia/walkthrough-180s.log）；按 a 组显式 skip，见 PB-021。
  test.skip(true, '旧 mock 内联工具触发（[[write:…]]）已下架，0.2.0 内核无此语法，见 PB-021')
  const rootDir = mkdtempSync(join(tmpdir(), 'kyclaw-walk-a-'))
  const workspace = join(rootDir, '走查工作区')
  mkdirSync(workspace, { recursive: true })

  const launched: LaunchedApp = await launchApp({
    settings: {
      theme: 'dark',
      workspaces: [{ path: workspace, mode: 'ask' }],
      // 模型 chip 只在这一条 provider 存在时才有得看（无 provider 时界面刻意不摆空控件）；
      // KYCLAW_FORCE_MOCK=1 下这轮对话仍走 mock（R3），不读密钥、不出网
      providers: [
        {
          id: 'deepseek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          isDefault: true
        }
      ]
    }
  })
  const { app, page } = launched
  const metrics: Metrics = {}

  try {
    await waitForChat(page)
    await resizeTo(app, page, 1280)
    metrics.shell1280 = await expectDefault1280(page)
    await shot(page, 'A1-深色-聊天页-1280-壳几何基线')
    await shotCorners(page, 'A2-深色-1280-侧栏开')

    // 侧栏折叠钮（0.2.0：卡内宽度动画收 0；主列是它的 flex 兄弟，会左移并用满卡宽）
    await page.getByTestId('sidebar-toggle').click()
    await expectWidth(page, 'sidebar', 0, '侧栏收起后宽度')
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
    const collapsed = await readShell(page)
    const collapsedCard = collapsed.viewport.width - NAV_RAIL_WIDTH - SHELL_EDGE_GAP
    expectNear(collapsed.mainColumn.x, NAV_RAIL_WIDTH, '收起后主列 x')
    expectNear(collapsed.mainColumn.width, collapsedCard, '收起后主列宽')
    expect(collapsed.sidebar).toHaveProperty('width', 0)
    metrics.shell1280侧栏收起 = collapsed
    await shot(page, 'A3-深色-侧栏收起-主列铺满卡')
    await shotCorners(page, 'A3b-深色-1280-侧栏收起')

    // 工作台展开（右栏并入内容卡，不是第三根柱子；侧栏收起时剩余宽 1218−400 ≥ 480 ⇒ 并排）
    await page.getByTestId('work-panel-toggle').click()
    await expect(page.getByTestId('work-panel')).toHaveClass(/is-open/)
    await expectWidth(page, 'work-panel', WORK_PANEL_DEFAULT, '工作台宽度')
    expect(await page.getByTestId('work-panel').getAttribute('data-fullscreen-source')).toBe('none')
    const panelOpen = await readShell(page)
    const cardRight = panelOpen.viewport.width - SHELL_EDGE_GAP
    expectNear(panelOpen.workPanel.x, cardRight - WORK_PANEL_DEFAULT, '工作台 x')
    expectNear(
      panelOpen.mainColumn.width,
      cardRight - NAV_RAIL_WIDTH - WORK_PANEL_DEFAULT,
      '工作台开时主列宽'
    )
    metrics.shell1280工作台开 = panelOpen
    await shot(page, 'A4-深色-工作台展开')

    // 收起面板 + 展开侧栏，回到默认三列
    await page.getByTestId('work-panel-toggle').click()
    await page.getByTestId('sidebar-toggle').click()
    await expectWidth(page, 'sidebar', SIDEBAR_WIDTH, '侧栏恢复宽度')
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')

    // 三轮：第一条纯文本、第二条触发 write（审批 → 允许）、第三条纯文本 → 导览轨三节点
    await sendMessage(page, '第一条：先打个招呼')
    // 流式中的样子（停止钮 + 逐段上屏）——先截这一张，再等收尾
    await expect(page.getByTestId('message-text').last()).toContainText('（kyclaw 离线模式）', {
      timeout: 20_000
    })
    await shot(page, 'A4b-深色-流式中-停止钮', { settle: false })
    await expect(page.getByTestId('message-text').last()).toContainText('我是 kyclaw。', {
      timeout: 20_000
    })

    await sendMessage(page, '第二条：帮我写个文件 [[write:走查-demo.txt]]')
    await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 30_000 })
    // 工具流进场（T3/T7 走查项）：这一张不等动效结束，拍"刚长出来"的样子
    await shot(page, 'A5a-深色-工具流-进场（未等动效）', { settle: false })
    await shot(page, 'A5-深色-工具流-等待审批')
    metrics.approvalTarget = await page.getByTestId('approval-target').innerText()

    // Tooltip 深底（R10 走查项）：审批卡上的路径就是 Tooltip 触发点
    await page.getByTestId('approval-target').hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toBeVisible()
    metrics.tooltip = await tooltip.evaluate((element) => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, color: style.color, radius: style.borderRadius }
    })
    await shotElement(page, '[role="tooltip"]', 'A6-深色-Tooltip-深底')

    await page.getByTestId('approval-allow-once').click()
    await expect(page.getByTestId('tool-card')).toHaveAttribute('data-state', 'output-available', {
      timeout: 30_000
    })
    await expect.poll(() => existsSync(join(workspace, '走查-demo.txt'))).toBe(true)
    await shot(page, 'A7-深色-工具完成')

    await sendMessage(page, '第三条：收到，回个收尾')
    await expect(page.getByTestId('message-text').last()).toContainText('我是 kyclaw。', {
      timeout: 20_000
    })

    // 导览轨（默认 / hover / 跳转）
    const rail = page.getByTestId('message-rail')
    await expect(rail).toBeVisible()
    metrics.railOffsetInList = (await readShell(page)).railOffsetInList
    metrics.railNodes = await page.locator('[data-testid^="rail-node-"]').count()
    await shotElement(page, '[data-testid="message-rail"]', 'A8-深色-导览轨-默认')

    await rail.hover()
    await expect(page.getByTestId('rail-panel')).toHaveAttribute('data-open', 'true')
    await shot(page, 'A9-深色-导览轨-hover-摘要')
    await shotElement(page, '[data-testid="rail-panel"]', 'A10-深色-导览轨-摘要面板')

    // 跳转：点第一条 → 消息列滚回顶部，当前节点换成第一节点
    const firstUser = page.locator('[data-role="user"]').first()
    const firstMessageId = String(await firstUser.getAttribute('data-testid')).replace(
      'message-',
      ''
    )
    await page.getByTestId(`rail-item-${firstMessageId}`).click()
    await expect(page.getByTestId(`rail-node-${firstMessageId}`)).toHaveAttribute(
      'aria-current',
      'true'
    )
    await expect
      .poll(() => page.getByTestId('message-list').evaluate((element) => element.scrollTop))
      .toBeLessThan(60)
    metrics.scrollTopAfterJump = await page
      .getByTestId('message-list')
      .evaluate((element) => element.scrollTop)
    await shot(page, 'A11-深色-导览轨-跳回第一条')

    // composer 触发钮 hover 灰底（round 7 走查项）：＋ 与权限 chip
    metrics.plusBg = await hoverFeedback(page, '[data-testid="composer-plus"]')
    await shotElement(page, '[data-testid="composer"]', 'A12-深色-composer-plus-hover灰底')
    metrics.permissionBg = await hoverFeedback(page, '[data-testid="composer-permission"]')
    await shotElement(page, '[data-testid="composer"]', 'A13-深色-权限chip-hover灰底')

    metrics.permissionChip = await page.getByTestId('composer-permission').innerText()
    metrics.modelChip = await page.getByTestId('composer-model').innerText()
    metrics.composer = (await readShell(page)).composer
    metrics.sendButton = await page.getByTestId('composer-send').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const icon = element.querySelector('svg')?.getBoundingClientRect()
      return {
        size: { width: rect.width, height: rect.height },
        iconSize: icon === undefined ? null : { width: icon.width, height: icon.height }
      }
    })

    // 深色菜单玻璃（R9 走查项的另一半：浅色在走查B 量了，这里量深色档）
    await page.getByTestId('sidebar-menu-trigger').click()
    const darkMenu = page.locator('[role="menu"]').first()
    await expect(darkMenu).toBeVisible()
    metrics.menuDark = await darkMenu.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        backdropFilter: style.backdropFilter,
        radius: style.borderRadius,
        shadow: style.boxShadow
      }
    })
    await shotElement(page, '[role="menu"]', 'A14-深色-菜单')

    // 深色主按钮 hover（R11 的另一半：浅色在走查B 量了）；菜单开着直接点「设置」（不再 Escape 重开：
    // Radix 菜单 Escape 关闭后紧接着再点触发器，第二次不弹——走查时踩到过一次）
    await page.getByTestId('primary-nav-settings').click()
    await page.getByTestId('settings-nav-model').click()
    // round 48：已配置的模型默认折叠，编辑区要先点开那一行才有「保存」
    await page.getByTestId('provider-deepseek').click()
    const darkSave = page.getByTestId('provider-deepseek-save')
    await expect(darkSave).toBeVisible()
    metrics.primaryButtonDark = await hoverFeedback(page, '[data-testid="provider-deepseek-save"]')
    await shot(page, 'A15-深色-设置-模型页-主按钮')

    console.log('[走查A] metrics →', dump('A-深色', metrics))
  } finally {
    await closeApp(launched)
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('走查B · 浅色菜单玻璃与主按钮 hover（R9 / R11）', async () => {
  const launched = await launchApp({ settings: { theme: 'light' } })
  const { page } = launched
  const metrics: Metrics = {}

  try {
    await waitForChat(page)
    await shot(page, 'B1-浅色-聊天页-侧栏开')

    // 菜单玻璃（R9 走查项）：侧栏底部菜单，量底色 / 玻璃层 / 圆角
    await page.getByTestId('sidebar-menu-trigger').click()
    const menu = page.locator('[role="menu"]').first()
    await expect(menu).toBeVisible()
    metrics.menu = await menu.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        backdropFilter: style.backdropFilter,
        radius: style.borderRadius,
        shadow: style.boxShadow
      }
    })
    await shotElement(page, '[role="menu"]', 'B2-浅色-菜单')

    // 浅色主按钮 hover（R11 走查项）：设置 → 模型 → 加一条自定义 provider，量保存钮的底色变化
    // （round 48：渠道收进「新增」弹窗的渠道下拉里，不再铺在页面上）
    await page.getByTestId('primary-nav-settings').click()
    await page.getByTestId('settings-nav-model').click()
    await page.getByTestId('model-add').click()
    await page.getByTestId('model-add-channel').click()
    await page.getByTestId('model-add-channel-custom-openai-compatible').click()
    await page.getByTestId('model-add-model').fill('walkthrough-model')
    await page.getByTestId('model-add-base-url').fill('https://example.com/v1')
    await page.getByTestId('model-add-submit').click()
    // 新行自动展开，保存钮就在眼前
    const save = page.getByTestId('provider-custom-1-save')
    await expect(save).toBeVisible()
    metrics.primaryButtonLight = await hoverFeedback(page, '[data-testid="provider-custom-1-save"]')
    await shotElement(page, '[data-testid="provider-custom-1"]', 'B3-浅色-主按钮-hover')

    console.log('[走查B] metrics →', dump('B-浅色', metrics))
  } finally {
    await closeApp(launched)
  }
})

/**
 * 走查C · 0.2.0 壳窄窗三档 + W7/D4=A 真机验收
 *   1280 / 900：侧栏展开（900：838 − 240 = 598 ≥ 480）
 *   720（最小窗）：658 − 240 = 418 < 480 ⇒ 自动收起；放宽后按用户偏好恢复
 * 另含工作台窄窗铺满（round 77 口径不变）与设置/插件页。
 */
test('走查C · 窄窗三档（720/900/1280）+ W7 自动收起 + 工作台铺满 + 设置/插件页', async () => {
  const launched = await launchApp({
    settings: {
      theme: 'dark',
      mcpServers: [
        {
          id: 'echo',
          name: '回显服务',
          transport: 'stdio',
          command: 'node',
          args: ['echo.mjs'],
          enabled: false,
          readOnlyTools: []
        },
        {
          id: 'remote',
          name: '远程地址',
          transport: 'http',
          url: 'http://',
          enabled: false,
          readOnlyTools: []
        }
      ]
    }
  })
  const { page, app, userDataDir } = launched
  const metrics: Metrics = {}

  try {
    await waitForChat(page)
    await resizeTo(app, page, 1280)
    await expectDefault1280(page)
    metrics.shell1280 = await readShell(page)

    // 900：838 − 240 = 598 ≥ 480 ⇒ 侧栏仍展开
    await resizeTo(app, page, 900)
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')
    await expectWidth(page, 'sidebar', SIDEBAR_WIDTH, '900 宽侧栏宽')
    const at900 = await readShell(page)
    const at900Card = at900.viewport.width - NAV_RAIL_WIDTH - SHELL_EDGE_GAP
    expectNear(at900.contentRegion.width, at900Card, '900 内容卡宽')
    metrics.shell900 = at900
    await shot(page, 'C1-窄窗900-侧栏展开')

    // 720（窗口最小宽）：658 − 240 = 418 < 480 ⇒ 自动收起（布局事实，不动偏好）
    await resizeTo(app, page, 720)
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
    await expectWidth(page, 'sidebar', 0, '720 宽侧栏自动收起')
    const at720 = await readShell(page)
    const at720Card = at720.viewport.width - NAV_RAIL_WIDTH - SHELL_EDGE_GAP
    expectNear(at720.mainColumn.x, NAV_RAIL_WIDTH, '720 自动收起后主列 x')
    expectNear(at720.mainColumn.width, at720Card, '720 主列宽')
    expectNear(at720.contentRegion.width, at720Card, '720 内容卡宽')
    expect(at720.contentColumn.width).toBeGreaterThanOrEqual(CHAT_MIN_READABLE)
    // 开合钮显示真实布局态（自动收起 → "展开侧栏"）
    await expect(page.getByTestId('sidebar-toggle')).toHaveAccessibleName('展开侧栏')
    metrics.shell720自动收起 = at720
    metrics.windowThreshold = { autoCollapseBelow: SIDEBAR_AUTO_COLLAPSE_MAX_WINDOW }
    await shot(page, 'C2-窄窗720-侧栏自动收起')

    // W7 真机：720 下点开合钮 —— 只改用户偏好，布局仍保持自动收起（auto 只压"手动展开"）
    await page.getByTestId('sidebar-toggle').click()
    await page.waitForTimeout(500)
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
    await expectWidth(page, 'sidebar', 0, '720 点开合钮后仍收起')
    metrics.clickAt720 = { stillCollapsed: true }

    // 放宽到 1280：用户此刻的偏好是"收起"（刚才那一下），所以侧栏保持收起 —— 偏好被尊重
    await resizeTo(app, page, 1280)
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
    await expectWidth(page, 'sidebar', 0, '1280 保持用户手动收起')
    metrics.afterWiden = { stillCollapsed: true }

    // 再点一次回到展开；继续后面的工作台窄窗检查
    await page.getByTestId('sidebar-toggle').click()
    await expectWidth(page, 'sidebar', SIDEBAR_WIDTH, '1280 恢复展开')
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')

    // 工作台窄窗兜底（round 77 口径不变）：1280 下主动开 → 收窄窗口 → 不关面板，改成临时铺满
    await page.getByTestId('work-panel-toggle').click()
    await expect(page.getByTestId('work-panel')).toHaveClass(/is-open/)
    await shot(page, 'C3-工作台展开-1280')

    for (const width of [1100, 1000]) {
      await resizeTo(app, page, width)
      metrics[`shell${width}`] = await readShell(page)
      metrics[`workPanelOpenAt${width}`] = await page
        .getByTestId('work-panel')
        .evaluate((element) => element.classList.contains('is-open'))
      metrics[`workPanelFullscreenSourceAt${width}`] = await page
        .getByTestId('work-panel')
        .getAttribute('data-fullscreen-source')
      // 面板没关（is-open 仍真），但改成铺满：聊天让位、不挤压
      await expect(page.getByTestId('work-panel')).toHaveAttribute('data-fullscreen-source', 'auto')
      await expect(page.getByTestId('main-column')).toHaveClass(/hidden/)
      await shot(page, `C4-窄窗${width}-工作台铺满内容区`)
    }
    metrics.workPanelWidthAt1000 = await readWidth(page, 'work-panel')
    await resizeTo(app, page, 1280)
    // 拉回宽窗：自动恢复分栏（中列回来）
    await expect(page.getByTestId('main-column')).not.toHaveClass(/hidden/)

    // 设置页（T5 走查项：内容列居中基准 + 左列设置菜单；W7：主对话不卸载）
    await page.getByTestId('primary-nav-settings').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()
    metrics.settingsColumn = await readShell(page)
    // W7 新口径：进设置不再卸载常驻 ChatPage（草稿/滚动保活）
    await expect(page.getByTestId('chat-page')).toHaveCount(1)
    await expect(page.getByTestId('module-chat')).toHaveClass(/hidden/)
    await shot(page, 'C5-设置页-外观-1280-左列设置菜单')
    metrics.navItem = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="settings-nav-appearance"]')
      if (nav === null) return null
      const rect = nav.getBoundingClientRect()
      const icon = nav.querySelector('svg')?.getBoundingClientRect()
      return {
        rect: { x: rect.x, width: rect.width, height: rect.height },
        paddingLeft: getComputedStyle(nav).paddingLeft,
        iconSize: icon === undefined ? null : { width: icon.width, height: icon.height }
      }
    })

    // 插件页：行式 MCP 列表 + 开关（round 7 走查项）+ 半截地址的行内 problems
    await page.getByTestId('settings-back').click()
    await page.getByTestId('nav-plugins').click()
    await expect(page.getByTestId('plugins-page')).toBeVisible()
    await page.getByTestId('plugins-tab-mcp').click()
    const row = page.getByTestId('mcp-server-0')
    await expect(row).toBeVisible()
    metrics.插件行 = await row.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { height: rect.height, radius: getComputedStyle(element).borderRadius }
    })
    metrics.开关 = {
      ariaChecked: await page.getByTestId('mcp-server-0-enable').getAttribute('aria-checked'),
      accessibleName: await page.getByTestId('mcp-server-0-enable').getAttribute('aria-label')
    }
    metrics.半截地址problems = await page.getByTestId('mcp-server-1-problems').innerText()
    await shot(page, 'C6-插件页-MCP-列表与开关')

    // 开关真的落盘（读隔离 userData 里的 settings.json：启用了就得写进去）
    await page.getByTestId('mcp-server-0-enable').click()
    await expect(page.getByTestId('mcp-server-0-enable')).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => {
        const stored = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as {
          mcpServers: Array<{ id: string; enabled: boolean }>
        }
        return stored.mcpServers.find((server) => server.id === 'echo')?.enabled
      })
      .toBe(true)
    metrics.开关落盘 = true

    // 新建会话块按钮（T5 走查项：图标/高度）
    await page.getByTestId('new-session').hover()
    metrics.newSession = await page.getByTestId('new-session').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        width: rect.width,
        height: rect.height,
        iconSize: element.querySelector('svg')?.getBoundingClientRect().width ?? null
      }
    })
    await shot(page, 'C7-侧栏-新建会话与导航项')

    console.log('[走查C] metrics →', dump('C-窄窗与页面', metrics))
  } finally {
    await closeApp(launched)
  }
})

/**
 * 走查E · 0.2.0 顶栏标签栏 + W7 设置往返草稿（2026-10-17 新增）
 *   - 固定「主对话」标签：常驻、不可关（没有关闭钮、Ctrl+W 也关不到）
 *   - 打开示例文档后：文档标签渲染在 TitleBar 内；Office 页内不再有旧标签条（office-tabs）
 *   - 切模块（笔记/知识库/Office）与设置往返：同一个 ChatPage 节点、草稿保留
 */
test('走查E · 顶栏标签栏 + 设置往返草稿保留（W7 真机验收）', async () => {
  const launched = await launchApp({ settings: { theme: 'light' } })
  const { app, page } = launched
  const metrics: Metrics = {}

  try {
    await waitForChat(page)
    await resizeTo(app, page, 1280)
    const titlebar = page.getByTestId('titlebar')
    const tabbar = page.getByTestId('app-tabbar')
    await expect(tabbar).toBeVisible()
    expect(await titlebar.getByTestId('app-tabbar').count()).toBe(1)
    // 固定「主对话」标签在、且不可关：标签栏里**没有**关闭钮（文档标签数为 0 时）
    await expect(page.getByTestId('app-tab-chat')).toBeVisible()
    await expect(page.getByTestId('app-tab-chat')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('app-tab-close')).toHaveCount(0)
    // Ctrl+W 关不到「主对话」（没有文档标签时 Ctrl+W 不拦、也不动聊天）——只记录，不制造关窗风险
    metrics.fixedChatTab = { present: true, closable: false }

    // 切模块往返：同一个 ChatPage 节点 + 草稿保留（0.2.0 既有口径）
    const draft = '走查E草稿｜切到笔记、设置再回来，这段字应该还在'
    await page.getByTestId('composer-input').fill(draft)
    await page.evaluate(() => {
      const chat = document.querySelector<HTMLElement>('[data-testid="chat-page"]')
      if (chat !== null) chat.dataset.probe = 'chat-alive'
    })
    await page.getByTestId('primary-nav-notes').click()
    await expect(page.getByTestId('notes-page')).toBeVisible()
    await expect(page.getByTestId('module-chat')).toHaveClass(/hidden/)
    await page.getByTestId('primary-nav-knowledge').click()
    await expect(page.getByTestId('knowledge-page')).toBeVisible()
    await page.getByTestId('primary-nav-chat').click()
    await expect(page.getByTestId('module-chat')).not.toHaveClass(/hidden/)
    expect(await page.getByTestId('composer-input').inputValue()).toBe(draft)
    metrics.moduleSwitch = {
      sameChatPage: await page.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="chat-page"]')?.dataset.probe ??
          'missing'
      ),
      draftPreserved: true
    }

    // W7 设置往返：进设置时 ChatPage 只 hidden+inert、不卸载；回来草稿仍在
    await page.getByTestId('primary-nav-settings').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()
    await expect(page.getByTestId('module-chat')).toHaveClass(/hidden/)
    await expect(page.getByTestId('module-chat')).toHaveAttribute('inert')
    expect(await page.getByTestId('composer-input').inputValue()).toBe(draft)
    await shot(page, 'E1-设置页-1280-主对话常驻')
    await page.getByTestId('primary-nav-chat').click()
    await expect(page.getByTestId('module-chat')).not.toHaveClass(/hidden/)
    const draftAfterSettings = await page.getByTestId('composer-input').inputValue()
    expect(draftAfterSettings).toBe(draft)
    expect(
      await page.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="chat-page"]')?.dataset.probe ??
          'missing'
      )
    ).toBe('chat-alive')
    metrics.settingsRoundtrip = {
      chatPageNodePreserved: true,
      draftPreserved: draftAfterSettings === draft
    }
    await shot(page, 'E2-设置往返后-主对话草稿仍在')

    // 顶栏标签栏：打开 Office 示例文档 → 文档标签渲染在 TitleBar 内
    await page.getByTestId('primary-nav-office').click()
    await expect(page.getByTestId('office-page')).toBeVisible()
    await expect(page.getByTestId('office-empty')).toBeVisible()
    // Office 页内不再有旧标签条
    await expect(page.getByTestId('office-tabs')).toHaveCount(0)
    await shot(page, 'E3-Office空态-1280')

    await page.getByTestId('office-open').click()
    await page.getByTestId('office-mock-open-docx').click()
    await expect(page.getByTestId('office-workspace')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('app-tab-add').click()
    await page.getByTestId('office-mock-open-pptx').click()
    await expect(page.getByTestId('app-tab')).toHaveCount(2, { timeout: 15_000 })
    expect(await titlebar.getByTestId('app-tab').count()).toBe(2)
    // 固定聊天标签仍在、文档标签各有关闭钮（>0 说明关闭只属于文档标签）
    await expect(page.getByTestId('app-tab-chat')).toBeVisible()
    expect(await page.getByTestId('app-tab-close').count()).toBe(2)
    metrics.officeTabs = {
      count: await page.getByTestId('app-tab').count(),
      inTitlebar: (await titlebar.getByTestId('app-tab').count()) === 2,
      oldOfficeTabBar: await page.getByTestId('office-tabs').count(),
      chatTabStillFixed: true
    }
    await shot(page, 'E4-Office二标签-顶栏标签栏')

    // 回主对话：草稿仍在、文档标签保留（标签不绑会话/模块）
    await page.getByTestId('app-tab-chat').click()
    await expect(page.getByTestId('module-chat')).not.toHaveClass(/hidden/)
    expect(await page.getByTestId('composer-input').inputValue()).toBe(draft)
    await expect(page.getByTestId('app-tab')).toHaveCount(2)
    await expect(page.getByTestId('app-tab-chat')).toHaveAttribute('aria-selected', 'true')

    console.log('[走查E] metrics →', dump('E-标签栏与W7', metrics))
  } finally {
    await closeApp(launched)
  }
})

test('走查D · 换机解密失败抽查（密文解不开 → 需要重新录入，不崩不泄）', async () => {
  const launched = await launchApp({
    settings: {
      theme: 'dark',
      providers: [
        {
          id: 'deepseek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          isDefault: true
        }
      ]
    },
    // 密文坏掉（换机/换账户的样子）：结构合法、内容解不开 —— 与真实 userData 里"改坏一字节"同类
    secrets: { deepseek: Buffer.from('not-a-real-ciphertext').toString('base64') },
    env: { KYCLAW_FORCE_MOCK: '0' }
  })
  const { page } = launched
  const metrics: Metrics = {}

  try {
    await waitForChat(page)

    // 设置页模型栏：行内状态 = 需要重新录入（不是"已配置"）
    await page.getByTestId('primary-nav-settings').click()
    await page.getByTestId('settings-nav-model').click()
    await expect(page.getByTestId('provider-deepseek')).toBeVisible()
    // round 48：密钥状态与重录引导都在展开区里，先点开这一行
    await page.getByTestId('provider-deepseek').click()
    // 密钥状态是异步读出来的：先等它从"读取中…"落定再取值（T16②：抓早会把加载态当结论）
    const keyStatus = page.getByTestId('provider-deepseek-key-status')
    await expect(keyStatus).toHaveText('需要重新录入', { timeout: 15_000 })
    metrics.keyStatus = await keyStatus.innerText()
    metrics.reentryText = await page.getByTestId('provider-deepseek-reentry').innerText()
    await shot(page, 'D1-解密失败-需要重新录入')

    // 不泄：密文（原文与 base64）不许出现在页面文本里
    metrics.密文泄漏 = await page.evaluate(
      ([raw, base64]) => {
        const text = document.body.innerText
        return { raw: text.includes(raw as string), base64: text.includes(base64 as string) }
      },
      ['not-a-real-ciphertext', Buffer.from('not-a-real-ciphertext').toString('base64')] as const
    )
    expect(metrics.密文泄漏).toEqual({ raw: false, base64: false })

    // 不崩：密钥不可用 → 这一轮以错误卡收场（不静默回落 mock）
    await page.getByTestId('settings-back').click()
    await page.getByTestId('new-session').click()
    await sendMessage(page, '密钥没了还能聊吗')
    const errorCard = page.getByTestId('error-card')
    await expect(errorCard).toBeVisible({ timeout: 30_000 })
    metrics.errorCardText = await errorCard.innerText()
    // C-1（雷点 2.2）：错误卡是人话——不是后端原文/JSON blob，且有可执行指引（去设置里补齐）
    expect(metrics.errorCardText).not.toContain('Internal Server Error')
    expect(metrics.errorCardText).not.toContain('{')
    expect(metrics.errorCardText).toContain('密钥')
    expect(metrics.errorCardText).toContain('设置')
    await shot(page, 'D2-解密失败-聊天错误卡')

    console.log('[走查D] metrics →', dump('D-解密失败', metrics))
  } finally {
    await closeApp(launched)
  }
})
