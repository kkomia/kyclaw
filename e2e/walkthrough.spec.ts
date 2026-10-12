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
 * 本文件是取证件：几何硬值（圆角/缝/限宽/居中不变量）由样式契约 spec 钉住，这里不重复；
 * 只保留少量人工目视替代不了的断言（如 D 例的错误卡文案必须是人话）。
 * 观感结论写进 `docs/reviews/ui-walkthrough.md`（人工看截图 + 这些数值）。
 */
const OUT = resolve(__dirname, '..', '.superpowers/sdd/2026-10-10-kyclaw-mvp/smoke-t16/walkthrough')

type Metrics = Record<string, unknown>

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface ShellRead {
  viewport: { width: number; height: number }
  contentRegion: Box & { radius: string }
  contentColumn: Box
  sidebar: Box
  composer: Box
  messageList: Box
  railOffsetInList: number
  /** 可见左缘（--content-safe-left）：侧栏收起 0 / 展开 240 */
  safeLeft: number
  gaps: { right: number; bottom: number; columnLeftInRegion: number }
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
    const list = boxOf('[data-testid="message-list"]')
    const railRect =
      document.querySelector('[data-testid="message-rail"]')?.getBoundingClientRect() ?? null

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      contentRegion: {
        ...boxOf('[data-testid="content-region"]'),
        radius: region === null ? '' : getComputedStyle(region).borderTopLeftRadius
      },
      contentColumn: boxOf('.content-column'),
      sidebar: boxOf('[data-testid="sidebar"]'),
      composer: boxOf('[data-testid="composer"]'),
      messageList: list,
      railOffsetInList: railRect === null ? 0 : list.x + list.width - railRect.right,
      // 可见左缘（侧栏收起 = 0；展开 = 240）：内容卡左缘被侧栏盖住，看得到的是这条线。
      // 变量设在壳根（[data-sidebar]）上，不是 :root —— 必须从 app-root 读，读 html 只会拿到初始值 0
      safeLeft: Number.parseFloat(
        getComputedStyle(
          document.querySelector('[data-testid="app-root"]') as Element
        ).getPropertyValue('--content-safe-left')
      ),
      gaps: {
        right: regionRect === null ? 0 : window.innerWidth - regionRect.right,
        bottom: regionRect === null ? 0 : window.innerHeight - regionRect.bottom,
        columnLeftInRegion: regionRect === null ? 0 : boxOf('.content-column').x - regionRect.x
      }
    }
  })
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

/** 四角特写（40×40 CSS px 一块）：
 *  左右两对分别贴"内容卡右缘"与"可见左缘（--content-safe-left）"——侧栏展开时卡左缘被侧栏盖着，
 *  看得到的是它在可见左缘露出来的那条边（含 shell-notch 补角）；侧栏收起时就是卡自己的左缘。 */
async function shotCorners(page: Page, prefix: string): Promise<void> {
  const read = await readShell(page)
  const region = read.contentRegion
  await settle(page)
  const size = 40
  const left = region.x + read.safeLeft
  const corners: Array<[string, number, number]> = [
    ['左上', left, region.y],
    ['右上', region.x + region.width - size, region.y],
    ['左下', left, region.y + region.height - size],
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
      BrowserWindow.getAllWindows()[0]?.setBounds({ ...(size as { width: number }), height: 800 })
    },
    { width }
  )
  await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 4, width, {
    timeout: 10_000
  })
}

test.describe.configure({ mode: 'serial' })

test('走查A · 深色壳与聊天页（四角/缝/导览轨/composer/chips/工具流/Tooltip）', async () => {
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
  const { page } = launched
  const metrics: Metrics = {}

  try {
    await waitForChat(page)
    metrics.shell1280 = await readShell(page)
    await shot(page, 'A1-深色-聊天页-侧栏开')
    await shotCorners(page, 'A2-深色-1280-侧栏开')

    // 侧栏收起 → 内容列回到可见区居中
    await page.getByTestId('sidebar-toggle').click()
    await expect(page.getByTestId('sidebar')).toHaveClass(/is-collapsed/)
    await page.waitForTimeout(400)
    metrics.shell1280侧栏收起 = await readShell(page)
    await shot(page, 'A3-深色-侧栏收起')
    await shotCorners(page, 'A3b-深色-1280-侧栏收起')

    // 工作台展开（右栏并入内容卡，不是第三根柱子）
    await page.getByTestId('work-panel-toggle').click()
    await expect(page.getByTestId('work-panel')).toHaveClass(/is-open/)
    await page.waitForTimeout(400)
    metrics.shell1280工作台开 = await readShell(page)
    await shot(page, 'A4-深色-工作台展开')
    await page.getByTestId('work-panel-toggle').click()
    await page.getByTestId('sidebar-toggle').click()
    await page.waitForTimeout(400)

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
    await page.getByTestId('nav-settings').click()
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
    await page.getByTestId('nav-settings').click()
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

test('走查C · 窄窗退化 + 设置页/插件页（T5 走查项 / round 5+7）', async () => {
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
    metrics.shell1280 = await readShell(page)

    // 工作台兜底：1280 下主动开 → 收窄窗口 → 自动收起（--work-panel-collapse-width = 1120）
    await page.getByTestId('work-panel-toggle').click()
    await expect(page.getByTestId('work-panel')).toHaveClass(/is-open/)
    await shot(page, 'C1-工作台展开-1280')

    for (const width of [1100, 1000]) {
      await resizeTo(app, page, width)
      await page.waitForTimeout(450)
      metrics[`shell${width}`] = await readShell(page)
      metrics[`workPanelOpenAt${width}`] = await page
        .getByTestId('work-panel')
        .evaluate((element) => element.classList.contains('is-open'))
      await shot(page, `C2-窄窗${width}-工作台自动收起`)
    }
    metrics.workPanelWidthAt1000 = await page
      .getByTestId('work-panel')
      .evaluate((element) => element.getBoundingClientRect().width)
    await resizeTo(app, page, 1280)

    // 设置页（T5 走查项：内容列居中基准 + 左列设置菜单）
    await page.getByTestId('sidebar-menu-trigger').click()
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()
    metrics.settingsColumn = await readShell(page)
    await shot(page, 'C3-设置页-外观-1280-左列设置菜单')
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
    await shot(page, 'C4-插件页-MCP-列表与开关')

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
    await shot(page, 'C5-侧栏-新建会话与导航项')

    console.log('[走查C] metrics →', dump('C-窄窗与页面', metrics))
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
    await page.getByTestId('sidebar-menu-trigger').click()
    await page.getByTestId('nav-settings').click()
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
