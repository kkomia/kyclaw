import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { sendMessage } from './harness'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'

/**
 * round 82 提问卡形态调整的**目视证据探针**（不进常规 e2e 闸门；只在 KYCLAW_ASK_LAYOUT_SHOTS=1 时运行）：
 *
 *   pnpm build && KYCLAW_ASK_LAYOUT_SHOTS=1 pnpm exec playwright test e2e/_r82-ask-user-layout.spec.ts
 *
 * 用**隔离实例**拍（e2e/fixtures/interactive：临时 userData + 临时 home + 临时工作区 + 本地 stub provider，
 * 不读任何真实凭据、不碰用户的 profile），产物落
 * `.superpowers/ui-layout-adjustment/ask-<时间戳>/`（**新目录**，历史证据目录一个字不动）。
 *
 * 取像走**主进程侧 `webContents.capturePage()`**（不是 CDP 整页截图，见 _r81-capturepage-probe 的归因），
 * 并且等布局真的停稳（输入卡上缘连续三次读数一致 + 两帧 + 一档快时长）再取。
 *
 * 覆盖（浅/深色 × 正常 1280×800 / 窄窗 800×800 / 极小高度 1280×560）：
 *   ask-first   第 1/3 题（带选项描述）
 *   ask-other   第 2/3 题：往「其它」输入框直接打字（输入即勾上 + 计数出现）
 *   ask-last    第 3/3 题（末页才有「提交全部回答」）
 *   ask-long    超长题（很多选项 + 长问句）：外层兜底滚动但不裁切
 *
 * 每档除图片外还落一份 **DOM 体检**（measure）：提问卡与停靠区的 max-height / overflow、
 * scrollHeight 与 clientHeight（判"有没有内滚条"）、卡与输入卡与 × 的矩形（判"有没有被裁 / × 在不在右上角"）。
 * 本文件只产证据，**目视结论由看图的人写进报告**。
 */
const enabled = process.env.KYCLAW_ASK_LAYOUT_SHOTS === '1'
const evidenceRoot = resolve('.superpowers/ui-layout-adjustment')

const QUESTIONS = {
  questions: [
    {
      id: 'format',
      header: '输出格式',
      question: '这次结果你想要哪种格式？',
      options: [
        { id: 'doc', label: '文档', description: '适合阅读与批注', recommended: true },
        { id: 'sheet', label: '表格', description: '适合逐行核对' }
      ]
    },
    {
      id: 'scope',
      header: '内容范围',
      question: '需要包含哪些内容？（可多选）',
      multiSelect: true,
      options: [
        { id: 'summary', label: '摘要' },
        { id: 'detail', label: '明细' },
        { id: 'appendix', label: '附录数据' }
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

const LONG_QUESTION = {
  questions: [
    {
      id: 'long',
      header: '长题',
      question: '这是一个很长的问句：'.concat(
        '需要在极小窗口里也把当前题完整铺开，不能裁切。'.repeat(6)
      ),
      // 选项上限 4（见 shared/ask-user 的 schema）；这里取满 4 项、每项都带说明 + 长标签
      options: Array.from({ length: 4 }, (_, index) => ({
        id: `o${index}`,
        label: `第 ${index + 1} 个选项`.concat('（带一段不短的说明）'.repeat(2)),
        description: '选项说明'.repeat(4)
      }))
    }
  ]
}

const THEMES = ['light', 'dark'] as const
const SIZES = [
  { width: 1280, height: 800, label: 'normal' },
  { width: 800, height: 800, label: 'narrow' },
  // 极小高度那一档：正常窗口里也放不下的高度，用来证明"外层兜底滚动 + 输入卡仍可达、不裁切"
  { width: 1280, height: 560, label: 'short' }
] as const

test.describe('round 82 · 提问卡形态调整目视证据', () => {
  test.skip(!enabled, '只在 KYCLAW_ASK_LAYOUT_SHOTS=1 时运行（隔离实例取证，不进常规 e2e 闸门）')
  test.setTimeout(900_000)

  test('浅/深色 × 正常/窄窗：分页三态 + 其它输入 + 长题', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const runId = `ask-${Date.now()}`
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

    /** 等布局停稳（输入卡上缘连续三次读数一致 + 两帧 + 一档快时长），再取像 */
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
      await page.waitForTimeout(250)
    }

    /** 一次 capturePage：主进程侧取窗口表面（不走 CDP 整页截图） */
    const capturePagePng = async (): Promise<Buffer> => {
      const base64 = await app.app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('没有窗口')
        // invalidate 之后等一帧真的画出来，再取像
        win.webContents.invalidate()
        await new Promise((done) => setTimeout(done, 250))
        return (await win.webContents.capturePage()).toPNG().toString('base64')
      })
      return Buffer.from(base64, 'base64')
    }

    /**
     * 提问卡 / 停靠区 / 输入卡的 DOM 体检：夹高与溢出样式、有没有内滚（scrollHeight vs clientHeight）、
     * 矩形（有没有被裁、× 在不在卡片右上角）。文案与几何都是实测，不猜。
     */
    const measure = async (): Promise<unknown> =>
      page.evaluate(() => {
        const rect = (el: Element | null): unknown =>
          el === null || !(el instanceof HTMLElement)
            ? null
            : {
                top: Math.round(el.getBoundingClientRect().top),
                bottom: Math.round(el.getBoundingClientRect().bottom),
                left: Math.round(el.getBoundingClientRect().left),
                right: Math.round(el.getBoundingClientRect().right)
              }
        const dump = (el: Element | null): unknown => {
          if (!(el instanceof HTMLElement)) return null
          const style = getComputedStyle(el)
          return {
            rect: rect(el),
            maxHeight: style.maxHeight,
            overflowY: style.overflowY,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            innerScroll: el.scrollHeight > el.clientHeight + 1,
            scrollTop: el.scrollTop
          }
        }
        const card = document.querySelector('[data-testid="ask-user-card"]')
        const cancel = document.querySelector('[data-testid="ask-user-cancel"]')
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          card: dump(card),
          dock: dump(document.querySelector('[data-testid="ask-user-dock"]')),
          dockArea: dump(document.querySelector('[data-testid="chat-dock-area"]')),
          composer: dump(document.querySelector('[data-testid="composer"]')),
          cancel: rect(cancel),
          // × 是否落在卡片右上角（水平靠右、垂直靠上）
          cancelInCorner:
            card instanceof HTMLElement && cancel instanceof HTMLElement
              ? cancel.getBoundingClientRect().right <= card.getBoundingClientRect().right &&
                cancel.getBoundingClientRect().left >=
                  card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2 &&
                cancel.getBoundingClientRect().top <=
                  card.getBoundingClientRect().top + card.getBoundingClientRect().height / 3
              : null,
          page: document.querySelector('[data-testid="ask-user-page"]')?.textContent ?? null,
          callLabels: document.body.innerText.match(/问题调用|调用详情/g)?.length ?? 0
        }
      })

    const shoot = async (state: string, theme: string, size: string): Promise<void> => {
      await settle()
      const file = join(outDir, `${theme}-${size}-${state}.png`)
      writeFileSync(file, await capturePagePng())
      const metrics = await measure()
      records.push({ state, theme, size, file, metrics })
      console.log(`[ask-layout] ${theme}/${size}/${state} → ${file}`)
      console.log(`[ask-layout] metrics ${JSON.stringify(metrics)}`)
    }

    const combo = async (
      theme: (typeof THEMES)[number],
      size: (typeof SIZES)[number]
    ): Promise<void> => {
      await resizeTo(size.width, size.height)
      await setTheme(theme)
      await newSession()

      // 三题分页：第一题（带描述）→ 其它输入 → 末页
      provider.enqueue({ tool: 'ask_user', input: QUESTIONS })
      await sendMessage(page, 'ASK_SHOT')
      const card = page.getByTestId('ask-user-card')
      await expect(card).toBeVisible()
      await expect(card.getByRole('button', { name: '取消本轮提问' })).toBeVisible()
      // 没有调用编号 / 调用详情这类技术标签
      await expect(card.getByText(/问题调用/)).toHaveCount(0)
      await expect(app.page.getByText('调用详情')).toHaveCount(0)
      await expect(page.getByTestId('ask-user-page')).toHaveText('第 1/3 题')
      await card.getByRole('radio').first().check()
      await shoot('ask-first', theme, size.label)

      await page.getByTestId('ask-user-next').click()
      await expect(page.getByTestId('ask-user-page')).toHaveText('第 2/3 题')
      // 「其它」直接就是输入框：打字即勾上
      await card.getByLabel('其它内容').fill('想要一份补充统计')
      await expect(card.getByRole('checkbox', { name: '其它', exact: true })).toBeChecked()
      await expect(card.getByText(/\/2000 字/)).toBeVisible()
      await shoot('ask-other', theme, size.label)

      await page.getByTestId('ask-user-next').click()
      await expect(page.getByTestId('ask-user-page')).toHaveText('第 3/3 题')
      await card.getByRole('radio').first().check()
      await expect(card.getByRole('button', { name: '提交全部回答' })).toBeVisible()
      await shoot('ask-last', theme, size.label)

      // 长题（新会话）：很多选项 + 长问句，看外层兜底滚动与"不被裁"
      await newSession()
      provider.enqueue({ tool: 'ask_user', input: LONG_QUESTION })
      await sendMessage(page, 'ASK_SHOT_LONG')
      await expect(page.getByTestId('ask-user-card')).toBeVisible()
      await shoot('ask-long', theme, size.label)
    }

    try {
      for (const theme of THEMES) {
        for (const size of SIZES) await combo(theme, size)
      }
      writeFileSync(
        join(outDir, 'manifest.json'),
        `${JSON.stringify(
          {
            round: 'R82 AskUser 卡形态调整（去调用标签 / 去内滚 / 其它直接输入 / × 取消）',
            generatedAt: new Date().toISOString(),
            method:
              'webContents.capturePage()（主进程侧取窗口表面）+ 布局停稳判据；每档附 DOM 体检（夹高/滚动/矩形）',
            isolation:
              'e2e/fixtures/interactive：临时 userData/home/工作区 + 本地 stub provider；不读凭据、不碰用户 profile',
            note: '只产证据；目视结论由看图的人单独写',
            records
          },
          null,
          2
        )}\n`
      )
      console.log(`[ask-layout] 共 ${records.length} 档 → ${outDir}`)
    } finally {
      await app.close()
      await provider.close()
    }
  })
})
