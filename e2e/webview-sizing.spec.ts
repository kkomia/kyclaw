/**
 * 内嵌浏览器（工作台「浏览器」）：**客人 viewport 必须跟住 `<webview>` 的盒**。
 *
 * 起因是 ui-final 外观截图的一个 P1 误判：样例页正文不换行、右缘被裁，看着像"客人 viewport 没跟盒"。
 * 独立探针（`.superpowers/ui-final/probe-capture-instrumented.mjs`）把两件事分开了：
 *   - 真 Electron 里，客人 viewport 一直等于 webview 的 `clientWidth/clientHeight`（本 spec 守的就是它）；
 *   - 那个裁切是 Playwright `page.screenshot()`（CDP 抓帧）在抓帧那一瞬间把客人顶成**整窗大小**
 *     弄出来的假象 —— 客人里挂的 resize 记录器：静止 800ms 的对照组为空，
 *     而抓帧一次就记到 `["1280x800","400x648"]`；宿主 `capturePage()`（屏幕上真画的那一帧）一直是对的。
 *     ui-final 的落盘已改走宿主 `webContents.capturePage()`（见 `capture.mjs` 的 `screenshotWindow`）。
 *
 * 所以这里断言的是**不变量 + 视觉症状的直接反例**，不是"截图看着对"：
 *   - 四个时刻（导航后 / 窗口收窄到 800 铺满 / 面板隐藏 / 面板重开）客人 viewport == webview 盒尺寸；
 *   - 窄盒里正文**必须换行**（首段行数 ≥ 2）。这条是那个症状的反例：客人一旦被按更宽的 viewport
 *     排版，行数就掉回 1 —— 只验尺寸相等会漏掉"盒和客人一起错"的情形。
 *
 * 本地一次性 HTTP fixture（127.0.0.1 随机口，仅内存、不外连）；实例走 harness 的独立 userData。
 */
import { createServer } from 'node:http'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp, launchApp, waitForChat, type LaunchedApp } from './harness'

/** 客人里跑的取数：viewpor 尺寸 + 首段盒（行数 = 高 / line-height） */
const GUEST_PROBE = [
  'JSON.stringify((() => {',
  '  const p = document.querySelector("main p")',
  '  const lineHeight = p ? parseFloat(getComputedStyle(p).lineHeight) : 0',
  '  const rect = p ? p.getBoundingClientRect() : null',
  '  return {',
  '    innerWidth: innerWidth,',
  '    innerHeight: innerHeight,',
  '    lines: rect && lineHeight ? Math.round(rect.height / lineHeight) : 0',
  '  }',
  '})())'
].join('\n')

const FIXTURE_TITLE = '尺寸样例页'
const FIXTURE_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  `<title>${FIXTURE_TITLE}</title>`,
  '<style>body{margin:0;font:14px/1.7 system-ui,"Segoe UI",sans-serif}main{padding:16px}</style>',
  '</head><body><main>',
  '<p>这一段刻意写得很长：它是"正文必须在窄盒里换行"的那条判据。一旦客人被按更宽的 viewport 排版，这一行就会长过盒子、被右缘裁掉，行数掉回一行。</p>',
  '<p>整页由 e2e/webview-sizing.spec.ts 起的一次性本地 HTTP 服务给出（127.0.0.1，仅内存），不外连。</p>',
  '</main></body></html>'
].join('\n')

/** 窄盒判据：首段按 14px 排单行约 600px，盒子窄于这个宽度就必须折成多行 */
const NARROW_BOX_MAX = 700

interface Sizing {
  boxWidth: number
  boxHeight: number
  guestWidth: number
  guestHeight: number
  lines: number
}

async function measure(app: ElectronApplication, page: Page): Promise<Sizing> {
  const box = await page.evaluate(() => {
    const node = document.querySelector('webview') as HTMLElement | null
    if (node === null) throw new Error('浏览器面板里没有 webview')
    return { width: node.clientWidth, height: node.clientHeight }
  })
  const webContentsId = await page.evaluate(() => {
    const node = document.querySelector('webview') as
      (HTMLElement & { getWebContentsId?: () => number }) | null
    return node?.getWebContentsId?.() ?? null
  })
  if (webContentsId === null) throw new Error('拿不到客人 webContents id（webview 还没挂上？）')

  const guest = await app.evaluate(
    async ({ webContents }, payload) => {
      const contents = webContents.fromId(payload.id)
      if (contents == null) throw new Error(`没有 id=${payload.id} 的 webContents`)
      const raw = (await contents.executeJavaScript(payload.probe)) as string
      return JSON.parse(raw) as { innerWidth: number; innerHeight: number; lines: number }
    },
    { id: webContentsId, probe: GUEST_PROBE }
  )

  return {
    boxWidth: box.width,
    boxHeight: box.height,
    guestWidth: guest.innerWidth,
    guestHeight: guest.innerHeight,
    lines: guest.lines
  }
}

/** 等客人跟到位（渲染端改盒 → 客人 resize 是异步的），然后核对不变量与"窄盒必换行" */
async function expectGuestFollowsBox(
  app: ElectronApplication,
  page: Page,
  label: string
): Promise<Sizing> {
  let latest = await measure(app, page)
  await expect
    .poll(
      async () => {
        latest = await measure(app, page)
        return (
          Math.abs(latest.guestWidth - latest.boxWidth) <= 1 &&
          Math.abs(latest.guestHeight - latest.boxHeight) <= 1
        )
      },
      { timeout: 8_000, message: `${label}：客人 viewport 没跟住 webview 盒` }
    )
    .toBe(true)

  if (latest.boxWidth < NARROW_BOX_MAX) {
    expect(
      latest.lines,
      `${label}：盒子宽 ${latest.boxWidth}px 却没换行（首段 ${latest.lines} 行）——正文按更宽的 viewport 排版了`
    ).toBeGreaterThanOrEqual(2)
  }
  return latest
}

test.describe('内嵌浏览器 · 客人 viewport 跟住 webview 盒', () => {
  test.setTimeout(120_000)

  test('导航 / 收窄铺满 / 面板隐藏再开：客人 viewport == 盒尺寸，且窄盒里正文换行', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIXTURE_HTML)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`

    let launched: LaunchedApp | null = null
    try {
      launched = await launchApp()
      const { app, page } = launched
      await waitForChat(page)

      const resizeWindow = async (width: number): Promise<void> => {
        await app.evaluate(
          ({ BrowserWindow }, size) => {
            BrowserWindow.getAllWindows()[0]?.setBounds({
              ...(size as { width: number }),
              height: 800
            })
          },
          { width }
        )
        await page.waitForFunction(
          (expected) => Math.abs(window.innerWidth - expected) <= 4,
          width,
          { timeout: 10_000 }
        )
        await page.waitForTimeout(400)
      }

      const panelWidth = (): Promise<number> =>
        page.evaluate(() => {
          const node = document.querySelector('[data-testid="work-panel"]')
          return node instanceof HTMLElement ? Math.round(node.getBoundingClientRect().width) : 0
        })

      /** `work-panel-toggle` 开/关两种形态都在（见 ui-final/capture.mjs 的坑），所以按实测宽决定点不点 */
      const setPanelOpen = async (open: boolean): Promise<void> => {
        if ((await panelWidth()) > 0 === open) return
        await page.getByTestId('work-panel-toggle').click()
        if (open) await expect.poll(panelWidth, { timeout: 8_000 }).toBeGreaterThan(0)
        else await expect.poll(panelWidth, { timeout: 8_000 }).toBeLessThan(1)
        await page.waitForTimeout(500)
      }

      await resizeWindow(1280)
      await setPanelOpen(false)
      await page.getByTestId('view-tab-chat').click()
      // 0.2.0 壳层：`work-panel-toggle` 只在 chat 视图且面板收起时渲染（AppShell.tsx:278）；
      // 不再 Ctrl+T（新标签页不是 chat，会把 chat header 的 view-tab-chat 一起挡掉）。
      await setPanelOpen(true)
      if ((await page.getByTestId('browser-tool').count()) === 0) {
        await page.getByTestId('workbench-new-tab').click()
        await page.getByRole('menuitem', { name: '浏览器' }).click()
      }
      await page.waitForSelector('webview')

      await page.getByTestId('browser-url').fill(origin)
      await page.getByTestId('browser-url').press('Enter')
      await expect(page.getByTestId('browser-title')).toHaveText(FIXTURE_TITLE, { timeout: 20_000 })

      await expectGuestFollowsBox(app, page, '导航后（1280 · 面板 400）')
      await resizeWindow(800)
      await expectGuestFollowsBox(app, page, '窗口收窄铺满（800）')
      await setPanelOpen(false)
      await expectGuestFollowsBox(app, page, '面板隐藏')
      await setPanelOpen(true)
      await expectGuestFollowsBox(app, page, '面板重开')
      await resizeWindow(1280)
      await expectGuestFollowsBox(app, page, '回到 1280')
      await resizeWindow(800)
      await expectGuestFollowsBox(app, page, '再次收窄（800）')
    } finally {
      server.closeAllConnections()
      server.close()
      if (launched !== null) await closeApp(launched)
    }
  })
})
