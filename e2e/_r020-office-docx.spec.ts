/**
 * M3-S2 真机探针：Office 文档注册表 + 打开/读字节（**preview 形态**，起 `out/` 构建产物，不打包）。
 *
 * 跑法：
 *   corepack pnpm build
 *   corepack pnpm exec playwright test e2e/_r020-office-docx.spec.ts e2e/_r020-office-surface.spec.ts --reporter=line
 *
 * 它验的是方案 §9-S2 / §10.2 的门（`.superpowers/handover/office-docx-plan.md`）：
 *   ① 打开后出现 DOCX 标签（真实选择器被 `KYCLAW_OFFICE_OPEN` 测试 env 绕过；生产不设即不存在）；
 *   ② 进程外算 fixture 的 sha256 / 字节数，与壳 `office:read` 的字节、面内展示一致；
 *      `absolutePath` 是 realpath 归一后的绝对路径（只读匹配用，不作授权参数）；
 *   ③ 同一文件再打开一次仍只有 1 个标签（documentId 去重 → 只激活）；再次打开同一标签 `alreadyOpen:true`；
 *   ④ 面内 `doc:open` 有可断言证据（`surface-doc-open`）；面无 `window.kyclaw`、主 frame wasm 仍被拒；
 *   ⑤ 0 外请（webRequest 只记录不 cancel；环回 127.0.0.1 的 agent 服务归 localhost 一类）；
 *   ⑥ 主题 P2：深色主题真正传到面里（`data-surface-theme` / body 背景），且**运行中切换不重载 iframe**。
 *   ⑦ S1 探针回归：与本文件同一次命令一起跑（见上面跑法）。
 *
 * fixture：用产品 devDep `docx@9.9.0` 在探针进程内生成（含中文段落），只写临时目录，**二进制不入 git**。
 * 证据：`.superpowers/office-docx/s2/`（screenshot + probe-result.json；本地，不入库）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { closeApp, launchApp, waitForChat } from './harness'

const SURFACE_PREFIX = 'kyclaw-office://surface'
const EVIDENCE_DIR = resolve('.superpowers', 'office-docx', 's2')

interface NetworkEntry {
  url: string
  type: string
  initiatorOrigin: string | null
}

const ALLOWED_BUCKETS = new Set([
  'kyclaw-office:',
  'file:',
  'data:',
  'blob:',
  'devtools:',
  'chrome-extension:',
  'about:',
  'localhost'
])
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

function bucketOf(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return 'unparsable'
  }
  if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
    if (LOOPBACK_HOSTNAMES.has(hostname)) return 'localhost'
  }
  return parsed.protocol
}

/** 用产品 devDep `docx` 生成一份带中文段落的真实 DOCX 到临时目录 */
async function writeDocxFixture(): Promise<{
  directory: string
  filePath: string
  bytes: Buffer
  sha256: string
  absolutePath: string
}> {
  const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-e2e-'))
  const document = new Document({
    creator: 'kyclaw M3-S2 probe',
    title: 'M3-S2 中文夹具',
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun('kyclaw M3-S2 中文夹具：项目计划')]
          }),
          new Paragraph({
            children: [new TextRun('第二段：保存链路（S3）与编辑器内核都还没接。')]
          }),
          new Paragraph({
            children: [new TextRun('第三段：这段文字只用来占字节数，不参与任何断言。')]
          })
        ]
      }
    ]
  })
  const bytes = await Packer.toBuffer(document)
  const filePath = join(directory, '方案-项目计划.docx')
  writeFileSync(filePath, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { directory, filePath, bytes, sha256, absolutePath: realpathSync.native(filePath) }
}

test.describe('M3-S2 · Office 文档注册表 + 打开/读字节（真机 preview）', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('打开/去重/读字节/absolutePath/面收到 doc:open/0 外请/深色主题', async ({}, testInfo) => {
    test.skip(true, '0.2.0 下架 projects/session-ppt-templates（501），见 PB-041')
    test.setTimeout(240_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    const fixture = await writeDocxFixture()
    const launched = await launchApp({
      // 主题走 system：运行中切换用 nativeTheme.themeSource 驱动真实链路（见 ⑥）
      settings: { theme: 'system' },
      // 测试专用绕过原生选择器（仅未打包构建生效；生产不设即不存在）
      env: { KYCLAW_OFFICE_OPEN: fixture.filePath }
    })
    const { app, page } = launched

    const consoleErrors: { text: string; url: string }[] = []
    const pageErrors: string[] = []
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} }
    const checks = evidence.checks as Record<string, unknown>
    let officeFrame: import('@playwright/test').Frame | undefined

    try {
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push({ text: message.text(), url: message.location().url })
        }
      })
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      evidence.fixture = {
        filePath: fixture.filePath,
        absolutePath: fixture.absolutePath,
        bytes: fixture.bytes.byteLength,
        sha256: fixture.sha256
      }

      await waitForChat(page)
      evidence.electron = await app.evaluate(() => process.versions.electron)
      // 主题基线固定成 light（system 档下由 OS 决定；探针自己驱动 nativeTheme，不赌机器当前明暗）
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('light')

      // 网络拦截器：必须在 office iframe 创建之前装好（只记录、不 cancel）
      await app.evaluate(({ session }) => {
        const store: { requests: NetworkEntry[] } = { requests: [] }
        ;(globalThis as unknown as { __s2Network?: typeof store }).__s2Network = store
        session.defaultSession.webRequest.onBeforeRequest(
          { urls: ['<all_urls>'] },
          (details, callback) => {
            store.requests.push({
              url: details.url,
              type: details.resourceType,
              initiatorOrigin: details.initiatorOrigin ?? null
            })
            callback({})
          }
        )
      })

      // 面内 CSP 违规记录器（addInitScript 只对之后创建的子 frame 生效）
      await page.addInitScript(() => {
        const probe: { violations: { blockedURI: string; directive: string }[] } = {
          violations: []
        }
        ;(window as unknown as { __s2SurfaceProbe?: typeof probe }).__s2SurfaceProbe = probe
        document.addEventListener('securitypolicyviolation', (event) => {
          probe.violations.push({
            blockedURI: event.blockedURI,
            directive: event.violatedDirective
          })
        })
      })

      // ① 打开 Office → 真实「打开文件」（env 绕过原生对话框）→ 出现 DOCX 标签
      await page.getByTestId('primary-nav-office').click()
      await expect(page.getByTestId('office-page')).toBeVisible({ timeout: 30_000 })
      await page.getByTestId('office-open').click()
      await expect(page.getByTestId('office-workspace')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('app-tab')).toHaveCount(1)
      await expect(page.getByTestId('app-tab').first()).toContainText('方案-项目计划.docx')
      await expect(page.getByTestId('office-workspace')).toHaveAttribute(
        'data-document-state',
        'loaded',
        { timeout: 30_000 }
      )
      await expect(page.getByTestId('office-surface-status')).toHaveAttribute(
        'data-state',
        'ready',
        { timeout: 60_000 }
      )

      const documentId = await page.getByTestId('office-surface').getAttribute('data-document-id')
      expect(documentId, '壳没拿到 documentId').toBeTruthy()
      checks.shell = { documentId, tabTitle: '方案-项目计划.docx' }

      // ② sha256/字节/absolutePath：壳 office:read 回包 vs 进程外算的 fixture
      const readBack = await page.evaluate(async (id) => {
        const result = await window.kyclaw.office.read(id)
        if (!result.ok) return { ok: false as const, code: result.code, message: result.message }
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(result.bytes))
        const sha256 = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
        return {
          ok: true as const,
          documentId: result.document.documentId,
          absolutePath: result.document.absolutePath,
          displayName: result.document.displayName,
          size: result.bytes.byteLength,
          sha256
        }
      }, documentId as string)
      expect(readBack.ok, `office:read 失败：${JSON.stringify(readBack)}`).toBe(true)
      if (!readBack.ok) throw new Error(`office:read 失败：${readBack.code} ${readBack.message}`)
      expect(readBack.documentId).toBe(documentId)
      expect(readBack.absolutePath).toBe(fixture.absolutePath)
      expect(readBack.displayName).toBe('方案-项目计划.docx')
      expect(readBack.size).toBe(fixture.bytes.byteLength)
      expect(readBack.sha256).toBe(fixture.sha256)
      checks.readBack = readBack

      // ③ 同一文件再"打开"一次：注册表回 alreadyOpen，壳按 documentId 去重 → 仍只有 1 个标签
      await page.getByTestId('app-tab-add').click()
      await page.waitForTimeout(500)
      await expect(page.getByTestId('app-tab')).toHaveCount(1)
      const documentIdAfterReopen = await page
        .getByTestId('office-surface')
        .getAttribute('data-document-id')
      expect(documentIdAfterReopen).toBe(documentId)
      // 直接再问一次主进程：同文件 = 同 id + alreadyOpen（去重的权威在主进程 realpath）
      const reopened = await page.evaluate(async () => await window.kyclaw.office.openDialog())
      expect(reopened).toMatchObject({
        ok: true,
        alreadyOpen: true,
        document: { documentId: documentId as string, absolutePath: fixture.absolutePath }
      })
      checks.dedupe = { documentIdAfterReopen, reopened }

      // ④ 面收到 doc:open；面无 window.kyclaw；主 frame wasm 仍被拒
      await expect
        .poll(
          async () => page.frames().filter((frame) => frame.url().startsWith(SURFACE_PREFIX)).length
        )
        .toBe(1)
      officeFrame = page.frames().find((frame) => frame.url().startsWith(SURFACE_PREFIX))
      if (officeFrame === undefined) throw new Error('没有找到 kyclaw-office 的 frame')
      const surfaceDoc = await officeFrame.getByTestId('surface-doc-open').evaluate((element) => ({
        state: element.getAttribute('data-state'),
        documentId: element.getAttribute('data-document-id'),
        bytes: element.getAttribute('data-bytes'),
        sha256: element.getAttribute('data-sha256'),
        text: element.textContent
      }))
      expect(surfaceDoc).toMatchObject({
        state: 'loaded',
        documentId,
        bytes: String(fixture.bytes.byteLength),
        sha256: fixture.sha256
      })
      expect(surfaceDoc.text).toContain('方案-项目计划.docx')
      const surfaceKyclaw = await officeFrame.evaluate(
        () => typeof (window as unknown as { kyclaw?: unknown }).kyclaw
      )
      expect(surfaceKyclaw).toBe('undefined')
      const parentWasm = await page.evaluate(async () => {
        try {
          await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
          return 'resolved'
        } catch (error) {
          return `rejected:${error instanceof Error ? error.message : String(error)}`
        }
      })
      expect(parentWasm, '主 renderer 的 CSP 放开了 wasm（安全口径被破坏）').toMatch(/^rejected:/)
      checks.surface = { surfaceDoc, surfaceKyclaw, parentWasm }

      // ⑤ 0 外请（打开 + 读字节 + 去重重开全过程）
      await page.waitForTimeout(300)
      const network = await app.evaluate(
        () =>
          (globalThis as unknown as { __s2Network?: { requests: NetworkEntry[] } }).__s2Network ?? {
            requests: []
          }
      )
      const requests = network.requests
      const buckets = [...new Set(requests.map((entry) => bucketOf(entry.url)))].sort()
      const external = requests.filter((entry) => !ALLOWED_BUCKETS.has(bucketOf(entry.url)))
      const googleFonts = requests.filter((entry) =>
        /fonts\.(googleapis|gstatic)\.com/.test(entry.url)
      )
      checks.network = {
        total: requests.length,
        buckets,
        external,
        googleFonts: googleFonts.map((entry) => entry.url),
        officeRequests: requests
          .filter((entry) => entry.url.startsWith(SURFACE_PREFIX))
          .map((entry) => ({ url: entry.url, type: entry.type }))
      }
      expect(external, `出现外请：${JSON.stringify(external.slice(0, 10), null, 2)}`).toEqual([])
      for (const bucket of buckets) {
        expect(ALLOWED_BUCKETS.has(bucket), `scheme 不白名单：${bucket}`).toBe(true)
      }
      expect(googleFonts).toEqual([])

      // ⑥ 主题 P2：运行中切深色（nativeTheme 真实链路 → data-theme → 面内重应用，不重载 iframe）
      const bootBeforeTheme = await officeFrame
        .getByTestId('surface-doc-open')
        .getAttribute('data-state')
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('dark')
      const surfaceDark = await officeFrame.evaluate(async () => {
        const waitFrame = async (): Promise<void> => {
          for (let index = 0; index < 100; index += 1) {
            const theme = document.documentElement.dataset.surfaceTheme
            if (theme === 'dark') return
            await new Promise((resolveWait) => setTimeout(resolveWait, 50))
          }
        }
        await waitFrame()
        return {
          surfaceTheme: document.documentElement.dataset.surfaceTheme,
          colorScheme: document.documentElement.style.colorScheme,
          bodyBackground: getComputedStyle(document.body).backgroundColor,
          canvasToken: getComputedStyle(document.documentElement)
            .getPropertyValue('--doc-canvas-bg')
            .trim(),
          bootState: document.querySelector('[data-testid="surface-boot-state"]')?.textContent
        }
      })
      expect(surfaceDark.surfaceTheme).toBe('dark')
      expect(surfaceDark.colorScheme).toBe('dark')
      // P0 起画布走 Claude 身份层：深色凹槽 = --k-inset #1c1b1a（旧 Kimi Bg-Secondary #1f1f1f）
      expect(surfaceDark.canvasToken).toBe('#1c1b1a')
      expect(surfaceDark.bodyBackground).toBe('rgb(28, 27, 26)')
      // 不重载 iframe：面还是 ready、文档还在（重载会回到 booting / doc:open 重来）
      expect(surfaceDark.bootState).toBe('surface ready')
      expect(await officeFrame.getByTestId('surface-doc-open').getAttribute('data-state')).toBe(
        bootBeforeTheme
      )
      const lightScreenshot = join(EVIDENCE_DIR, 'docx-surface-light.png')
      await page.screenshot({ path: lightScreenshot })
      const darkScreenshot = join(EVIDENCE_DIR, 'docx-surface-dark.png')
      await page.screenshot({ path: darkScreenshot })
      await testInfo.attach('docx-surface-dark', {
        path: darkScreenshot,
        contentType: 'image/png'
      })
      checks.theme = { surfaceDark, screenshots: [lightScreenshot, darkScreenshot] }

      // 切回浅色（截图证据落袋后恢复；不验证细节，只防污染后续断言）
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('light')

      // ⑦ 面内 CSP 无违规；console/pageerror 干净
      const surfaceProbe = await officeFrame.evaluate(
        () =>
          (window as unknown as { __s2SurfaceProbe?: { violations: unknown[] } })
            .__s2SurfaceProbe ?? null
      )
      expect(surfaceProbe?.violations ?? []).toEqual([])
      const knownNoise = /Electron Security Warning/
      const interestingConsoleErrors = consoleErrors.filter((entry) => !knownNoise.test(entry.text))
      expect(
        interestingConsoleErrors,
        `console 出现错误：\n${interestingConsoleErrors
          .map((entry) => `${entry.text} @ ${entry.url}`)
          .join('\n')}`
      ).toEqual([])
      expect(pageErrors, `页面未捕获异常：\n${pageErrors.join('\n')}`).toEqual([])
      checks.surfaceCsp = surfaceProbe
      checks.consoleErrors = { all: consoleErrors, interesting: interestingConsoleErrors }
      checks.pageErrors = pageErrors

      evidence.finishedAt = new Date().toISOString()
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-result.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      evidence.failedAt = new Date().toISOString()
      evidence.error = String(error)
      evidence.consoleErrors = consoleErrors
      evidence.pageErrors = pageErrors
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-result.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
      throw error
    } finally {
      await closeApp(launched)
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })
})
