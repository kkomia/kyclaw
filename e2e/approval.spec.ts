import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { MOCK_WRITE_CONTENT } from '../src/mastra/model'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * 审批冒烟（plan T16 Step 3）：write → 审批卡 → 允许一次 → 断言文件真落盘。
 *
 * 触发方式：`KYCLAW_FORCE_MOCK=1` 下 mock 看到正文里的 `[[write:<路径>]]` 就调一次 write
 * （口令与写入内容都 import 自 `src/mastra/model.ts` 的真身，不另抄一份）。
 * 授权面：临时目录当工作区（mode=ask）经 settings.json 预置 —— 写类必须先问。
 *
 * 顺带留证：两张截图落 `smoke-t16/`（审批卡、允许后落盘），报告直接引用。
 */
const EVIDENCE_DIR = resolve(__dirname, '..', '.superpowers/sdd/2026-10-10-kyclaw-mvp/smoke-t16')

test('审批：写入文件 → 审批卡 → 允许一次 → 文件按内容落盘', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'kyclaw-e2e-workspace-'))
  const workspace = join(rootDir, '工作区')
  mkdirSync(workspace, { recursive: true })
  const fileName = 'e2e-审批.txt'
  const target = join(workspace, fileName)

  const launched = await launchApp({ settings: { workspaces: [{ path: workspace, mode: 'ask' }] } })
  const { page } = launched

  try {
    await waitForChat(page)
    await sendMessage(page, `帮我创建 ${fileName}：[[write:${fileName}]]`)

    // 审批卡：目标文件 + 四个决策按钮都在
    const card = page.getByTestId('approval-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('approval-target')).toContainText(fileName)
    for (const id of [
      'approval-allow-once',
      'approval-allow-session',
      'approval-allow-forever',
      'approval-deny'
    ]) {
      await expect(page.getByTestId(id)).toBeVisible()
    }

    // 审批是真闸门：还没点"允许"，文件不许在盘上
    expect(existsSync(target)).toBe(false)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: join(EVIDENCE_DIR, 'E2E-审批卡-写入文件.png') })

    await page.getByTestId('approval-allow-once').click()

    // 允许后：工具真执行 → 文件真落盘 → 内容与 mock 写的一字不差
    await expect.poll(() => existsSync(target), { timeout: 30_000 }).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(MOCK_WRITE_CONTENT)

    // 工具卡也收尾了（过程块跑完自动收起 → 展开看一眼"已完成"；过程块默认收起是 round 6 的口径）
    await expect(page.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
    await page.getByTestId('trace-toggle').click()
    await expect(page.getByTestId('tool-card')).toHaveAttribute('data-state', 'output-available')
    await expect(page.getByTestId('tool-state')).toHaveText('已完成')
    await page.screenshot({ path: join(EVIDENCE_DIR, 'E2E-允许后-落盘与已完成.png') })
  } finally {
    await closeApp(launched)
    rmSync(rootDir, { recursive: true, force: true })
  }
})
