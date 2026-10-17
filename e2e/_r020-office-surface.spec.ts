/**
 * M3-S1 真机探针：`kyclaw-office://` 隔离面（**preview 形态**，起 `out/` 构建产物；不在打包件上跑）。
 *
 * 跑法：
 *   corepack pnpm build
 *   corepack pnpm exec playwright test e2e/_r020-office-surface.spec.ts --reporter=line
 *
 * 它验的是方案 §9-S1 / §10.2 的门（`.superpowers/handover/office-docx-plan.md`）：
 *   ① file:// 父页嵌 `kyclaw-office://surface/` 的 iframe 真的加载了（本步最大未知，已在最小探针先验）；
 *   ② 主 frame 里 `WebAssembly.compile` **必须 reject**（主 CSP 的 script-src 没放宽）；
 *   ③ 面里同样调用**必须 resolve**（`'wasm-unsafe-eval'` 只在面的 CSP 里）；
 *   ④ 面里 `typeof window.kyclaw === 'undefined'`（无 preload，零 IPC）；
 *   ⑤ 父页访问 `iframe.contentWindow.document` 被拒（跨源，正确隔离）；
 *   ⑥ 面内 `fetch('./office.html')` 200（协议 MIME/资源链路）、带 Range 的 fetch 206 + `content-range`；
 *   ⑦ 加载/握手期间 **0 外请**，且请求 scheme ⊆ {kyclaw-office, file, data, blob, localhost}；
 *   ⑧ 面内无 CSP 违规、字体状态正常、console 无错误。
 *
 * 网络工具：`session.defaultSession.webRequest.onBeforeRequest` 只**记录**、不 cancel（cancel 会改变产品行为，
 * 也会把"真外请"藏起来）；环回 127.0.0.1（内嵌 agent 服务）归为 `localhost` 一类，不算外请。
 *
 * 证据：`.superpowers/office-docx/s1/`（screenshot + probe-result.json；本地，不入库）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, waitForChat } from './harness'

const SURFACE_ORIGIN = 'kyclaw-office://surface'
const SURFACE_URL = `${SURFACE_ORIGIN}/`
const EVIDENCE_DIR = resolve('.superpowers', 'office-docx', 's1')

interface NetworkEntry {
  url: string
  type: string
  initiatorOrigin: string | null
}

/** 允许出现的 scheme/来源类别：全部是本地资源或内嵌服务的环回地址 */
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

/** 把请求 URL 归类：http(s)/ws(s) 的环回地址统一叫 `localhost`，其余按 scheme 归类 */
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

/** console 里已知的、与 CSP/隔离无关的噪声（Electron 自己会打的开发期提示） */
const KNOWN_CONSOLE_NOISE = ['Electron Security Warning', 'Electron Security Warnings']

/**
 * 探针自己造的 404（⑥ 的负向用例：fetch 一个不存在的 wasm）会被 Chromium 记一条
 * "Failed to load resource: 404" console error。只认"location 就是这个探针 URL"的那一条，
 * 不按文案笼统过滤 —— 真产物缺文件导致的 404 仍然会让断言红。
 */
const PROBE_404_URL = 'definitely-missing.wasm'

function isKnownConsoleNoise(entry: { text: string; url: string }): boolean {
  return (
    KNOWN_CONSOLE_NOISE.some((needle) => entry.text.includes(needle)) ||
    entry.url.includes(PROBE_404_URL)
  )
}

test.describe('M3-S1 · kyclaw-office:// 隔离面（真机 preview）', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('origin / 两侧 CSP / wasm / 无 window.kyclaw / Range / 0 外请', async ({}, testInfo) => {
    test.setTimeout(180_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    const launched = await launchApp()
    const { app, page } = launched
    /** console error + 它来自哪个 URL（资源加载失败时 location 就是那个资源的 URL） */
    const consoleErrors: { text: string; url: string }[] = []
    const pageErrors: string[] = []
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} }
    const checks = evidence.checks as Record<string, unknown>

    try {
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push({ text: message.text(), url: message.location().url })
        }
      })
      page.on('pageerror', (error) => pageErrors.push(String(error)))

      await waitForChat(page)
      evidence.electron = await app.evaluate(() => process.versions.electron)

      // 网络拦截器：必须在 office iframe 创建之前装好（只记录、不 cancel）
      await app.evaluate(({ session }) => {
        const store: { requests: NetworkEntry[] } = { requests: [] }
        ;(globalThis as unknown as { __s1Network?: typeof store }).__s1Network = store
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

      // 面内 CSP 违规记录器：addInitScript 只对之后创建的文档/子 frame 生效（主页面已经加载完）
      await page.addInitScript(() => {
        const probe: { violations: { blockedURI: string; directive: string }[] } = {
          violations: []
        }
        ;(window as unknown as { __s1SurfaceProbe?: typeof probe }).__s1SurfaceProbe = probe
        document.addEventListener('securitypolicyviolation', (event) => {
          probe.violations.push({
            blockedURI: event.blockedURI,
            directive: event.violatedDirective
          })
        })
      })

      // 打开 Office 模块 → 示例 DOCX（第一次打开 DOCX 才懒创建 iframe）
      await page.getByTestId('primary-nav-office').click()
      await expect(page.getByTestId('office-page')).toBeVisible({ timeout: 30_000 })
      await page.getByTestId('office-open').click()
      await page.getByTestId('office-mock-open-docx').click()
      await expect(page.getByTestId('office-surface-iframe')).toBeVisible({ timeout: 30_000 })

      // 握手成功 = 面加载 + hello/init/ready 全链路通（fatal 会卡在 loading，这里直接失败）
      await expect(page.getByTestId('office-surface-status')).toHaveAttribute(
        'data-state',
        'ready',
        { timeout: 60_000 }
      )

      // ① iframe 的 URL/origin：自定义协议另一个 origin（file:// 父页 = opaque origin）
      await expect
        .poll(
          async () => page.frames().filter((frame) => frame.url().startsWith(SURFACE_ORIGIN)).length
        )
        .toBe(1)
      const officeFrame = page.frames().find((frame) => frame.url().startsWith(SURFACE_ORIGIN))
      if (officeFrame === undefined) throw new Error('没有找到 kyclaw-office 的 frame')
      expect(officeFrame.url()).toBe(SURFACE_URL)
      const surfaceOrigin = await officeFrame.evaluate(() => window.location.origin)
      expect(surfaceOrigin).toBe(SURFACE_ORIGIN)
      const parentOrigin = await page.evaluate(() => window.location.origin)
      // Electron 的 file:// 页面把 origin 报成 "file://"（Chromium 标准里是 "null"）——
      // 这里只钉"父页是 file: 且与面的 origin 不同源"；跨源能力本身由 ⑤ 的 SecurityError 证明
      expect(parentOrigin, 'preview 形态主窗口必须是 file://').toMatch(/^file:/)
      expect(parentOrigin).not.toBe(SURFACE_ORIGIN)
      await expect(officeFrame.getByTestId('surface-boot-state')).toHaveText('surface ready')
      checks.frame = { url: officeFrame.url(), surfaceOrigin, parentOrigin }

      // ② 主 frame：wasm 编译必须被 CSP 拒绝（主 CSP 未放宽）
      const parentWasm = await page.evaluate(async () => {
        try {
          await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
          return 'resolved'
        } catch (error) {
          return `rejected:${error instanceof Error ? error.message : String(error)}`
        }
      })
      expect(parentWasm, '主 renderer 的 CSP 放开了 wasm（安全口径被破坏）').toMatch(/^rejected:/)
      checks.parentWasm = parentWasm

      // ③ 面内：同样调用必须成功（'wasm-unsafe-eval' 只在面的 CSP 里）
      const surfaceWasm = await officeFrame.evaluate(async () => {
        try {
          await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
          return 'ok'
        } catch (error) {
          return `blocked:${error instanceof Error ? error.message : String(error)}`
        }
      })
      expect(surfaceWasm, "office 面的 CSP 没让 'wasm-unsafe-eval' 生效").toBe('ok')
      checks.surfaceWasm = surfaceWasm

      // ④ 面里没有 window.kyclaw（iframe 无 preload，零 IPC 能力）
      const surfaceKyclaw = await officeFrame.evaluate(
        () => typeof (window as unknown as { kyclaw?: unknown }).kyclaw
      )
      expect(surfaceKyclaw).toBe('undefined')
      checks.surfaceKyclaw = surfaceKyclaw

      // ⑤ 父页跨源访问面文档必须被拒
      const crossOrigin = await page.evaluate(() => {
        const iframe = document.querySelector('[data-testid="office-surface-iframe"]')
        if (!(iframe instanceof HTMLIFrameElement)) return 'no-iframe'
        try {
          const doc = iframe.contentWindow?.document
          return doc === undefined ? 'no-window' : `LEAK:${doc.title}`
        } catch (error) {
          return `blocked:${error instanceof Error ? error.name : String(error)}`
        }
      })
      expect(crossOrigin).toBe('blocked:SecurityError')
      checks.crossOriginDocAccess = crossOrigin

      // ⑥ 面的资源链路：同源 fetch 200 + MIME + CSP/nosniff 头；Range 206 + content-range
      const resource = await officeFrame.evaluate(async () => {
        const response = await fetch('./office.html')
        const headers: Record<string, string | null> = {}
        for (const name of [
          'content-type',
          'content-security-policy',
          'x-content-type-options',
          'cache-control',
          'accept-ranges',
          'content-length'
        ]) {
          headers[name] = response.headers.get(name)
        }
        const body = await response.arrayBuffer()
        return { status: response.status, headers, bytes: body.byteLength }
      })
      expect(resource.status).toBe(200)
      expect(resource.headers['content-type']).toContain('text/html')
      expect(resource.headers['content-security-policy']).toContain("'wasm-unsafe-eval'")
      expect(resource.headers['content-security-policy']).toContain("connect-src 'self'")
      expect(resource.headers['x-content-type-options']).toBe('nosniff')
      expect(resource.headers['accept-ranges']).toBe('bytes')

      const ranged = await officeFrame.evaluate(async () => {
        const response = await fetch('./office.html', { headers: { Range: 'bytes=0-9' } })
        const body = await response.arrayBuffer()
        return {
          status: response.status,
          contentRange: response.headers.get('content-range'),
          contentLength: response.headers.get('content-length'),
          bytes: body.byteLength
        }
      })
      expect(ranged.status).toBe(206)
      expect(ranged.contentRange).toMatch(/^bytes 0-9\/\d+$/)
      expect(ranged.bytes).toBe(10)

      const missing = await officeFrame.evaluate(async () => {
        const response = await fetch('./definitely-missing.wasm')
        return { status: response.status }
      })
      expect(missing.status).toBe(404)
      checks.protocolResources = { resource, ranged, missing }

      // ⑦ 外请统计（加载 + 握手 + 断言期间）
      await page.waitForTimeout(500)
      const network = await app.evaluate(
        () =>
          (globalThis as unknown as { __s1Network?: { requests: NetworkEntry[] } }).__s1Network ?? {
            requests: []
          }
      )
      const requests = network.requests
      const buckets = [...new Set(requests.map((entry) => bucketOf(entry.url)))].sort()
      const external = requests.filter((entry) => !ALLOWED_BUCKETS.has(bucketOf(entry.url)))
      const googleFonts = requests.filter((entry) =>
        /fonts\.(googleapis|gstatic)\.com/.test(entry.url)
      )
      const officeRequests = requests.filter((entry) => entry.url.startsWith(SURFACE_URL))
      checks.network = {
        total: requests.length,
        buckets,
        external,
        googleFonts: googleFonts.map((entry) => entry.url),
        officeRequests: officeRequests.map((entry) => ({ url: entry.url, type: entry.type })),
        initiatorOrigins: [...new Set(requests.map((entry) => entry.initiatorOrigin ?? 'null'))]
      }
      expect(external, `出现外请：${JSON.stringify(external.slice(0, 10), null, 2)}`).toEqual([])
      for (const bucket of buckets) {
        expect(ALLOWED_BUCKETS.has(bucket), `scheme 不白名单：${bucket}`).toBe(true)
      }
      expect(googleFonts).toEqual([])
      // 协议真的服务了面的文档 + 构建产物（assets/*.js 走的是 kyclaw-office，不是 file://）
      expect(officeRequests.length).toBeGreaterThanOrEqual(2)
      expect(officeRequests.some((entry) => entry.url === SURFACE_URL)).toBe(true)
      expect(officeRequests.some((entry) => /\/assets\/.+\.js$/.test(entry.url))).toBe(true)
      expect(
        requests.filter((entry) => entry.url.startsWith('file:') && /office/i.test(entry.url)),
        '面的资源不该走 file://'
      ).toEqual([])

      // ⑧ 面内 CSP 违规 / 字体 / console
      const surfaceProbe = await officeFrame.evaluate(() => {
        const probe = (window as unknown as { __s1SurfaceProbe?: { violations: unknown[] } })
          .__s1SurfaceProbe
        return {
          installed: probe !== undefined,
          violations: probe?.violations ?? [
            { error: 'CSP 记录器未装上（addInitScript 没作用到子 frame）' }
          ],
          fontsStatus: document.fonts.status
        }
      })
      expect(surfaceProbe.installed).toBe(true)
      expect(surfaceProbe.violations).toEqual([])
      expect(surfaceProbe.fontsStatus).toBe('loaded')
      checks.surfaceCsp = surfaceProbe

      const interestingConsoleErrors = consoleErrors.filter((entry) => !isKnownConsoleNoise(entry))
      expect(
        interestingConsoleErrors,
        `console 出现错误：\n${interestingConsoleErrors.map((entry) => `${entry.text} @ ${entry.url}`).join('\n')}`
      ).toEqual([])
      expect(pageErrors, `页面未捕获异常：\n${pageErrors.join('\n')}`).toEqual([])
      checks.consoleErrors = { all: consoleErrors, interesting: interestingConsoleErrors }
      checks.pageErrors = pageErrors

      // 证据：截图 + JSON（本地，不入库）
      const screenshot = join(EVIDENCE_DIR, 'preview-office-surface.png')
      await page.screenshot({ path: screenshot })
      await testInfo.attach('preview-office-surface', {
        path: screenshot,
        contentType: 'image/png'
      })
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
    }
  })
})
