import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { sendMessage } from './harness'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'

/**
 * R81 布局调整的**目视证据探针**（不进常规 e2e 闸门；只在 KYCLAW_UI_LAYOUT_SHOTS=1 时运行）。
 *
 *   pnpm build && KYCLAW_UI_LAYOUT_SHOTS=1 pnpm exec playwright test e2e/_r81-ui-layout-shots.spec.ts
 *
 * 用**隔离实例**拍（e2e/fixtures/interactive 的 createInteractiveApp：临时 userData + 临时 home +
 * 临时工作区 + 本地 stub provider，不读任何真实凭据、不碰用户的 profile），产物落
 * `.superpowers/ui-layout-adjustment/run-<时间戳>/`（**新目录**，不写 agent-comparison 的历史证据）。
 *
 * 覆盖（浅/深色 × 正常 1280×800 / 窄窗 800×800）：
 *   plus-menu        左下角 ＋ 菜单（模式分组：进入规划模式 / 任务清单）
 *   running-summary  运行中：挂住的流（停止钮）+ 上方的紧凑任务摘要
 *   ask-first/middle/last  多题分页的第一页 / 中间页 / 末页
 *   tasks-collapsed/expanded 任务摘要收起 / 展开
 *   plan-collapsed/expanded  计划摘要收起 / 展开
 *
 * 状态都是**真跑出来的**：todo / ask_user / 计划走真工具调用与真服务端状态；唯一的人造件是
 * "挂住不结束的流"（fixture 的 hang 位），它只用来让"运行中"停住可拍。
 * 本文件只产图片，**不做目视结论** —— 视觉结论由跑完逐张看图的人写进报告。
 */
const enabled = process.env.KYCLAW_UI_LAYOUT_SHOTS === '1'
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

const THEMES = ['light', 'dark'] as const
const SIZES = [
  { width: 1280, height: 800, label: 'normal' },
  { width: 800, height: 800, label: 'narrow' }
] as const

test.describe('round 81 · 布局调整目视证据', () => {
  test.skip(!enabled, '只在 KYCLAW_UI_LAYOUT_SHOTS=1 时运行（隔离实例截图，不进常规 e2e 闸门）')
  test.setTimeout(900_000)

  test('浅/深色 × 正常/窄窗逐状态截图', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const runId = `run-${Date.now()}`
    const outDir = join(evidenceRoot, runId)
    mkdirSync(outDir, { recursive: true })
    const shots: Array<{ name: string; file: string; theme: string; size: string }> = []

    /**
     * 等布局真的停稳再取像（残影教训）：首条消息到达会把页脚从"初始页居中"过渡到常规底部
     * （`welcome-spacer` 的 flex-grow/margin 走主档 .3s），中途截图会拍到上一帧的残影。
     * 判据 = 输入卡上缘连续三次读数量到同一个值，再放两帧。
     */
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

    const shot = async (state: string, theme: string, size: string): Promise<void> => {
      await settle()
      const file = join(outDir, `${theme}-${size}-${state}.png`)
      await page.screenshot({ path: file, fullPage: true })
      shots.push({ name: `${theme}-${size}-${state}`, file, theme, size })
      console.log(`[shots] ${theme}/${size}/${state} → ${file}`)
    }

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

    /** 当前会话 id（最近更新的那一行就是刚发过消息的这一条） */
    const activeThreadId = async (): Promise<string> => {
      const id = await page
        .locator('[data-testid^="session-item-"]')
        .first()
        .getAttribute('data-testid')
      if (!id) throw new Error('会话还没物化')
      return id.replace('session-item-', '')
    }

    /** 直接问服务端要计划状态（与 e2e/interactive-features 同一套取法） */
    const planState = async (
      threadId: string
    ): Promise<{ planId: string; revision: number; version: number; mode: string }> =>
      page.evaluate(async (id) => {
        if (!window.kyclaw) throw new Error('缺少生产桥')
        const endpoint = await window.kyclaw.agent.endpoint()
        const response = await fetch(
          `${endpoint.baseUrl}/plans/state?threadId=${encodeURIComponent(id)}`,
          { headers: { Authorization: `Bearer ${endpoint.token}` } }
        )
        if (!response.ok) throw new Error(`计划状态返回 ${response.status}`)
        return (await response.json()).state
      }, threadId)

    /** 打开 ＋ 菜单并等某一条模式条目可用（挂载那一下 ask-user 状态还没到位，条目会短暂禁用） */
    const clickModeEntry = async (testId: string): Promise<void> => {
      const entry = page.getByTestId(testId)
      await expect(async () => {
        if (!(await entry.isVisible())) await page.getByTestId('composer-plus').click()
        await expect(entry).toBeVisible()
        expect(await entry.getAttribute('data-disabled')).toBeNull()
      }).toPass({ timeout: 20_000 })
      await entry.click()
    }

    const combo = async (
      theme: (typeof THEMES)[number],
      size: (typeof SIZES)[number]
    ): Promise<void> => {
      await resizeTo(size.width, size.height)
      await setTheme(theme)
      await newSession()

      // ① ＋ 菜单：模式分组两条（进入规划模式 / 任务清单）都在同一个 ＋ 里
      await page.getByTestId('composer-plus').click()
      const planEntry = page.getByTestId('composer-mode-plan')
      await expect(planEntry).toBeVisible()
      await expect.poll(async () => planEntry.getAttribute('data-disabled')).toBeNull()
      await expect(page.getByTestId('composer-mode-tasks')).toBeVisible()
      await shot('plus-menu', theme, size.label)
      await page.keyboard.press('Escape')

      // ② 任务摘要（真 todo：一进行中 + 一待办 + 一已完成）
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
        { text: 'SHOTS_TODO_DONE' }
      )
      await sendMessage(page, 'SHOT_TODO')
      await expect(page.getByTestId('composer-input')).toBeEnabled()
      const dock = page.getByTestId('task-list-dock')
      await expect(dock).toBeVisible()
      await expect(dock).toHaveAttribute('data-collapsed', 'true')
      await expect(dock).toContainText('1/3 已完成')
      await shot('tasks-collapsed', theme, size.label)
      await page.getByTestId('task-dock-toggle').click()
      await expect(dock).toHaveAttribute('data-collapsed', 'false')
      await expect(page.getByRole('list', { name: '任务列表' })).toBeVisible()
      await shot('tasks-expanded', theme, size.label)
      await page.getByTestId('task-dock-toggle').click()

      // ③ 运行中：挂住的流（不结束）+ 上方紧凑摘要还在
      provider.enqueue({ hang: true, text: '正在整理内容…' })
      await sendMessage(page, 'SHOT_HANG')
      await expect(page.getByTestId('composer-stop')).toBeVisible()
      await shot('running-summary', theme, size.label)

      // ④ 提问分页：新会话（③ 那一轮挂起留在原会话里）。
      // 注意**只挂一条回复**：ask_user 这一轮会挂起（用户没答就不会有下一跳），
      // 多挂一条文本回复会留在队列里、被后面那次发送吃掉（计划那一步就收不到工具调用了）。
      await newSession()
      provider.enqueue({ tool: 'ask_user', input: QUESTIONS })
      await sendMessage(page, 'SHOT_ASK')
      await expect(page.getByTestId('ask-user-card')).toBeVisible()
      const card = page.getByTestId('ask-user-card')
      await expect(page.getByTestId('ask-user-page')).toHaveText('第 1/3 题')
      // 逐题答一项：下一题只校验**当前题**，所以每题都要给出答案才翻得过去
      // （按 role 取第一项，避开选项描述进可访问名带来的名字匹配问题）
      await card.getByRole('radio').first().check()
      await shot('ask-first', theme, size.label)
      await page.getByTestId('ask-user-next').click()
      await expect(page.getByTestId('ask-user-page')).toHaveText('第 2/3 题')
      await card.getByRole('checkbox').first().check()
      await shot('ask-middle', theme, size.label)
      await page.getByTestId('ask-user-next').click()
      await expect(page.getByTestId('ask-user-page')).toHaveText('第 3/3 题')
      await card.getByRole('radio').first().check()
      await expect(page.getByRole('button', { name: '提交全部回答' })).toBeVisible()
      await shot('ask-last', theme, size.label)

      // ⑤ 计划：新会话 → 从同一个 ＋ 菜单进入规划 → 提交计划 → 摘要 / 展开
      await newSession()
      await clickModeEntry('composer-mode-plan')
      await expect(page.getByTestId('plan-approval-dock')).toBeVisible()
      const thread = await activeThreadId()
      const initial = await planState(thread)
      provider.enqueue(
        { tool: 'enter_plan', input: { expectedVersion: initial.version } },
        {
          tool: 'submit_plan',
          input: async () => {
            const current = await planState(thread)
            return {
              planId: current.planId,
              revision: current.revision,
              version: current.version,
              body: '# 用 Markdown 整理结果\n\n- 读取工作区里现有的文档\n- 生成要点摘要与明细两节\n- 写回一个 Markdown 文件并报告路径'
            }
          }
        }
      )
      await sendMessage(page, 'SHOT_PLAN')
      await expect(page.getByRole('button', { name: '批准此计划' })).toBeEnabled()
      await shot('plan-collapsed', theme, size.label)
      await page.getByTestId('plan-approval-toggle').click()
      await expect(page.getByRole('region', { name: '计划正文与反馈' })).toBeVisible()
      await shot('plan-expanded', theme, size.label)
    }

    try {
      for (const theme of THEMES) {
        for (const size of SIZES) await combo(theme, size)
      }
      writeFileSync(
        join(outDir, 'manifest.json'),
        `${JSON.stringify(
          {
            round: 'R81 UI layout adjustment',
            generatedAt: new Date().toISOString(),
            isolation:
              'e2e/fixtures/interactive 的临时 userData/home/工作区 + 本地 stub provider；不读凭据、不碰用户 profile',
            note: '截图证据；run 结束只截图，目视结论由看图的人单独写（本文件不冒充目视通过）',
            shots
          },
          null,
          2
        )}\n`
      )
      console.log(`[shots] 共 ${shots.length} 张 → ${outDir}`)
    } finally {
      await app.close()
      await provider.close()
    }
  })
})
