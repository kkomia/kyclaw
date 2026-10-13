import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { readZipEntries } from '../src/mastra/tools/artifact-check'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * R63 真实场景探针（不进常规 e2e 闸门；只在 KYCLAW_R63_REAL=1 时运行）：
 * 真模型 + 真产出物，验证「用户在画廊固定模板 → create_ppt 真用上它」这条产品链路 ——
 *
 *   1. 在对话页「PPT」胶囊里选「学术紫」（走 UI，与真实用户一致）；
 *   2. 发一条**不指定模板**的 PPT 需求，等回合跑完；
 *   3. 找到产出的 .pptx：封面（ppt/slides/slide1.xml）里应出现 学术紫 的强调色 5B3FA8
 *      （band 色带按 coverPlan 画在封面上，这份几何只有该模板有）。
 *
 * 密钥播种与 r62 场景同款：safeStorage 密文与身份绑定，预置密文在隔离 userData 下解不开，
 * 所以走设置页把明文交给应用自己加密；明文默认读本机探针产物，也可用 KYCLAW_R63_KEY 覆盖。
 * 前置：先 `pnpm build`（harness 起的是 out/ 产物）。
 * 用法：KYCLAW_R63_REAL=1 pnpm exec playwright test e2e/_r63-ppt-real.spec.ts
 */
const repoRoot = resolve(__dirname, '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp')
const realUserData = join(process.env.APPDATA ?? '', 'kyclaw')

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

async function waitForIdle(page: Page, timeoutMs = 420_000): Promise<void> {
  const send = page.getByTestId('composer-send')
  const stop = page.getByTestId('composer-stop')
  await expect(stop).toBeVisible({ timeout: 30_000 })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await send.isVisible()) && !(await stop.isVisible())) {
      await page.waitForTimeout(2_000)
      if (await send.isVisible()) return
    }
    await page.waitForTimeout(500)
  }
  throw new Error('等待回合结束超时')
}

test.describe('R63 真实场景（选模板 → 真模型出 PPT）', () => {
  test.skip(process.env.KYCLAW_R63_REAL !== '1', 'KYCLAW_R63_REAL=1 时才跑真模型场景')

  test('画廊选「学术紫」→ 真模型 create_ppt 用上它（封面落 5B3FA8）', async () => {
    test.setTimeout(30 * 60 * 1000)
    const realSettings = JSON.parse(readFileSync(join(realUserData, 'settings.json'), 'utf8')) as {
      providers?: unknown
      langfuse?: unknown
    }
    const keysFile = join(evidenceDir, '_r62-probe-app', '_r62-lf-keys.json')
    const plainKey =
      process.env.KYCLAW_R63_KEY ??
      (JSON.parse(readFileSync(keysFile, 'utf8')) as Record<string, string>)['deepseek__plain'] ??
      ''
    const ws = mkdtempSync(join(tmpdir(), 'kyclaw-r63-ws-'))
    const launched = await launchApp({
      settings: {
        providers: realSettings.providers as never,
        defaultWorkspace: ws,
        workspaces: [{ path: ws, mode: 'full' }],
        ...(realSettings.langfuse === undefined ? {} : { langfuse: realSettings.langfuse as never })
      },
      env: { KYCLAW_FORCE_MOCK: '0' }
    })
    const { page } = launched
    try {
      await waitForChat(page)
      // 1. 密钥交给应用自己加密（同 r62 场景：设置页 → 模型 → deepseek → 填明文 → 保存）
      await page.evaluate(() => {
        window.location.hash = '#/settings/model'
      })
      await page.getByTestId('provider-deepseek').getByRole('button').first().click()
      await page.getByTestId('provider-deepseek-key').fill(plainKey)
      await page.getByTestId('provider-deepseek-save').click()
      await expect(page.getByTestId('provider-deepseek-key-status')).toHaveText('已配置', {
        timeout: 20_000
      })
      await page.evaluate(() => {
        window.location.hash = '#/chat'
      })
      await waitForChat(page)

      // 2. 画廊里选「学术紫」（走 UI 落盘）
      await page.getByTestId('composer-ppt-template').click()
      await expect(page.getByTestId('ppt-template-gallery')).toBeVisible({ timeout: 10_000 })
      await page.getByTestId('ppt-template-学术紫').click()
      await expect(page.getByTestId('composer-ppt-template')).toHaveText('PPT · 学术紫')
      await page.screenshot({ path: join(evidenceDir, '_r63-ppt-real-select.png') })

      // 3. 真模型回合（刻意不指定模板）
      const started = Date.now()
      await sendMessage(
        page,
        '用 create_ppt 做一份《模板联调验收》PPT：封面 + 两页正文 + 结尾页。做完告诉我文件路径。'
      )
      await waitForIdle(page)
      const durationMs = Date.now() - started
      console.log(`[r63] PPT 回合耗时 ${(durationMs / 1000).toFixed(1)}s`)
      await page.screenshot({ path: join(evidenceDir, '_r63-ppt-real-chat.png') })

      // 4. 产出物：pptx 落到工作区，封面 XML 里应出现 学术紫 的 band 色 5B3FA8
      const produced = listFiles(ws)
      const pptx = produced.find((file) => file.toLowerCase().endsWith('.pptx'))
      expect(
        pptx,
        `应有 .pptx 产出（实际：${produced.map((f) => relative(ws, f)).join('、')}）`
      ).toBeTruthy()
      const bytes = readFileSync(pptx as string)
      const entries = readZipEntries(new Uint8Array(bytes))
      const slide1 = entries.get('ppt/slides/slide1.xml')?.toString('utf8') ?? ''
      expect(slide1, '封面应是「学术紫」的 band 构图（左侧通栏色带 5B3FA8）').toContain('5B3FA8')
      copyFileSync(pptx as string, join(evidenceDir, '_r63-ppt-real-output.pptx'))
      console.log(
        `[r63] 产出 ${relative(ws, pptx as string)} (${statSync(pptx as string).size} bytes)`
      )
    } finally {
      await closeApp(launched)
    }
  })
})
