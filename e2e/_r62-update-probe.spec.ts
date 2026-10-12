import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

/**
 * R62 更新流探针（不进常规 e2e 闸门；只在 KYCLAW_R62_UPDATE=1 时运行）：
 * 直接起**打包件**（dist-alt/win-unpacked/kyclaw.exe，内含 app-update.yml → generic 源指局域网
 * MinIO），在「设置 → 关于」里点「检查更新」，验证：发现新版本 → 自动下载 → 已下载（不点安装）。
 *
 * 前提：dist-alt 已按 beta.3 打包；MinIO 的 releases/beta.yml 指向一个更高的版本号
 * （用 _r62-fake-beta.yml 的技巧：版本号抬到 beta.4，文件与 sha512 仍是 beta.3 的真包）。
 * 用法：KYCLAW_R62_UPDATE=1 pnpm exec playwright test e2e/_r62-update-probe.spec.ts
 */
const repoRoot = resolve(__dirname, '..')
const exePath = join(repoRoot, 'dist-alt', 'win-unpacked', 'kyclaw.exe')

test.describe('R62 更新流（打包件 + MinIO 源）', () => {
  test.skip(
    process.env.KYCLAW_R62_UPDATE !== '1',
    'KYCLAW_R62_UPDATE=1 时才跑（需要 dist-alt 打包件与 MinIO 源）'
  )

  test('打包 beta.3 对着 MinIO 源检查更新并完成下载（不安装）', async () => {
    test.setTimeout(10 * 60 * 1000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-r62-upd-'))
    const app = await electron.launch({
      executablePath: exePath,
      args: [`--user-data-dir=${userDataDir}`]
    })
    const page = await app.firstWindow()
    try {
      await page.waitForLoadState('domcontentloaded')
      await page.evaluate(() => {
        window.location.hash = '#/settings/about'
      })
      await expect(page.getByTestId('about-version')).toContainText('0.1.0-beta.3', {
        timeout: 30_000
      })
      await page.getByTestId('about-check').click()
      const status = page.getByTestId('about-update-status')
      // 发现新版本（beta.yml 里是抬过版本的 beta.4，文件与 sha512 指向 beta.3 的真安装包）
      await expect(status).toContainText('发现新版本 0.1.0-beta.4', { timeout: 30_000 })
      // 自动下载完成（188MB 走局域网，给足时间）
      await expect(status).toContainText('已下载', { timeout: 8 * 60 * 1000 })
      await page.screenshot({
        path: join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r62-update-flow.png')
      })
    } finally {
      await app.close()
    }
  })
})
