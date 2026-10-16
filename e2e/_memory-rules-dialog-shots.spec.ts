import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'

/**
 * 记忆栏返工的**目视证据探针**（不进常规 e2e 闸门；只在 KYCLAW_MEMORY_SHOTS=1 时运行）。
 *
 *   pnpm build && KYCLAW_MEMORY_SHOTS=1 pnpm exec playwright test e2e/_memory-rules-dialog-shots.spec.ts
 *
 * 用**隔离实例**拍（e2e/fixtures/interactive 的 createInteractiveApp：临时 userData + 临时 home +
 * 临时工作区 + 本地 stub provider，不读任何真实凭据、不碰用户 profile），产物落
 * `.superpowers/memory-rows-rework/run-<时间戳>/`。
 *
 * 覆盖：
 *   light/dark × 1280×800：memory-rows（两张卡）/ rules-dialog（弹窗）/ memory-dialog（对照）
 *   light × 800×800（窄窗）：memory-rows / rules-dialog
 *
 * 断言只钉"该出现的东西在、不该出现的不在"（比如关闭态下主页面**没有** textarea / 保存按钮、
 * 两张卡都在、弹窗体里有输入框）；**视觉结论由跑完逐张看图的人写**，本文件不代替目视。
 */
const enabled = process.env.KYCLAW_MEMORY_SHOTS === '1'
const evidenceRoot = resolve('.superpowers/memory-rows-rework')

/** 给编辑器一点可见内容（让截图里的 textarea / 项目下拉不是空的） */
const SAMPLE_RULES = '这一轮示例：\n- 交付物先给结论，再给依据\n- 数字要带单位与口径\n'

type Theme = 'light' | 'dark'
const PASSES: Array<{ theme: Theme; width: number; height: number; label: string }> = [
  { theme: 'light', width: 1280, height: 800, label: 'normal' },
  { theme: 'dark', width: 1280, height: 800, label: 'normal' },
  { theme: 'light', width: 800, height: 800, label: 'narrow' }
]

test.describe('记忆栏返工 · 目视证据（隔离实例）', () => {
  test.skip(!enabled, '只在 KYCLAW_MEMORY_SHOTS=1 时运行（隔离实例截图，不进常规 e2e 闸门）')
  test.setTimeout(600_000)

  test('浅/深色 + 窄窗：记忆两张卡 + 记忆指令弹窗 + 记忆空间弹窗', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const runId = `run-${Date.now()}`
    const outDir = join(evidenceRoot, runId)
    mkdirSync(outDir, { recursive: true })
    const shots: Array<{ name: string; file: string; theme: string; size: string }> = []

    try {
      // 铺一点真实内容：一个项目（项目下拉里能看到它）+ 一份全局记忆指令
      await page.evaluate(
        async ({ rules, workspace }) => {
          if (!window.kyclaw) throw new Error('缺少生产桥')
          await window.kyclaw.projects.create('示例项目', workspace)
          await window.kyclaw.settings.update({ globalRules: rules })
        },
        { rules: SAMPLE_RULES, workspace: app.workspace }
      )
      await page.reload()
      await page.waitForFunction(() => !!window.kyclaw?.settings)

      const setTheme = async (theme: Theme): Promise<void> => {
        await page.evaluate(async (next) => {
          if (!window.kyclaw) throw new Error('缺少生产桥')
          await window.kyclaw.settings.update({ theme: next })
        }, theme)
        await page.reload()
        await page.waitForFunction(() => !!window.kyclaw?.settings)
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
            win.setBounds({ x: 40, y: 40, width: size.width, height: size.height })
          },
          { width, height }
        )
        await page.waitForTimeout(250)
      }

      const openMemorySection = async (): Promise<void> => {
        await page.evaluate(() => {
          location.hash = '/settings/memory'
        })
        await page.getByTestId('settings-group-memory').waitFor({ timeout: 20_000 })
        // 页面进场动效（.3s）走完再拍，别拍到残影
        await page.waitForTimeout(400)
      }

      const shot = async (state: string, pass: (typeof PASSES)[number]): Promise<void> => {
        const file = join(outDir, `${pass.theme}-${pass.label}-${state}.png`)
        await page.screenshot({ path: file, fullPage: true })
        shots.push({
          name: `${pass.theme}-${pass.label}-${state}`,
          file,
          theme: pass.theme,
          size: pass.label
        })
        console.log(`[shots] ${pass.theme}/${pass.label}/${state} → ${file}`)
      }

      for (const pass of PASSES) {
        await resizeTo(pass.width, pass.height)
        await setTheme(pass.theme)
        await openMemorySection()

        // ① 两张卡：入口都在；重家伙（textarea / 项目下拉 / 保存）不该在主页面
        const base = page.getByTestId('memory-card-base')
        const rulesCard = page.getByTestId('memory-card-rules')
        await expect(base).toBeVisible()
        await expect(rulesCard).toBeVisible()
        await expect(base).toContainText('语义召回')
        await expect(base).toContainText('记忆空间')
        await expect(rulesCard).toContainText('记忆指令')
        await expect(page.getByTestId('recall-enabled')).toBeVisible()
        await expect(page.getByTestId('recall-config-toggle')).toBeVisible()
        await expect(page.getByTestId('memory-space-open')).toBeVisible()
        await expect(page.getByTestId('rules-open')).toBeVisible()
        await expect(page.getByLabel('全局记忆指令')).toHaveCount(0)
        await expect(page.getByTestId('rules-project-select')).toHaveCount(0)
        await shot('memory-rows', pass)

        // ② 记忆指令弹窗（编辑器全在里面；标题只一处；输入框是共享 field 皮）
        await page.getByTestId('rules-open').click()
        const body = page.getByTestId('rules-dialog-body')
        await body.waitFor({ timeout: 10_000 })
        await expect(page.getByLabel('全局记忆指令')).toBeVisible()
        await expect(body.getByText('记忆指令', { exact: true })).toHaveCount(0)
        await expect(body.getByText('全局', { exact: true })).toBeVisible()
        await expect(body.getByText('项目', { exact: true })).toBeVisible()
        await page.waitForTimeout(300)
        await shot('rules-dialog', pass)
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('rules-dialog-body')).toHaveCount(0)

        // ③ 记忆空间弹窗（原有的那一行，确认两张卡与弹窗是一套皮）
        await page.getByTestId('memory-space-open').click()
        await page.getByTestId('memory-space-body').waitFor({ timeout: 10_000 })
        await page.waitForTimeout(300)
        await shot('memory-dialog', pass)
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('memory-space-body')).toHaveCount(0)
      }

      writeFileSync(join(outDir, 'shots.json'), `${JSON.stringify(shots, null, 2)}\n`, 'utf8')
    } finally {
      await app.close()
      await provider.close?.()
    }
  })
})
