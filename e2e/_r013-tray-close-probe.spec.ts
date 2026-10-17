import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { defaultSettings, type AppSettings } from '../src/shared/settings'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * 0.1.3 托盘驻留探针（不进常规 e2e 闸门；只在 KYCLAW_013_TRAY=1 时运行）：
 *
 *   pnpm build && KYCLAW_013_TRAY=1 pnpm exec playwright test e2e/_r013-tray-close-probe.spec.ts
 *
 * 三个真 Electron 场景（每例隔离 userData：临时 profile，不碰用户 %APPDATA%/kyclaw）：
 *
 *   1. **真聊天流在托盘里跑完**：本探针自带一个**本地 HTTP + SSE 脚本 provider**（`KYCLAW_FORCE_MOCK=0`，
 *      不是 mock 模型；正文的发送卡在闸门之后）——发一条消息 → 确认出站那一跳已经到达 provider
 *      （agent 任务链已经在跑）→ 点关闭（偏好 `tray`）把窗口收进托盘 → **隐藏之后**才放行正文 →
 *      断言回复文本在窗口隐藏期间落进 DOM（证明"后台任务不中断"的是真任务完成，不是渲染端心跳）；
 *      再恢复窗口 → 内容还在、还能输入 → `app.quit()` 放行。
 *   2. **托盘不可用回退**：偏好 `tray` + `KYCLAW_DISABLE_TRAY=1`（与"托盘建失败"同一条路）→
 *      点关闭照常关窗并退出应用，不会留下找不回来的后台进程。
 *   3. **选择题 + 记住 → 落盘 → 重启仍生效**：ask 档下用**注入的弹窗返回**（`KYCLAW_CLOSE_PROMPT`）
 *      选「最小化到托盘 + 记住我的选择」→ 窗口收进托盘且 `settings.json` 真写成 `tray`；重启
 *      （同一 profile）后点关闭仍直接收进托盘（不再问）；在 设置 → 外观 改成「直接退出」→ 点关闭
 *      即退出；再重启仍是 quit；最后改回「每次询问」→ 点关闭会**再次询问**（注入的是 cancel，
 *      窗口保持可见，且偏好不会被写坏）。
 *
 * 实际验证边界（不冒充）：
 *   - **原生 OS 弹窗没有人工点过**：它是 OS 级模态框，Playwright 操作不到。探针用
 *     `KYCLAW_CLOSE_PROMPT=tray[:remember]|quit[:remember]|cancel` 注入 dialog 的返回值，驱动的是
 *     **真实的** close 事件 → 落盘 → hide/quit 路径；弹窗文案 / 复选框默认不勾 / Esc=取消 由单测
 *     （src/main/__tests__/window-close.spec.ts）钉住。真人点弹窗留给人工走查。
 *   - 托盘的**原生右键菜单点击**同样自动化不到：恢复路径这里用主进程 `BrowserWindow.show()`
 *     （与托盘菜单「显示主窗口」同一个出口）；真菜单点击留给人工走查。
 *   - "窗口已隐藏"一律用**主进程** `BrowserWindow.isVisible()` 断言：本机实测窗口 `hide()`
 *     之后渲染端的 `document.visibilityState` 仍是 'visible'（两者不同步），不能用它当依据。
 *   - 托盘图标本身在不在通知区、图标长相，本探针不冒充（见 T16 走查证据）。
 *   - 探针只跑 `out/` 产物（先 `pnpm build`）；本文件自己建的临时 profile 跑完删除。
 */
const enabled = process.env.KYCLAW_013_TRAY === '1'

const repoRoot = resolve(__dirname, '..')

/** 脚本 provider 给出的整段回复（断言用的就是这一份原文） */
const REPLY_TEXT = '托盘探针：这条回复是在窗口收进托盘之后才写完的'

/**
 * 本地脚本 provider（本探针自带，不碰共享 fixture）：
 *   - `GET  /v1/models`           → 模型清单（启动探测会来问）；
 *   - `POST /v1/chat/completions` → `stream !== true`（模型探测 / 视觉探测 / 标题生成）立刻回一句；
 *     `stream === true` = 聊天流：**先不动**，等 `release()` 被调用才把正文发完（这样"回复落地"
 *     必然发生在关闭窗口之后——隐藏期间跑完的是真任务，不是心跳）。
 */
async function startScriptedProvider(): Promise<{
  url: string
  /** 等聊天流真的到达服务端（证明 agent 的链路已经跑到出站这一跳） */
  waitForChatRequest: (timeoutMs?: number) => Promise<void>
  /** 放行：让挂着的聊天流把正文发完 */
  release: () => void
  /** 到过几次聊天流（正常就是 1：一条消息一次流） */
  chatRequests: () => number
  close: () => Promise<void>
}> {
  let releaseGate: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  let chatArrived: () => void = () => {}
  const chatSeen = new Promise<void>((resolve) => {
    chatArrived = resolve
  })
  let chatRequests = 0
  let sequence = 0

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'tray-probe' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
    const id = `tray-probe-${++sequence}`

    if (body.stream !== true) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: 1,
          model: 'tray-probe',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
      return
    }

    chatRequests += 1
    chatArrived()
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frame = (delta: unknown, finish: string | null): void => {
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'tray-probe', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      )
    }
    // 闸门：release() 之前一个正文都不发（连接挂着，agent 那一侧就是在途任务）
    await released
    frame({ role: 'assistant', content: REPLY_TEXT }, null)
    frame({}, 'stop')
    response.end('data: [DONE]\n\n')
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('探针 provider 没绑上端口')

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    waitForChatRequest: (timeoutMs = 30_000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('聊天流没有到达脚本 provider（agent 那条链没跑起来）')),
          timeoutMs
        )
        void chatSeen.then(() => {
          clearTimeout(timer)
          resolve()
        })
      }),
    release: () => releaseGate(),
    chatRequests: () => chatRequests,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

/** 主进程侧：主窗口此刻的数量 / 可见 / 是否已销毁 */
function windowState(
  app: ElectronApplication
): Promise<{ count: number; visible: boolean; destroyed: boolean }> {
  return app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows()
    return {
      count: wins.length,
      visible: wins[0]?.isVisible() ?? false,
      destroyed: wins[0]?.isDestroyed() ?? true
    }
  })
}

/** 点关闭（等价于标题栏 X / Alt+F4：走同一个 window close 事件） */
async function closeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close()
  })
}

/** 主进程侧 show()：代替点不到的托盘菜单「显示主窗口」（同一个 showMainWindow 出口） */
async function showWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.show()
    win?.focus()
  })
}

/** 收起一个实例（已经退出的不抛） */
async function stopApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined)
}

/** 用一个**固定 profile** 起一次应用：重启验证要复用同一个 userData（harness 每次都给新 profile） */
async function launchWithProfile(
  profileDir: string,
  env: Record<string, string>
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${profileDir}`],
    cwd: repoRoot,
    env: { ...process.env, KYCLAW_FORCE_MOCK: '1', ...env } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** 写一份隔离 profile 的 settings.json（探针自用；`closeToTrayMode` 由各段自己决定） */
function writeProfileSettings(file: string, patch: Partial<AppSettings>): void {
  const settings: AppSettings = { ...defaultSettings(), ...patch }
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/** 落盘里的关闭偏好（`undefined` = 文件里没有这一项） */
function readCloseMode(file: string): unknown {
  return (JSON.parse(readFileSync(file, 'utf8')) as { closeToTrayMode?: unknown }).closeToTrayMode
}

test.describe('0.1.3 托盘驻留（关闭到托盘 / 托盘不可用回退）', () => {
  test.skip(!enabled, 'KYCLAW_013_TRAY=1 时才跑（需要 pnpm build 的 out/ 产物）')

  test('真聊天流：窗口收进托盘期间把回复跑完；恢复后内容还在、还能输入；app.quit 放行', async () => {
    test.setTimeout(3 * 60 * 1000)
    const provider = await startScriptedProvider()
    // 偏好预置成 tray（ask 档要弹原生模态框，Playwright 点不到——见文件头注）；
    // KYCLAW_FORCE_MOCK=0 + 脚本 provider = 走真模型那条链路（不是 mock 模型）
    const launched = await launchApp({
      settings: {
        closeToTrayMode: 'tray',
        semanticRecall: { ...defaultSettings().semanticRecall, enabled: false },
        providers: [
          {
            id: 'tray-probe',
            type: 'openai-compatible',
            baseUrl: provider.url,
            model: 'tray-probe',
            isDefault: true
          }
        ]
      },
      env: { KYCLAW_FORCE_MOCK: '0' }
    })
    const { app, page } = launched

    try {
      await waitForChat(page)
      await sendMessage(page, '托盘探针：这一条会在窗口收进托盘之后才收到回复')
      // 出站那一跳已经到：agent 的任务链活着（此刻窗口还开着，隐藏要发生在它之后）
      await provider.waitForChatRequest()

      await closeWindow(app)
      await expect
        .poll(() => windowState(app), { timeout: 20_000 })
        .toEqual({ count: 1, visible: false, destroyed: false })

      // 隐藏之后才放行正文：回复落地必然发生在"窗口在托盘里"的这段时间
      provider.release()
      await expect(page.getByTestId('message-text')).toHaveText(REPLY_TEXT, { timeout: 60_000 })
      // 落地之后、恢复之前再确认一次：窗口此刻仍是隐藏的（主进程口径）。
      // 注意**不用** `document.visibilityState`：本机实测窗口 `hide()` 之后它仍是 'visible'
      // （Electron 的页面可见性与窗口 hide 不同步），拿它断言会说反话
      await expect
        .poll(() => windowState(app), { timeout: 10_000 })
        .toEqual({ count: 1, visible: false, destroyed: false })
      expect(provider.chatRequests()).toBe(1)

      // 恢复：原生托盘菜单点不到，这里走主进程 show()（与托盘「显示主窗口」同一个出口）
      await showWindow(app)
      await expect
        .poll(() => windowState(app), { timeout: 20_000 })
        .toEqual({
          count: 1,
          visible: true,
          destroyed: false
        })
      // 隐藏期间落地的内容还在；窗口恢复后可输入
      await expect(page.getByTestId('message-text')).toHaveText(REPLY_TEXT)
      await page.getByTestId('composer-input').fill('托盘探针：恢复后还能输入')
      await expect(page.getByTestId('composer-input')).toHaveValue('托盘探针：恢复后还能输入')

      // 明确退出：app.quit 必须放行（"关闭到托盘"不许把退出吞掉）
      await app.evaluate(({ app: electronApp }) => electronApp.quit())
      await app.waitForEvent('close', { timeout: 60_000 })
    } finally {
      await closeApp(launched)
      await provider.close()
    }
  })

  test('托盘不可用（偏好 tray + KYCLAW_DISABLE_TRAY=1，同"托盘建失败"）：点关闭照常关窗退出', async () => {
    test.setTimeout(2 * 60 * 1000)
    const launched = await launchApp({
      settings: { closeToTrayMode: 'tray' },
      env: { KYCLAW_DISABLE_TRAY: '1' }
    })
    const { app, page } = launched

    try {
      await waitForChat(page)
      // 接线自检（真进程，红→绿用）：托盘驻留依赖的"更新退出"事件确实注册在 **Electron 原生
      // autoUpdater** 上（不是 electron-updater 那个包装实例），且这个对象在真环境里可用。
      // 只读：listenerCount 问的是有没有人接、接没接错对象。
      const wiring = await app.evaluate(({ autoUpdater }) => ({
        available: typeof autoUpdater?.on === 'function',
        listeners: autoUpdater?.listenerCount('before-quit-for-update') ?? -1
      }))
      expect(wiring.available).toBe(true)
      expect(wiring.listeners).toBeGreaterThanOrEqual(1)

      await closeWindow(app)
      // 窗口真关掉、应用真退出：不会留下找不回来的后台进程
      await app.waitForEvent('close', { timeout: 60_000 })
    } finally {
      await closeApp(launched)
    }
  })

  test('ask 档：勾「记住」→ 落盘 → 重启后 tray 生效 → 改成「直接退出」→ 退出 → 改回「每次询问」→ 再问', async () => {
    test.setTimeout(5 * 60 * 1000)
    // 重启验证需要**同一个 profile**：harness 每次给新目录，这里自己管一个（跑完删除）
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-r013-mode-'))
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    const settingsFile = join(profile, 'settings.json')
    writeProfileSettings(settingsFile, { closeToTrayMode: 'ask' })

    try {
      // ── 第一段：ask 档 + 注入「最小化到托盘 + 记住」→ 窗口收进托盘 + 偏好真落盘 ──────────
      const first = await launchWithProfile(profile, { KYCLAW_CLOSE_PROMPT: 'tray:remember' })
      try {
        await waitForChat(first.page)
        await closeWindow(first.app)
        await expect
          .poll(() => windowState(first.app), { timeout: 20_000 })
          .toEqual({ count: 1, visible: false, destroyed: false })
        // 内存态不算数：文件里真写成 tray（这是"记住"的唯一凭据）
        await expect.poll(() => readCloseMode(settingsFile), { timeout: 10_000 }).toBe('tray')
      } finally {
        await stopApp(first.app)
      }

      // ── 第二段：重启（同一 profile）。注入的是 cancel：如果还弹窗，窗口就不会被藏起来 ─────
      const second = await launchWithProfile(profile, { KYCLAW_CLOSE_PROMPT: 'cancel' })
      try {
        await waitForChat(second.page)
        await closeWindow(second.app)
        // tray 档生效：直接隐藏、没问过（问过的话注入的 cancel 会让窗口保持可见）
        await expect
          .poll(() => windowState(second.app), { timeout: 20_000 })
          .toEqual({ count: 1, visible: false, destroyed: false })

        // 真实 UI：设置 → 外观 改成「直接退出」（走 settings:update 补丁）
        await showWindow(second.app)
        await second.page.evaluate(() => {
          window.location.hash = '#/settings/appearance'
        })
        const quitChip = second.page.getByTestId('close-mode-quit')
        await quitChip.click()
        await expect(quitChip).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => readCloseMode(settingsFile), { timeout: 10_000 }).toBe('quit')

        // quit 档：点关闭即退出（注入的 cancel 在这条路上根本不会生效）
        const closed = second.app.waitForEvent('close', { timeout: 60_000 })
        await closeWindow(second.app)
        await closed
      } finally {
        await stopApp(second.app)
      }

      // ── 第三段：重启仍是 quit —— 点关闭即退出（偏好活过了重启） ────────────────────────
      const third = await launchWithProfile(profile, { KYCLAW_CLOSE_PROMPT: 'cancel' })
      try {
        await waitForChat(third.page)
        const closed = third.app.waitForEvent('close', { timeout: 60_000 })
        await closeWindow(third.app)
        await closed
      } finally {
        await stopApp(third.app)
      }

      // ── 第四段：重启 → 设置页改回「每次询问」→ 点关闭会再次询问（注入 cancel：窗口留着） ──
      const fourth = await launchWithProfile(profile, { KYCLAW_CLOSE_PROMPT: 'cancel' })
      try {
        await waitForChat(fourth.page)
        await fourth.page.evaluate(() => {
          window.location.hash = '#/settings/appearance'
        })
        const askChip = fourth.page.getByTestId('close-mode-ask')
        await askChip.click()
        await expect(askChip).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => readCloseMode(settingsFile), { timeout: 10_000 }).toBe('ask')

        await closeWindow(fourth.app)
        // ask 档：弹窗被问了（注入的 cancel）→ 窗口保持可见、应用没退；偏好也不会被写坏
        await expect
          .poll(() => windowState(fourth.app), { timeout: 20_000 })
          .toEqual({ count: 1, visible: true, destroyed: false })
        expect(readCloseMode(settingsFile)).toBe('ask')

        await fourth.app.evaluate(({ app: electronApp }) => electronApp.quit())
        await fourth.app.waitForEvent('close', { timeout: 60_000 })
      } finally {
        await stopApp(fourth.app)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
