import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

/**
 * R63 更新源探针（不进常规 e2e 闸门；只在 KYCLAW_R63_UPDATE=1 时运行）：
 * 起**打包件**（默认 dist-alt/win-unpacked/kyclaw.exe，可用 KYCLAW_R63_EXE 覆盖），
 * 在 设置 → 关于 里**只填一个 URL（不带任何密钥）**，验证整条更新链路：
 *
 *   1. 指向 beta.yml 齐全的本地源 → 保存 → 检查更新 → 发现新版本 → 自动下载 → 已下载；
 *   2. 清空地址保存 → 再检查 → 回到打包内置源（MinIO）：可达 =「已是最新版本」、
 *      不在那个局域网 =「检查失败」——都证明源已切回内置（反断言不许再出现本机源的 beta.4）；
 *   3. 换一个**只有 latest.yml** 的源（beta 包先找 beta.yml，404 后靠渠道兜底换 latest）
 *      → 照样发现新版本并下载完成。
 *
 * 每步保存后先断言 settings.json 里 updateUrl 真落盘（证明保存过了主进程），再看检查结果；
 * 两个静态源的请求日志落 `_r63-feed-{a,b}.log`（谁在什么时候来要过哪个文件，全在证据里）。
 * 依赖：dist-alt（或 KYCLAW_R63_EXE 指到的）已按当前代码打包；本机能起 node 静态源。
 * 用法：KYCLAW_R63_UPDATE=1 pnpm exec playwright test e2e/_r63-update-settings.spec.ts
 */
const repoRoot = resolve(__dirname, '..')
const exePath =
  process.env.KYCLAW_R63_EXE ?? join(repoRoot, 'dist-alt', 'win-unpacked', 'kyclaw.exe')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp')

/** 造一个静态源目录：假安装包 + 指定渠道的 yml（sha512 真算，下载校验才过得去） */
function writeFeed(dir: string, version: string, channel: 'beta' | 'latest'): void {
  const size = 64 * 1024
  const fileName = `kyclaw-${version}-setup.exe`
  const payload = Buffer.from(
    `kyclaw ${version} 本地模拟更新源（冒烟证据，不是真安装包）\n`.repeat(2000),
    'utf8'
  ).subarray(0, size)
  const sha512 = createHash('sha512').update(payload).digest('base64')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), payload)
  writeFileSync(
    join(dir, `${channel}.yml`),
    `version: ${version}
files:
  - url: ${fileName}
    sha512: ${sha512}
    size: ${payload.length}
path: ${fileName}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`
  )
}

/** 起静态源（scripts/serve-feed.mjs）：请求日志进文件；用一次探活请求等它就绪（会出现在日志里） */
async function startFeed(dir: string, port: number, logFile: string): Promise<ChildProcess> {
  const fd = openSync(logFile, 'a')
  const child = spawn(
    process.execPath,
    [join(repoRoot, 'scripts', 'serve-feed.mjs'), dir, String(port)],
    { stdio: ['ignore', fd, fd] }
  )
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/beta.yml`)
      if (res.status === 200 || res.status === 404) return child
    } catch {
      // 还没起来，重试
    }
    if (Date.now() > deadline) throw new Error(`静态源没起来：127.0.0.1:${port}`)
    await new Promise((done) => setTimeout(done, 150))
  }
}

/** 等 settings.json 里 updateUrl 落成期望值（证明"保存"真的过了主进程、落了盘） */
async function expectSavedUpdateUrl(settingsFile: string, url: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as { updateUrl?: unknown }
          return parsed.updateUrl
        } catch {
          return undefined
        }
      },
      { timeout: 10_000, message: `settings.json 的 updateUrl 应落成 ${JSON.stringify(url)}` }
    )
    .toBe(url)
}

test.describe('R63 更新源（打包件 + 设置里只填 URL）', () => {
  test.skip(process.env.KYCLAW_R63_UPDATE !== '1', 'KYCLAW_R63_UPDATE=1 时才跑')

  test('填 URL 即更新；清空回内置源；只有 latest.yml 的源靠渠道兜底照样通', async () => {
    test.setTimeout(10 * 60 * 1000)
    const feedA = join(mkdtempSync(join(tmpdir(), 'kyclaw-r63-feed-')), 'a')
    const feedB = join(mkdtempSync(join(tmpdir(), 'kyclaw-r63-feed-')), 'b')
    writeFeed(feedA, '0.1.0-beta.4', 'beta')
    writeFeed(feedB, '0.1.0-beta.5', 'latest')
    const serverA = await startFeed(feedA, 18552, join(evidenceDir, '_r63-feed-a.log'))
    const serverB = await startFeed(feedB, 18553, join(evidenceDir, '_r63-feed-b.log'))
    const userDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-r63-upd-'))
    const settingsFile = join(userDataDir, 'settings.json')
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
      // 没填之前：输入框的占位提示 = 打包内置源的地址（MinIO）
      await expect(page.getByTestId('about-update-url')).toHaveAttribute(
        'placeholder',
        /192\.168\.31\.18/,
        { timeout: 20_000 }
      )

      // 1. 只填 URL（无密钥）→ 保存（确认真落盘）→ 检查 → 发现 beta.4 → 已下载
      await page.getByTestId('about-update-url').fill('http://127.0.0.1:18552/')
      await page.getByTestId('about-update-url-save').click()
      await expectSavedUpdateUrl(settingsFile, 'http://127.0.0.1:18552/')
      await page.getByTestId('about-check').click()
      const status = page.getByTestId('about-update-status')
      await expect(status).toContainText('发现新版本 0.1.0-beta.4', { timeout: 30_000 })
      await expect(status).toContainText('已下载', { timeout: 60_000 })
      await page.screenshot({ path: join(evidenceDir, '_r63-update-settings.png') })

      // 2. 清空地址保存 → 再检查 → 回到打包内置源（MinIO）。通达时 =「已是最新版本」（远端 beta.yml =
      //    当前版本）；不在那个局域网时 =「检查失败」——两者都证明源已切回内置。反断言钉住"不再出现
      //    本机源上的 beta.4"：若旧源没被换掉，这里的检查会报出 发现新版本 0.1.0-beta.4。
      await page.getByTestId('about-update-url').fill('')
      await page.getByTestId('about-update-url-save').click()
      await expectSavedUpdateUrl(settingsFile, '')
      await page.getByTestId('about-check').click()
      await expect(status).toContainText(/已是最新版本|检查失败/, { timeout: 90_000 })
      await expect(status).not.toContainText('0.1.0-beta.4')

      // 3. 只有 latest.yml 的源：beta 包先找 beta.yml（404）→ 渠道兜底换 latest → 发现 beta.5 → 已下载
      await page.getByTestId('about-update-url').fill('http://127.0.0.1:18553/')
      await page.getByTestId('about-update-url-save').click()
      await expectSavedUpdateUrl(settingsFile, 'http://127.0.0.1:18553/')
      await page.getByTestId('about-check').click()
      await expect(status).toContainText('发现新版本 0.1.0-beta.5', { timeout: 30_000 })
      await expect(status).toContainText('已下载', { timeout: 60_000 })
      await page.screenshot({ path: join(evidenceDir, '_r63-update-fallback.png') })
    } finally {
      await app.close().catch(() => undefined)
      serverA.kill()
      serverB.kill()
    }
  })
})
