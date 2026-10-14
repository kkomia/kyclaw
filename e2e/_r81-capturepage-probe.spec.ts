import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { sendMessage } from './harness'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'

/**
 * R81 残影复核探针（不进常规 e2e 闸门；只在 KYCLAW_UI_LAYOUT_CAPTURE=1 时运行）：
 *
 *   pnpm build && KYCLAW_UI_LAYOUT_CAPTURE=1 pnpm exec playwright test e2e/_r81-capturepage-probe.spec.ts
 *
 * 为什么单独一条路：Playwright 的 `page.screenshot({ fullPage: true })` 走 CDP 的整页截图，
 * 在既有证据里于"停靠卡下方"出现过一条极淡的被裁切文字。要判它是**真渲染**还是**捕获链路**，
 * 就换一台隔离 Electron 宿主、用主进程侧的 `webContents.capturePage()` 直接取窗口表面
 * ——**同一个状态、同一套驱动，只换取像通道**（与项目里 webview 尺寸探针同一手法）。
 *
 * 每档状态取三样：
 *   1. `capturePage()` 的整幅（原生分辨率）；
 *   2. `invalidate()` **强制重绘**之后再取一次（若第一张有、第二张没有 = 陈旧合成层/捕获问题；
 *      两张都在 = 真渲染，得定位并修）；
 *   3. 卡片下缘到输入卡上缘那一条 DOM 带（哪个元素在那儿、各自的高度/不透明度）——给残影对账。
 *
 * 覆盖（浅/深色 × 1280×800 / 800×800）：任务摘要折叠 / 展开，计划摘要折叠 / 展开。
 * 产物落 `.superpowers/ui-layout-adjustment/capturepage-<时间戳>/`（隔离实例：临时 userData/home/工作区 +
 * 本地 stub provider，不读凭据、不碰用户 profile，也不写任何既有证据目录）。
 */
const enabled = process.env.KYCLAW_UI_LAYOUT_CAPTURE === '1'
const evidenceRoot = resolve('.superpowers/ui-layout-adjustment')

const THEMES = ['light', 'dark'] as const
const SIZES = [
  { width: 1280, height: 800, label: 'normal' },
  { width: 800, height: 800, label: 'narrow' }
] as const

/** 一次 capturePage：主进程侧取窗口表面（不走 CDP 整页截图） */
async function capturePagePng(
  app: Awaited<ReturnType<typeof createInteractiveApp>>,
  invalidate: boolean
): Promise<Buffer> {
  const base64 = await app.app.evaluate(async ({ BrowserWindow }, force) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('没有窗口')
    if (force) win.webContents.invalidate()
    // invalidate 之后要等一帧真的画出来，再取像
    await new Promise((done) => setTimeout(done, 250))
    const image = await win.webContents.capturePage()
    return image.toPNG().toString('base64')
  }, invalidate)
  return Buffer.from(base64, 'base64')
}

test.describe('round 81 · 折叠/展开四态的 capturePage 复核', () => {
  test.skip(!enabled, '只在 KYCLAW_UI_LAYOUT_CAPTURE=1 时运行（隔离实例取证，不进常规 e2e 闸门）')
  test.setTimeout(900_000)
  test('任务/计划折叠展开 × 浅深色 × 正常窄窗', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const runId = `capturepage-${Date.now()}`
    const outDir = join(evidenceRoot, runId)
    mkdirSync(outDir, { recursive: true })
    const records: unknown[] = []

    const setTheme = async (theme: (typeof THEMES)[number]): Promise<void> => {
      await page.evaluate(async (next) => {
        if (!window.kyclaw) throw new Error('缺少生产桥')
        await window.kyclaw.settings.update({ theme: next })
      }, theme)
      await page.reload()
      await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ''))
        .toBe(theme)
    }
    const resizeTo = async (width: number, height: number): Promise<void> => {
      await app.app.evaluate(
        ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) throw new Error('没有窗口')
          win.unmaximize()
          win.setBounds({ x: 0, y: 0, ...size })
        },
        { width, height }
      )
      await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 4, width, {
        timeout: 10_000
      })
    }
    const newSession = async (): Promise<void> => {
      await page.getByTestId('new-session').click()
      await page.getByTestId('composer-input').waitFor()
      await expect(page.getByTestId('composer-input')).toHaveValue('')
    }

    /** 卡片下缘 → 输入卡上缘那一条带里都有谁（残影对账用；按矩形相交列，不看顺序） */
    const bandDump = async (): Promise<unknown> =>
      page.evaluate(() => {
        const card =
          document.querySelector('[data-testid="plan-approval-dock"]') ??
          document.querySelector('[data-testid="task-list-dock"]')
        const composer = document.querySelector('[data-testid="composer"]')
        if (!(card instanceof HTMLElement) || !(composer instanceof HTMLElement))
          return { card: null, composer: null, hits: [] }
        const top = Math.round(card.getBoundingClientRect().bottom)
        const bottom = Math.round(composer.getBoundingClientRect().top)
        const hits: string[] = []
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const box = el.getBoundingClientRect()
          if (box.height <= 0 || box.width <= 0) continue
          if (box.bottom <= top || box.top >= bottom) continue
          const style = getComputedStyle(el)
          hits.push(
            `${el.tagName}[${el.getAttribute('data-testid') ?? ''}] ${Math.round(box.top)}-${Math.round(box.bottom)} opacity=${style.opacity} overflow=${style.overflow} text="${(el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 24)}"`
          )
        }
        return {
          cardTop: Math.round(card.getBoundingClientRect().top),
          cardBottom: top,
          composerTop: bottom,
          hits: hits.slice(0, 24)
        }
      })

    /** 等布局停稳（同主截图探针：首条消息后的页脚过渡不能在途中取像） */
    const settle = async (): Promise<void> => {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="composer"]')
          if (!(el instanceof HTMLElement)) return false
          const store = window as unknown as { __settle?: { top: number; hits: number } }
          const top = Math.round(el.getBoundingClientRect().top)
          const current = store.__settle
          store.__settle =
            current !== undefined && current.top === top
              ? { top, hits: current.hits + 1 }
              : { top, hits: 1 }
          return store.__settle.hits >= 3
        },
        undefined,
        { polling: 100, timeout: 15_000 }
      )
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      // 再放一档快时长：摘要把手上的 chevron 旋转（.15s）不移动输入卡，但会在取像里差几个像素
      await page.waitForTimeout(250)
    }

    /** 取这一档状态：整幅 + 强制重绘后的整幅 + DOM 带 */
    const shoot = async (state: string, theme: string, size: string): Promise<void> => {
      await settle()
      const first = join(outDir, `${theme}-${size}-${state}.png`)
      const redrawn = join(outDir, `${theme}-${size}-${state}.redraw.png`)
      writeFileSync(first, await capturePagePng(app, false))
      writeFileSync(redrawn, await capturePagePng(app, true))
      const band = await bandDump()
      records.push({ state, theme, size, first, redrawn, band })
      console.log(`[capturepage] ${theme}/${size}/${state} → ${first}`)
    }

    const combo = async (
      theme: (typeof THEMES)[number],
      size: (typeof SIZES)[number]
    ): Promise<void> => {
      await resizeTo(size.width, size.height)
      await setTheme(theme)

      // ① 任务：真 todo（一进行中 + 一待办 + 一已完成）
      await newSession()
      provider.enqueue(
        {
          tool: 'todo',
          input: {
            action: 'replace',
            expectedRevision: 0,
            items: [
              { title: '收集素材', status: 'done' },
              { title: '整理成 Markdown 摘要', status: 'in_progress' },
              { title: '写回工作区', status: 'pending' }
            ]
          }
        },
        { text: 'CAPTURE_TODO_DONE' }
      )
      await sendMessage(page, 'CAPTURE_TODO')
      await expect(page.getByTestId('task-list-dock')).toBeVisible()
      await expect(page.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'true')
      await shoot('tasks-collapsed', theme, size.label)
      await page.getByTestId('task-dock-toggle').click()
      await expect(page.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'false')
      await shoot('tasks-expanded', theme, size.label)

      // ② 计划：新会话 → ＋菜单进入规划 → 提交计划 → 等待批准
      await newSession()
      const entry = page.getByTestId('composer-mode-plan')
      await expect(async () => {
        if (!(await entry.isVisible())) await page.getByTestId('composer-plus').click()
        await expect(entry).toBeVisible()
        expect(await entry.getAttribute('data-disabled')).toBeNull()
      }).toPass({ timeout: 20_000 })
      await entry.click()
      await expect(page.getByTestId('plan-approval-dock')).toBeVisible()
      const thread = (
        (await page
          .locator('[data-testid^="session-item-"]')
          .first()
          .getAttribute('data-testid')) ?? ''
      ).replace('session-item-', '')
      const planState = async (): Promise<{ planId: string; revision: number; version: number }> =>
        page.evaluate(async (id) => {
          if (!window.kyclaw) throw new Error('缺少生产桥')
          const endpoint = await window.kyclaw.agent.endpoint()
          const response = await fetch(
            `${endpoint.baseUrl}/plans/state?threadId=${encodeURIComponent(id)}`,
            { headers: { Authorization: `Bearer ${endpoint.token}` } }
          )
          return (await response.json()).state
        }, thread)
      const initial = await planState()
      provider.enqueue(
        { tool: 'enter_plan', input: { expectedVersion: initial.version } },
        {
          tool: 'submit_plan',
          input: async () => {
            const current = await planState()
            return {
              planId: current.planId,
              revision: current.revision,
              version: current.version,
              body: '# 用 Markdown 整理结果\n\n- 读取工作区里现有的文档\n- 生成要点摘要与明细两节\n- 写回一个 Markdown 文件并报告路径'
            }
          }
        }
      )
      await sendMessage(page, 'CAPTURE_PLAN')
      await expect(page.getByRole('button', { name: '批准此计划' })).toBeEnabled()
      await shoot('plan-collapsed', theme, size.label)
      await page.getByTestId('plan-approval-toggle').click()
      await expect(page.getByRole('region', { name: '计划正文与反馈' })).toBeVisible()
      await shoot('plan-expanded', theme, size.label)
    }

    try {
      for (const theme of THEMES) {
        for (const size of SIZES) await combo(theme, size)
      }
      writeFileSync(
        join(outDir, 'manifest.json'),
        `${JSON.stringify(
          {
            round: 'R81 capturePage 残影复核',
            generatedAt: new Date().toISOString(),
            method:
              'webContents.capturePage()（主进程侧取窗口表面）；每档再取一张 invalidate() 强制重绘后的，用于区分陈旧层与真渲染',
            isolation:
              'e2e/fixtures/interactive：临时 userData/home/工作区 + 本地 stub provider；不读凭据、不碰用户 profile',
            records
          },
          null,
          2
        )}\n`
      )
      console.log(`[capturepage] 共 ${records.length} 档 → ${outDir}`)
    } finally {
      await app.close()
      await provider.close()
    }
  })
})

/**
 * 同一条历史、同一时刻的**三路对照**：Playwright 整页截图 / Playwright 视口截图 /
 * `webContents.capturePage()`。残影若只在前者出现，就是 CDP 整页截图这条捕获链路的产物；
 * 三路都在，才是真渲染。历史按 UI 截图探针那一套原样复现（＋菜单 → 任务 → 挂住的流 →
 * 提问三页 → 计划提交），因为残影最初就是在那一串之后拍到的。
 */
test.describe('round 81 · 三路截图对照（残影归因）', () => {
  test.skip(!enabled, '只在 KYCLAW_UI_LAYOUT_CAPTURE=1 时运行')
  test.setTimeout(900_000)

  test('浅色 正常/窄窗：＋菜单→任务→挂流→提问三页→计划，四态三路取像', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const outDir = join(evidenceRoot, `ab-${Date.now()}`)
    mkdirSync(outDir, { recursive: true })

    const setTheme = async (theme: (typeof THEMES)[number]): Promise<void> => {
      await page.evaluate(async (next) => {
        if (!window.kyclaw) throw new Error('缺少生产桥')
        await window.kyclaw.settings.update({ theme: next })
      }, theme)
      await page.reload()
      await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })
    }
    const resizeTo = async (width: number, height: number): Promise<void> => {
      await app.app.evaluate(
        ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) throw new Error('没有窗口')
          win.unmaximize()
          win.setBounds({ x: 0, y: 0, ...size })
        },
        { width, height }
      )
      await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 4, width, {
        timeout: 10_000
      })
    }
    const newSession = async (): Promise<void> => {
      await page.getByTestId('new-session').click()
      await page.getByTestId('composer-input').waitFor()
      await expect(page.getByTestId('composer-input')).toHaveValue('')
    }
    const triple = async (label: string): Promise<void> => {
      // 停稳再取（否则三张之间布局还在动，比的就不是捕获路径而是过渡帧）
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="composer"]')
          if (!(el instanceof HTMLElement)) return false
          const store = window as unknown as { __settle?: { top: number; hits: number } }
          const top = Math.round(el.getBoundingClientRect().top)
          const current = store.__settle
          store.__settle =
            current !== undefined && current.top === top
              ? { top, hits: current.hits + 1 }
              : { top, hits: 1 }
          return store.__settle.hits >= 3
        },
        undefined,
        { polling: 100, timeout: 15_000 }
      )
      // 同 settle：再放一档快时长 + 两帧，让摘要把手上的 chevron 旋转（.15s）落定
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(outDir, `${label}-fullpage.png`), fullPage: true })
      await page.screenshot({ path: join(outDir, `${label}-viewport.png`) })
      writeFileSync(join(outDir, `${label}-capturepage.png`), await capturePagePng(app, false))
      console.log(`[ab] ${label}`)
    }

    try {
      for (const size of SIZES) {
        await resizeTo(size.width, size.height)
        await setTheme('light')
        await newSession()

        // 与 UI 截图探针同序：先 ＋菜单、再任务、再挂住的流
        await page.getByTestId('composer-plus').click()
        await expect(page.getByTestId('composer-mode-plan')).toBeVisible()
        await page.keyboard.press('Escape')
        provider.enqueue(
          {
            tool: 'todo',
            input: {
              action: 'replace',
              expectedRevision: 0,
              items: [
                { title: '收集素材', status: 'done' },
                { title: '整理成 Markdown 摘要', status: 'in_progress' },
                { title: '写回工作区', status: 'pending' }
              ]
            }
          },
          { text: 'AB_TODO_DONE' }
        )
        await sendMessage(page, 'AB_TODO')
        await expect(page.getByTestId('task-list-dock')).toBeVisible()
        await triple(`${size.label}-tasks-collapsed`)
        await page.getByTestId('task-dock-toggle').click()
        await expect(page.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'false')
        await triple(`${size.label}-tasks-expanded`)

        provider.enqueue({ hang: true, text: '正在整理内容…' })
        await sendMessage(page, 'AB_HANG')
        await expect(page.getByTestId('composer-stop')).toBeVisible()

        // 提问三页（新会话）
        await newSession()
        provider.enqueue({
          tool: 'ask_user',
          input: {
            questions: [
              {
                id: 'format',
                header: '输出格式',
                question: '这次结果你想要哪种格式？',
                options: [
                  { id: 'doc', label: '文档' },
                  { id: 'sheet', label: '表格' }
                ]
              },
              {
                id: 'scope',
                header: '内容范围',
                question: '需要包含哪些内容？（可多选）',
                multiSelect: true,
                options: [
                  { id: 'summary', label: '摘要' },
                  { id: 'detail', label: '明细' }
                ]
              },
              {
                id: 'deliver',
                header: '交付方式',
                question: '结果怎么交付？',
                options: [
                  { id: 'file', label: '写成文件放到工作区' },
                  { id: 'chat', label: '直接回复在对话里' }
                ]
              }
            ]
          }
        })
        await sendMessage(page, 'AB_ASK')
        const card = page.getByTestId('ask-user-card')
        await expect(card).toBeVisible()
        await card.getByRole('radio').first().check()
        await page.getByTestId('ask-user-next').click()
        await card.getByRole('checkbox').first().check()
        await page.getByTestId('ask-user-next').click()
        await expect(page.getByTestId('ask-user-page')).toHaveText('第 3/3 题')

        // 计划（新会话）→ 折叠 / 展开
        await newSession()
        const entry = page.getByTestId('composer-mode-plan')
        await expect(async () => {
          if (!(await entry.isVisible())) await page.getByTestId('composer-plus').click()
          await expect(entry).toBeVisible()
          expect(await entry.getAttribute('data-disabled')).toBeNull()
        }).toPass({ timeout: 20_000 })
        await entry.click()
        await expect(page.getByTestId('plan-approval-dock')).toBeVisible()
        const thread = (
          (await page
            .locator('[data-testid^="session-item-"]')
            .first()
            .getAttribute('data-testid')) ?? ''
        ).replace('session-item-', '')
        const planState = async (): Promise<{
          planId: string
          revision: number
          version: number
        }> =>
          page.evaluate(async (id) => {
            if (!window.kyclaw) throw new Error('缺少生产桥')
            const endpoint = await window.kyclaw.agent.endpoint()
            const response = await fetch(
              `${endpoint.baseUrl}/plans/state?threadId=${encodeURIComponent(id)}`,
              { headers: { Authorization: `Bearer ${endpoint.token}` } }
            )
            return (await response.json()).state
          }, thread)
        const initial = await planState()
        provider.enqueue(
          { tool: 'enter_plan', input: { expectedVersion: initial.version } },
          {
            tool: 'submit_plan',
            input: async () => {
              const current = await planState()
              return {
                planId: current.planId,
                revision: current.revision,
                version: current.version,
                body: '# 用 Markdown 整理结果\n\n- 读取工作区里现有的文档\n- 生成要点摘要与明细两节\n- 写回一个 Markdown 文件并报告路径'
              }
            }
          }
        )
        await sendMessage(page, 'AB_PLAN')
        await expect(page.getByRole('button', { name: '批准此计划' })).toBeEnabled()
        await triple(`${size.label}-plan-collapsed`)
        await page.getByTestId('plan-approval-toggle').click()
        await expect(page.getByRole('region', { name: '计划正文与反馈' })).toBeVisible()
        await triple(`${size.label}-plan-expanded`)
      }
      console.log(`[ab] 产物 → ${outDir}`)
    } finally {
      await app.close()
      await provider.close()
    }
  })
})

/**
 * 定序实验：同一状态、**换顺序**取三路 + 每次取像前后各记一次卡片位置。
 * 若"位置变化"总跟着 `page.screenshot({fullPage:true})` 出现（不管它排第几），
 * 就是这条捕获路径本身触发了重排；若总跟着"第一次取像"出现，才是界面自己还在动。
 */
test.describe('round 81 · 捕获路径是否触发重排', () => {
  test.skip(!enabled, '只在 KYCLAW_UI_LAYOUT_CAPTURE=1 时运行')
  test.setTimeout(600_000)

  test('计划摘要态：capturepage → viewport → fullpage，逐次量卡片位置', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const outDir = join(evidenceRoot, `order-${Date.now()}`)
    mkdirSync(outDir, { recursive: true })

    const probe = async (): Promise<unknown> =>
      page.evaluate(() => {
        const card = document.querySelector('[data-testid="plan-approval-dock"]')
        const composer = document.querySelector('[data-testid="composer"]')
        const spacer = document.querySelector('[data-testid="welcome-spacer"]')
        const hero = document.querySelector('[data-testid="welcome-hero"]')
        const rect = (el: Element | null): unknown =>
          el === null
            ? null
            : {
                top: Math.round(el.getBoundingClientRect().top),
                bottom: Math.round(el.getBoundingClientRect().bottom)
              }
        return {
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          card: rect(card),
          composer: rect(composer),
          spacer: rect(spacer),
          spacerClass: spacer?.className ?? null,
          heroActive: hero?.getAttribute('data-active') ?? null
        }
      })

    try {
      await app.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        win?.unmaximize()
        win?.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
      })
      await page.getByTestId('new-session').click()
      const entry = page.getByTestId('composer-mode-plan')
      await expect(async () => {
        if (!(await entry.isVisible())) await page.getByTestId('composer-plus').click()
        await expect(entry).toBeVisible()
        expect(await entry.getAttribute('data-disabled')).toBeNull()
      }).toPass({ timeout: 20_000 })
      await entry.click()
      await expect(page.getByTestId('plan-approval-dock')).toBeVisible()
      const thread = (
        (await page
          .locator('[data-testid^="session-item-"]')
          .first()
          .getAttribute('data-testid')) ?? ''
      ).replace('session-item-', '')
      const planState = async (): Promise<{ planId: string; revision: number; version: number }> =>
        page.evaluate(async (id) => {
          if (!window.kyclaw) throw new Error('缺少生产桥')
          const endpoint = await window.kyclaw.agent.endpoint()
          const response = await fetch(
            `${endpoint.baseUrl}/plans/state?threadId=${encodeURIComponent(id)}`,
            { headers: { Authorization: `Bearer ${endpoint.token}` } }
          )
          return (await response.json()).state
        }, thread)
      const initial = await planState()
      provider.enqueue(
        { tool: 'enter_plan', input: { expectedVersion: initial.version } },
        {
          tool: 'submit_plan',
          input: async () => {
            const current = await planState()
            return {
              planId: current.planId,
              revision: current.revision,
              version: current.version,
              body: '# 用 Markdown 整理结果\n\n- 读取工作区里现有的文档\n- 写回一个 Markdown 文件'
            }
          }
        }
      )
      await sendMessage(page, 'ORDER_PLAN')
      await expect(page.getByRole('button', { name: '批准此计划' })).toBeEnabled()
      // 先把"界面自己还在动"的窗口排掉：等 3 秒再开始
      await page.waitForTimeout(3000)

      const steps: unknown[] = []
      const step = async (label: string, run: () => Promise<void>): Promise<void> => {
        const before = await probe()
        await run()
        const after = await probe()
        steps.push({
          label,
          before,
          after,
          moved: JSON.stringify(before) !== JSON.stringify(after)
        })
        console.log(`[order] ${label} moved=${JSON.stringify(before) !== JSON.stringify(after)}`)
      }

      await step('capturepage', async () => {
        writeFileSync(join(outDir, '01-capturepage.png'), await capturePagePng(app, false))
      })
      await page.waitForTimeout(500)
      await step('viewport', async () => {
        await page.screenshot({ path: join(outDir, '02-viewport.png') })
      })
      await page.waitForTimeout(500)
      await step('fullpage', async () => {
        await page.screenshot({ path: join(outDir, '03-fullpage.png'), fullPage: true })
      })
      await page.waitForTimeout(1000)
      await step('fullpage-second', async () => {
        await page.screenshot({ path: join(outDir, '04-fullpage-again.png'), fullPage: true })
      })
      await page.waitForTimeout(1000)
      await step('capturepage-second', async () => {
        writeFileSync(join(outDir, '05-capturepage-again.png'), await capturePagePng(app, false))
      })
      writeFileSync(join(outDir, 'steps.json'), `${JSON.stringify({ steps }, null, 2)}\n`)
      console.log(`[order] 产物 → ${outDir}`)
    } finally {
      await app.close()
      await provider.close()
    }
  })
})
