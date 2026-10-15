import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { defaultSettings } from '../src/shared/settings'

/**
 * 0.1.1「更新内容」探针（不进常规 e2e 闸门；只在 `KYCLAW_UPDATE_NOTES=1` 时运行）。
 *
 * 真实本地 generic 源的端到端验证：起**打包件**（默认 dist/win-unpacked/kyclaw.exe，
 * 可用 KYCLAW_UPDATE_NOTES_EXE 覆盖），**真 electron-updater** 走真 HTTP 静态源（无 mock），
 * 串起"检查更新 → 显示这一版的更新日志"整条链路：
 *
 *   1. 启动前把 feed A 写进设置 → 启动那次检查就报 A 的版本，「更新内容」显示 A 那段（日志里
 *      刻意混着 HTML/图片/脚本：按字面量显示，页面上没有 img/script 元素、也不去取远程图片），
 *      下载完成后这一块仍在；
 *   2. 换 feed B（另一个版本、另一段日志）→ 显示 B 的、不再出现 A 的（换源/换版本不显示错版旧日志）；
 *   3. 换 feed C（没写日志）→ 那一块整块消失，状态照旧给结论（缺日志不拦更新）；
 *   4. 慢速 feed D **下载中**就能看到 D 的日志；下载到一半换成 feed E：D 的进度/完成事件都
 *      不再上账——状态是 E 的、不冒出 D 的版本、也不把 D 的日志挂到 E 上；等 D 那次下载收尾后
 *      E 照样能下载完（换源时的旧事件串扰）。
 *
 * 前置：当前代码已出过包（`pnpm package`，产物在 dist/；或 KYCLAW_UPDATE_NOTES_EXE 指到别的
 * win-unpacked）；用例先单起一次实例从「关于」栏读版本（造源要按它往上加档），再起要观察的那次。
 * 所有源都用 scripts/make-feed.mjs 现造（latest.yml + beta.yml 各一份、内容一样，免得渠道推导
 * 影响结论）、scripts/serve-feed.mjs 伺服——全在 127.0.0.1，不碰网络、不碰真实 %APPDATA%\kyclaw。
 * 临时件（源目录、profile、静态源请求日志、截图）都在工作区内：
 * `.superpowers/sdd/2026-10-10-kyclaw-mvp/update-notes-probe/<时间戳-pid>/`（不入库，跑完留着当证据）。
 *
 * 用法：KYCLAW_UPDATE_NOTES=1 pnpm exec playwright test e2e/update-notes.spec.ts
 */
const repoRoot = resolve(__dirname, '..')
const exePath =
  process.env.KYCLAW_UPDATE_NOTES_EXE ?? join(repoRoot, 'dist', 'win-unpacked', 'kyclaw.exe')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp')
/** 这一次探针的独有目录（每次跑一个；不清理，证据都在里面） */
const runDir = join(evidenceDir, 'update-notes-probe', `${Date.now()}-${process.pid}`)
/** 慢速源：假安装包 512KB、每 8KB 停 250ms ≈ 16 秒，够换一次源 */
const SLOW_FEED = { size: '524288', delayMs: 250, chunkBytes: 8192 }
const SLOW_FEED_MS = 20_000

/** 比当前版本高几档的版本号（打包件的版本从「关于」栏读，见用例里） */
function bumped(version: string, patch: number): string {
  const [major = '0', minor = '0', rest = '0'] = version.split('-')[0].split('.')
  return `${major}.${minor}.${Number(rest) + patch}`
}

/**
 * 造一个源：假安装包 + 指定的日志（走 scripts/make-feed.mjs，与出包/冒烟同一套口径）。
 * latest.yml 与 beta.yml 各写一份（内容一样）：打包件是正式版还是预发布版都能直接读到，
 * 不靠渠道兜底的那次 404 重试（那是另一件事，别混进这个探针）。
 */
function writeFeed(dir: string, version: string, notes?: string, size = '65536'): void {
  for (const channel of ['latest', 'beta']) {
    const args = [
      join(repoRoot, 'scripts', 'make-feed.mjs'),
      dir,
      version,
      size,
      '--channel',
      channel
    ]
    if (notes !== undefined) {
      const notesFile = join(runDir, `notes-${version}-${channel}.md`)
      writeFileSync(notesFile, notes, 'utf8')
      args.push('--notes-file', notesFile)
    }
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`make-feed 失败：${result.stderr ?? result.stdout}`)
  }
}

/** 起静态源（scripts/serve-feed.mjs）：请求日志进文件；用一次探活请求等它就绪 */
async function startFeed(
  dir: string,
  port: number,
  logFile: string,
  slow?: { delayMs: number; chunkBytes: number }
): Promise<ChildProcess> {
  const args = [join(repoRoot, 'scripts', 'serve-feed.mjs'), dir, String(port)]
  if (slow !== undefined) args.push(String(slow.delayMs), String(slow.chunkBytes))
  const fd = openSync(logFile, 'a')
  const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd] })
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/latest.yml`)
      if (res.status === 200 || res.status === 404) return child
    } catch {
      // 还没起来，重试
    }
    if (Date.now() > deadline) throw new Error(`静态源没起来：127.0.0.1:${port}`)
    await new Promise((done) => setTimeout(done, 150))
  }
}

/** 预置一份完整设置（只改更新源）：让启动那次检查就朝本地源，别耗在打包内置的局域网地址上 */
function seedSettings(userDataDir: string, updateUrl: string): string {
  const file = join(userDataDir, 'settings.json')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...defaultSettings(), updateUrl }, null, 2)}\n`, 'utf8')
  return file
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

/**
 * 读打包件的版本号（「关于」栏）。造源要在**启动之前**写盘（让启动那次检查就朝本地源），
 * 所以先单起一次实例问版本、关掉，再造源、再起真正要观察的那一次。
 */
async function readPackagedVersion(): Promise<string> {
  const app = await electron.launch({
    executablePath: exePath,
    args: [`--user-data-dir=${join(runDir, 'probe-profile')}`]
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      window.location.hash = '#/settings/about'
    })
    const label = page.getByTestId('about-version')
    await expect(label).toContainText('版本', { timeout: 60_000 })
    const current = ((await label.textContent()) ?? '').replace('版本', '').trim()
    expect(current, '要先从「关于」栏读到打包件的版本号').not.toBe('—')
    return current
  } finally {
    await app.close().catch(() => undefined)
  }
}

test.describe('0.1.1 更新内容（打包件 + 本地 generic 源）', () => {
  test.skip(process.env.KYCLAW_UPDATE_NOTES !== '1', 'KYCLAW_UPDATE_NOTES=1 时才跑')

  test('启动检查显示这一版的更新日志；换源换版本不显示错版旧日志；换源时的旧下载事件不串到新源', async () => {
    test.setTimeout(10 * 60 * 1000)
    mkdirSync(runDir, { recursive: true })
    const feedA = join(runDir, 'feed-a')
    const feedB = join(runDir, 'feed-b')
    const feedC = join(runDir, 'feed-c')
    const feedD = join(runDir, 'feed-d')
    const feedE = join(runDir, 'feed-e')
    const servers: ChildProcess[] = []

    const current = await readPackagedVersion()
    const versionA = bumped(current, 1)
    const versionB = bumped(current, 2)
    const versionC = bumped(current, 3)
    const versionD = bumped(current, 4)
    const versionE = bumped(current, 5)
    // 源上的日志：A 里刻意混进 HTML/图片/脚本（第 2 步要按字面量显示、且不发起请求）
    const notesA = `${versionA}\n\n这一版的更新内容：\n- A 源上的第一条\n<img src="http://127.0.0.1:18599/pixel.png">\n<script>window.__pwned = 1</script>`
    const notesB = `${versionB}\n\n这一版的更新内容：\n- B 源上的第一条`
    const notesD = `${versionD}\n\n这一版的更新内容：\n- D 源上的第一条`

    writeFeed(feedA, versionA, notesA)
    writeFeed(feedB, versionB, notesB)
    writeFeed(feedC, versionC)
    writeFeed(feedD, versionD, notesD, SLOW_FEED.size)
    writeFeed(feedE, versionE)
    servers.push(await startFeed(feedA, 18562, join(runDir, 'feed-a.log')))
    servers.push(await startFeed(feedB, 18563, join(runDir, 'feed-b.log')))
    servers.push(await startFeed(feedC, 18564, join(runDir, 'feed-c.log')))
    servers.push(
      await startFeed(feedD, 18565, join(runDir, 'feed-d.log'), {
        delayMs: SLOW_FEED.delayMs,
        chunkBytes: SLOW_FEED.chunkBytes
      })
    )
    servers.push(await startFeed(feedE, 18566, join(runDir, 'feed-e.log')))

    // 更新源先写进设置再启动：这样启动那次检查就朝 feed A（不去碰打包内置的那个局域网地址，
    // 那台要是在线，它的下载会把 electron-updater 的"正在下载"占住，后面的换源就不干净了）
    const userDataDir = join(runDir, 'profile')
    const settingsFile = seedSettings(userDataDir, 'http://127.0.0.1:18562/')
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
      const status = page.getByTestId('about-update-status')
      const notes = page.getByTestId('about-release-notes')
      const setSource = async (port: number): Promise<void> => {
        await page.getByTestId('about-update-url').fill(`http://127.0.0.1:${port}/`)
        await page.getByTestId('about-update-url-save').click()
        await expectSavedUpdateUrl(settingsFile, `http://127.0.0.1:${port}/`)
      }

      // 1. 启动检查（feed A，不用点按钮）：状态报 A 的版本，「更新内容」显示 A 的日志
      await expect(status).toContainText(versionA, { timeout: 180_000 })
      await expect(notes).toContainText('A 源上的第一条', { timeout: 60_000 })

      // 2. 安全渲染：HTML/图片/脚本按字面量显示（没有 img/script 元素，也就不可能去取远程图片）
      await expect(notes).toContainText('<img src="http://127.0.0.1:18599/pixel.png">')
      await expect(notes.locator('img')).toHaveCount(0)
      await expect(notes.locator('script')).toHaveCount(0)
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
        undefined
      )
      // 下载完成后这一块还在（本地源下载是瞬时的，"下载中可看"由第 5 步的慢速源钉住）
      await expect(status).toContainText(`新版本 ${versionA} 已下载`, { timeout: 120_000 })
      await expect(notes).toContainText('A 源上的第一条')
      await page.screenshot({ path: join(runDir, 'a.png') })

      // 3. 换 feed B：显示 B 的日志，A 的那一段不再出现（下载完仍在）
      await setSource(18563)
      await page.getByTestId('about-check').click()
      await expect(status).toContainText(`新版本 ${versionB} 已下载`, { timeout: 120_000 })
      await expect(notes).toContainText('B 源上的第一条', { timeout: 20_000 })
      await expect(notes).not.toContainText('A 源上的第一条')
      await page.screenshot({ path: join(runDir, 'b.png') })

      // 4. 换 feed C（没写日志）：那一块整块消失，状态照旧报 C 的版本、下载也照旧走完
      await setSource(18564)
      await page.getByTestId('about-check').click()
      await expect(status).toContainText(versionC, { timeout: 120_000 })
      await expect(page.getByTestId('about-release')).toHaveCount(0)
      await expect(status).toContainText(versionC)
      await expect(status).toContainText(`新版本 ${versionC} 已下载`, { timeout: 120_000 })
      await page.screenshot({ path: join(runDir, 'c.png') })

      // 5. 慢速 feed D：下载中就能看到这一版的日志（本地源下载是瞬时的，只有慢速源留得住这个窗口）
      await setSource(18565)
      await page.getByTestId('about-check').click()
      await expect(notes).toContainText('D 源上的第一条', { timeout: 120_000 })
      await expect(status).toContainText(`正在下载 ${versionD}`, { timeout: 60_000 })
      await page.screenshot({ path: join(runDir, 'd-downloading.png') })

      // 6. D 下载到一半换成 feed E：D 的进度与完成事件都不再上账——状态是 E 的、日志块不出现
      await setSource(18566)
      await page.getByTestId('about-check').click()
      await expect(status).toContainText(versionE, { timeout: 120_000 })
      await expect(status).not.toContainText(versionD)
      await expect(page.getByTestId('about-release')).toHaveCount(0)

      // 等 D 那次下载跑完（完成事件迟到）：还是 E 的版本、也不会冒出 D 的日志
      await page.waitForTimeout(SLOW_FEED_MS)
      await expect(status).not.toContainText(versionD)
      await expect(status).toContainText(versionE)
      await expect(page.getByTestId('about-release')).toHaveCount(0)

      // 7. D 那次下载收尾后再点一次检查：E 这一版能真下载完（换源后的源照样能用）
      await page.getByTestId('about-check').click()
      await expect(status).toContainText(`新版本 ${versionE} 已下载`, { timeout: 120_000 })
      await expect(page.getByTestId('about-release')).toHaveCount(0)
      await page.screenshot({ path: join(runDir, 'e.png') })
    } finally {
      await app.close().catch(() => undefined)
      for (const server of servers) server.kill()
    }
  })
})
