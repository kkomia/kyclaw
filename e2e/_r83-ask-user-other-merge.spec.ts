import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { sendMessage } from './harness'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'

/**
 * round 83「模型自带的『其他』选项与内置『其它』输入行合并成一条」的**目视证据探针**
 * （不进常规 e2e 闸门；只在 KYCLAW_ASK_OTHER_SHOTS=1 时运行）：
 *
 *   pnpm build && KYCLAW_ASK_OTHER_SHOTS=1 pnpm exec playwright test e2e/_r83-ask-user-other-merge.spec.ts
 *
 * 题面照抄用户截图那一张卡（「你的角色」单选，模型把第 4 项写成「其他（我在回答里补充）」，
 * 并给它带上说明与「推荐」——两者都要跟着合并行进新形态，不能静默丢）：
 *   ask-merged        第 1/2 题未动 —— 只该有**一条**「其他」入口，且它就是输入行
 *   ask-merged-typed  往合并后的输入框打字（输入即勾上 + 计数出现）
 *   ask-plain         第 2/2 题：正常选项「其它格式的文档」不误伤，内置行仍叫「其它」
 *
 * 另外每档做一遍**真浏览器行为回归**（事件计数，不只看图）：翻页只翻页（0 次 submit、
 * 末页未答不冒校验），点「提交全部回答」才校验，答完再提交才真的续跑。
 *
 * 用**隔离实例**拍（e2e/fixtures/interactive：临时 userData + 临时 home + 临时工作区 + 本地 stub provider），
 * 不读任何真实凭据、不碰用户的 profile；取像走主进程侧 `webContents.capturePage()` 并等布局停稳。
 * 本文件只产证据，**目视结论由看图的人写**。
 */
const enabled = process.env.KYCLAW_ASK_OTHER_SHOTS === '1'
const evidenceRoot = resolve('.superpowers/ui-layout-adjustment')

const QUESTIONS = {
  questions: [
    {
      id: 'role',
      header: '你的角色',
      question: '你主要是以什么身份在用我？',
      options: [
        { id: 'employee', label: '上班族 / 企业员工' },
        { id: 'student', label: '学生 / 科研人员' },
        { id: 'freelance', label: '自由职业 / 创业者' },
        {
          id: 'other',
          label: '其他（我在回答里补充）',
          description: '选这一项就在输入框里写清楚，别只填「其他」。',
          recommended: true
        }
      ]
    },
    {
      id: 'format',
      header: '格式',
      question: '要哪种文件？',
      options: [
        { id: 'doc', label: '其它格式的文档' },
        { id: 'sheet', label: '表格' }
      ]
    }
  ]
}

const THEMES = ['light', 'dark'] as const
const SIZES = [
  { width: 1280, height: 800, label: 'normal' },
  { width: 800, height: 800, label: 'narrow' }
] as const

test.describe('round 83 · 提问卡「其他」选项合并目视证据', () => {
  test.skip(!enabled, '只在 KYCLAW_ASK_OTHER_SHOTS=1 时运行（隔离实例取证，不进常规 e2e 闸门）')
  test.setTimeout(600_000)

  test('浅/深色 × 正常/窄窗：合并后只剩一条「其他」入口', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const outDir = join(evidenceRoot, `ask-other-merge-${Date.now()}`)
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

    const capturePagePng = async (): Promise<Buffer> => {
      const base64 = await app.app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('没有窗口')
        win.webContents.invalidate()
        await new Promise((done) => setTimeout(done, 250))
        return (await win.webContents.capturePage()).toPNG().toString('base64')
      })
      return Buffer.from(base64, 'base64')
    }

    /**
     * 行级体检：每条 `<label>` 的文案、单选/多选数、输入框数，以及
     * 「输入框和哪个 label 在同一行」——合并成立与否看这几项。
     */
    const measure = async (): Promise<unknown> =>
      page.evaluate(() => {
        const card = document.querySelector('[data-testid="ask-user-card"]')
        if (!(card instanceof HTMLElement)) return null
        const box = card.querySelector('textarea')
        // 输入行的行容器 = 同时装着 label 与 textarea 的最小祖先（选项行的 label 自己就是行，不在此列）
        let inputRow: Element | null = box
        while (inputRow !== null && inputRow !== card) {
          if (
            inputRow.querySelector('label') !== null &&
            inputRow.querySelector('textarea') !== null
          )
            break
          inputRow = inputRow.parentElement
        }
        const rows = [...card.querySelectorAll('label')].map((label) => {
          const control = label.querySelector('input')
          return {
            label: (label.textContent ?? '').trim(),
            kind: control?.getAttribute('type') ?? null,
            withInput: inputRow !== null && inputRow !== card && inputRow.contains(label)
          }
        })
        // 与产品同一套「其他」文案口径（AskUserCard 的 ASK_USER_OTHER_LABEL）
        const otherLike = (text: string): boolean =>
          /^(?:其他|其它|other)(?:$|[（(\s:：])/iu.test(text)
        const otherRows = rows.filter((row) => otherLike(row.label))
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          rows,
          radioCount: card.querySelectorAll('input[type="radio"]').length,
          inputBoxCount: card.querySelectorAll('textarea').length,
          // 合并判据：以「其他/其它」起头（并单独成词）的行只剩一条，且那一条就是输入行
          otherRowCount: otherRows.length,
          otherRowHasInput: otherRows[0]?.withInput ?? null,
          otherRowLabel: otherRows[0]?.label ?? null,
          page: card.querySelector('[data-testid="ask-user-page"]')?.textContent ?? null,
          countLabel: card.textContent?.match(/\d+\/2000 字/)?.[0] ?? null
        }
      })

    /** 页面侧 submit 事件计数（翻页不该 +1；点提交才该 +1） */
    const submitEvents = async (): Promise<number> =>
      page.evaluate(() => (window as unknown as { __submitCount?: number }).__submitCount ?? -1)

    const shoot = async (state: string, theme: string, size: string): Promise<void> => {
      await settle()
      const file = join(outDir, `${theme}-${size}-${state}.png`)
      writeFileSync(file, await capturePagePng())
      const metrics = await measure()
      records.push({ state, theme, size, file, metrics })
      console.log(`[ask-other-merge] ${theme}/${size}/${state} → ${file}`)
      console.log(`[ask-other-merge] metrics ${JSON.stringify(metrics)}`)
    }

    try {
      for (const theme of THEMES) {
        for (const size of SIZES) {
          await resizeTo(size.width, size.height)
          await setTheme(theme)
          await newSession()

          provider.enqueue({ tool: 'ask_user', input: QUESTIONS })
          await sendMessage(page, 'ASK_OTHER_MERGE')
          const card = page.getByTestId('ask-user-card')
          await expect(card).toBeVisible()
          await expect(page.getByTestId('ask-user-page')).toHaveText('第 1/2 题')
          // 合并后第 1/2 题只该有 4 个单选（3 条真选项 + 1 条合并后的「其他」输入行）
          await expect(card.getByRole('radio')).toHaveCount(4)
          await expect(card.getByRole('textbox')).toHaveCount(1)
          await shoot('ask-merged', theme, size.label)

          await card.getByLabel('其它内容').fill('独立开发 / 一个人做产品')
          await expect(card.getByRole('radio', { name: '其他（我在回答里补充）' })).toBeChecked()
          await expect(card.getByText(/\/2000 字/)).toBeVisible()
          await shoot('ask-merged-typed', theme, size.label)

          // 翻页前挂一个 submit 事件计数器：翻页只该翻页，不能顺带把答案提交一遍
          await page.evaluate(() => {
            const store = window as unknown as { __submitCount?: number }
            store.__submitCount = 0
            document.addEventListener(
              'submit',
              () => {
                store.__submitCount = (store.__submitCount ?? 0) + 1
              },
              true
            )
          })
          await page.getByTestId('ask-user-next').click()
          await expect(page.getByTestId('ask-user-page')).toHaveText('第 2/2 题')
          // 只翻页：0 次 submit，末页还没答也不该冒出校验提示
          expect(await submitEvents()).toBe(0)
          await expect(card.getByRole('alert')).toHaveCount(0)
          // 正常选项「其它格式的文档」不误伤：2 条选项 + 1 条内置「其它」行
          await expect(card.getByRole('radio')).toHaveCount(3)
          await expect(card.getByRole('radio', { name: '其它格式的文档' })).toBeVisible()
          await expect(card.getByRole('radio', { name: /^其它$/ })).toBeVisible()
          // 人真去点提交才校验：末页未答 → 拦下并提示，卡片不消失
          await card.getByRole('button', { name: '提交全部回答' }).click()
          await expect(card.getByRole('alert')).toHaveText(
            '请选择一个选项或填写其它内容，二者互斥。'
          )
          expect(await submitEvents()).toBe(1)
          // 答完再点提交：这次真的交出去（续跑请求里带着两题答案）
          await card.getByRole('radio', { name: '表格' }).check()
          await expect(card.getByRole('alert')).toHaveCount(0)
          await shoot('ask-plain', theme, size.label)
          await card.getByRole('button', { name: '提交全部回答' }).click()
          await expect
            .poll(
              () =>
                JSON.stringify(
                  provider.requests.filter((request) => request.stream).at(-1)?.messages ?? ''
                ),
              { timeout: 20_000 }
            )
            .toContain('独立开发 / 一个人做产品')
          expect(
            JSON.stringify(provider.requests.filter((request) => request.stream).at(-1)?.messages)
          ).toContain('表格')
          await expect(card).toHaveCount(0)
        }
      }
      writeFileSync(
        join(outDir, 'manifest.json'),
        `${JSON.stringify(
          {
            round: 'R83 AskUser「其他」选项与内置「其它」输入行合并成一条',
            generatedAt: new Date().toISOString(),
            method:
              'webContents.capturePage()（主进程侧取窗口表面）+ 布局停稳判据；每档附行级 DOM 体检（label 文案 / 控件数 / 输入框在不在那一行）',
            isolation:
              'e2e/fixtures/interactive：临时 userData/home/工作区 + 本地 stub provider；不读凭据、不碰用户 profile',
            note: '只产证据；目视结论由看图的人单独写。每档除三张图外还做真浏览器行为回归：翻页前挂 submit 事件计数器 —— 点「下一题」翻到末页必须 0 次 submit、且末页未答不冒校验提示（改前那次 click 的默认动作被当成提交，会立刻提示）；末页点「提交全部回答」才校验（1 次 submit、卡片不消失）；答完再提交才真的续跑（provider 收到的请求里带两题答案）。',
            records
          },
          null,
          2
        )}\n`
      )
      console.log(`[ask-other-merge] 共 ${records.length} 档 → ${outDir}`)
    } finally {
      await app.close()
      await provider.close()
    }
  })
})
