/**
 * M3-S3 真机探针：**面内 DocxEditor + 本地字体 + 保存链路**（preview 形态，起 `out/` 构建产物）。
 *
 * 跑法：
 *   corepack pnpm build
 *   corepack pnpm exec playwright test e2e/_r020-office-docx-save.spec.ts e2e/_r020-office-docx.spec.ts e2e/_r020-office-surface.spec.ts --reporter=line
 *
 * 验的门（`.superpowers/handover/office-docx-plan.md` §7/§9-S3/§10.4）：
 *   ① 面内真挂 DocxEditor（字体本地注册、首开时延可测）；0 外请（wasm/字体全走 kyclaw-office://）；
 *   ② 键入 → dirty；Ctrl+S（焦点在编辑器里，走编辑器 onSaveRequest → 壳保存状态机）→ dirty 消失；
 *   ③ **进程外读盘**：字节变化 + fflate 解 zip 断言 `word/document.xml` 变化、
 *      `[Content_Types].xml` / `_rels/.rels` 字节级不变；键入文本出现在 document.xml（解 OOXML 后比对）；
 *   ④ 重开保存后的文件：新实例能打开、面内 sha 与磁盘一致；
 *   ⑤ 注入写失败（Windows 只读文件 → rename EPERM → write-locked）：dirty 保持 + 错误条；
 *      恢复可写后"重试"能成功（不丢用户修改）；
 *   ⑥ 产物验收：`out/renderer` 出现 4 wasm（30,073,417B）+ 5 otf（34,818,280B）+ BetterOffice 65 ttf
 *      （14,876,000B；与既有 KaTeX 20 ttf 合计 15,389,664B）。
 *
 * fixture：产品 devDep `docx@9.9.0` 现场生成（含中文段落），只写临时目录，二进制不入 git。
 * 证据：`.superpowers/office-docx/s3/`（截图 + probe-result.json；本地，不入库）。
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { unzipSync } from 'fflate'
import { closeApp, launchApp, waitForChat, type LaunchedApp } from './harness'

const EVIDENCE_DIR = resolve('.superpowers', 'office-docx', 's3')
const SURFACE_PREFIX = 'kyclaw-office://surface'
const TYPED_TEXT = 'M3-S3-SAVED-中文'
const REPO_ROOT = resolve('.')

interface Fixture {
  directory: string
  path: string
  originalBytes: Buffer
  originalSha: string
}

/** 生成一份含中文段落的真实 docx（产品 devDep docx@9.9.0） */
async function writeFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-s3-'))
  const document = new Document({
    creator: 'kyclaw M3-S3 probe',
    title: 'M3-S3 保存验证',
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('kyclaw M3-S3 保存验证：第一段中文')] }),
          new Paragraph({ children: [new TextRun('第二段：这里会被键入修改后保存。')] }),
          new Paragraph({ children: [new TextRun('第三段：用于保持文档非空。')] })
        ]
      }
    ]
  })
  const originalBytes = await Packer.toBuffer(document)
  const path = join(directory, '保存验证.docx')
  writeFileSync(path, originalBytes)
  return {
    directory,
    path,
    originalBytes,
    originalSha: sha256(originalBytes)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 面的 frame（页面里只有一个 kyclaw-office 子 frame） */
async function surfaceFrame(page: Page): Promise<Frame> {
  await expect
    .poll(
      async () => page.frames().filter((frame) => frame.url().startsWith(SURFACE_PREFIX)).length
    )
    .toBe(1)
  const frame = page.frames().find((candidate) => candidate.url().startsWith(SURFACE_PREFIX))
  if (frame === undefined) throw new Error('没有找到 office frame')
  return frame
}

/** 打开 fixture 并等到编辑器可交互；返回各阶段时延 */
async function openAndWaitEditor(
  page: Page,
  options: { withTiming?: boolean } = {}
): Promise<{ frame: Frame; shellOpenMs: number; surfaceReadyMs: number }> {
  const startedAt = Date.now()
  await page.getByTestId('primary-nav-office').click()
  await expect(page.getByTestId('office-page')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('office-open').click()
  await expect(page.getByTestId('office-workspace')).toHaveAttribute(
    'data-document-state',
    'loaded',
    { timeout: 45_000 }
  )
  await expect(page.getByTestId('office-surface-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 60_000
  })
  await expect(page.getByTestId('office-workspace')).toHaveAttribute('data-editor-state', 'ready', {
    timeout: 180_000
  })
  const shellOpenMs = Date.now() - startedAt
  const frame = await surfaceFrame(page)
  await expect(frame.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'ready')
  const surfaceReadyMs = Number(
    await frame.getByTestId('surface-editor-state').getAttribute('data-ready-ms')
  )
  if (options.withTiming === true) {
    expect(surfaceReadyMs).toBeGreaterThan(0)
  }
  return { frame, shellOpenMs, surfaceReadyMs }
}

/**
 * 在编辑器正文里聚焦并键入。BetterOffice 的 DOCX 编辑器是 **canvas 分页**（正文画在 canvas 上），
 * 没有 contenteditable 段落；输入走一个隐藏的 ProseMirror textarea（`data-testid="yrs-input"`）。
 * 先点第一页 canvas 定位光标（点击会把焦点交给隐藏输入框），再键入；中文用 insertText 兜底。
 */
async function typeIntoEditor(page: Page, frame: Frame, text: string): Promise<void> {
  const firstPage = frame.locator('.canvas-page').first()
  await firstPage.click({ timeout: 60_000 })
  await page.keyboard.type(text, { delay: 20 })
  // 保险：某些环境键盘事件没打到隐藏输入框时，用 insertText 直接落到焦点元素
  await page.waitForTimeout(300)
  const revision = Number(
    await frame.getByTestId('surface-editor-state').getAttribute('data-revision')
  )
  if (revision === 0) {
    await page.keyboard.insertText(text)
  }
}

/** 从进程外读盘断言 OOXML 部件差异（§10.4） */
function assertSavedParts(
  originalBytes: Uint8Array,
  savedBytes: Uint8Array,
  typedText: string
): { changedParts: string[]; documentXml: string } {
  const before = unzipSync(new Uint8Array(originalBytes))
  const after = unzipSync(new Uint8Array(savedBytes))
  const partBytes = (zip: Record<string, Uint8Array>, name: string): Buffer => {
    const part = zip[name]
    if (part === undefined) throw new Error(`zip 里没有 ${name}`)
    return Buffer.from(part)
  }
  // word/document.xml 必须变（用户编辑的地方）
  expect(
    partBytes(after, 'word/document.xml').equals(partBytes(before, 'word/document.xml')),
    'word/document.xml 应当变化'
  ).toBe(false)
  // 容器级部件字节级不变（spike 同口径；保存不破坏 OOXML 封装）
  expect(
    partBytes(after, '[Content_Types].xml').equals(partBytes(before, '[Content_Types].xml')),
    '[Content_Types].xml 不应被改写'
  ).toBe(true)
  expect(
    partBytes(after, '_rels/.rels').equals(partBytes(before, '_rels/.rels')),
    '_rels/.rels 不应被改写'
  ).toBe(true)
  const documentXml = partBytes(after, 'word/document.xml').toString('utf8')
  const plainText = documentXml.replace(/<[^>]+>/g, '')
  expect(plainText).toContain(typedText)
  return { changedParts: ['word/document.xml'], documentXml: documentXml.slice(0, 400) }
}

test.describe('M3-S3 · DocxEditor + 本地字体 + 保存链路（真机 preview）', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('编辑 → Ctrl+S → 原子写盘 → 部件比对 → 重开；0 外请 + 产物验收', async ({}, testInfo) => {
    test.setTimeout(420_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixture = await writeFixture()
    let launched = await launchApp({
      // system 档：运行中切深色用 nativeTheme 真实链路（编辑器 colorMode 跟着变）
      settings: { theme: 'system' },
      env: { KYCLAW_OFFICE_OPEN: fixture.path }
    })
    let app = launched.app
    let page = launched.page
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} }
    const checks = evidence.checks as Record<string, unknown>

    try {
      await waitForChat(page)
      evidence.electron = await app.evaluate(() => process.versions.electron)

      // 网络记录（只记录不 cancel）：wasm/字体必须全走 kyclaw-office://，0 外请
      await app.evaluate(({ session }) => {
        const store: { requests: { url: string; type: string }[] } = { requests: [] }
        ;(globalThis as unknown as { __s3Network?: typeof store }).__s3Network = store
        session.defaultSession.webRequest.onBeforeRequest(
          { urls: ['<all_urls>'] },
          (details, callback) => {
            store.requests.push({ url: details.url, type: details.resourceType })
            callback({})
          }
        )
      })

      // ① 打开 → 编辑器可交互 + 首开时延 + 字体注册
      const { frame, shellOpenMs, surfaceReadyMs } = await openAndWaitEditor(page, {
        withTiming: true
      })
      const fonts = await frame.getByTestId('surface-save-stats').evaluate((element) => ({
        fontsMs: Number(element.getAttribute('data-fonts-ms')),
        fontsBytes: Number(element.getAttribute('data-fonts-bytes')),
        saveCount: Number(element.getAttribute('data-save-count'))
      }))
      const surfaceDoc = await frame.getByTestId('surface-doc-open').evaluate((element) => ({
        state: element.getAttribute('data-state'),
        documentId: element.getAttribute('data-document-id'),
        bytes: element.getAttribute('data-bytes'),
        sha256: element.getAttribute('data-sha256')
      }))
      expect(surfaceDoc.state).toBe('loaded')
      expect(surfaceDoc.sha256).toBe(fixture.originalSha)
      expect(surfaceDoc.bytes).toBe(String(fixture.originalBytes.byteLength))
      expect(fonts.fontsMs).toBeGreaterThan(0)
      checks.open = { shellOpenMs, surfaceReadyMs, fonts, surfaceDoc }
      // 面内没有 window.kyclaw（隔离面零 IPC 能力）
      expect(await frame.evaluate(() => typeof (window as { kyclaw?: unknown }).kyclaw)).toBe(
        'undefined'
      )

      // ② 键入 → dirty（面 revision 单调）
      await typeIntoEditor(page, frame, TYPED_TEXT)
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true', {
        timeout: 60_000
      })
      const revision = Number(
        await frame.getByTestId('surface-editor-state').getAttribute('data-revision')
      )
      expect(revision).toBeGreaterThan(0)
      checks.edit = { revision, typedText: TYPED_TEXT }

      // ③ Ctrl+S（焦点在编辑器里 → 编辑器 onSaveRequest → doc:save-request → 壳保存状态机）
      await page.keyboard.press('Control+s')
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false', {
        timeout: 180_000
      })
      await expect(page.getByTestId('office-dirty-status')).toHaveText('已保存')
      const saveStats = await frame.getByTestId('surface-save-stats').evaluate((element) => ({
        saveCount: Number(element.getAttribute('data-save-count')),
        lastBytes: Number(element.getAttribute('data-last-bytes'))
      }))
      expect(saveStats.saveCount).toBe(1)
      expect(saveStats.lastBytes).toBeGreaterThan(0)
      checks.save = saveStats

      // ④ 进程外读盘 + 部件比对
      const savedBytes = readFileSync(fixture.path)
      expect(savedBytes.equals(fixture.originalBytes), '磁盘字节应当变化').toBe(false)
      const savedSha = sha256(savedBytes)
      expect(savedSha).not.toBe(fixture.originalSha)
      const parts = assertSavedParts(fixture.originalBytes, savedBytes, TYPED_TEXT)
      // 临时文件不残留（同目录 *.tmp 清零）
      expect(readdirSync(fixture.directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
      checks.disk = {
        originalBytes: fixture.originalBytes.byteLength,
        savedBytes: savedBytes.byteLength,
        originalSha: fixture.originalSha,
        savedSha,
        ...parts
      }

      // ⑤ 运行中切深色：编辑器 colorMode / 面底色跟着变（截图证据）
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('dark')
      await expect
        .poll(async () => frame.evaluate(() => document.documentElement.dataset.surfaceTheme))
        .toBe('dark')
      const darkScreenshot = join(EVIDENCE_DIR, 'docx-editor-dark.png')
      await page.screenshot({ path: darkScreenshot })
      await testInfo.attach('docx-editor-dark', { path: darkScreenshot, contentType: 'image/png' })
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('light')
      checks.theme = { darkScreenshot }

      // ⑥ 0 外请 + 字体/wasm 来源 + 内存
      const network = await app.evaluate(
        () =>
          (globalThis as unknown as { __s3Network?: { requests: { url: string; type: string }[] } })
            .__s3Network ?? { requests: [] }
      )
      const requests = network.requests
      const schemes = [...new Set(requests.map((entry) => new URL(entry.url).protocol))].sort()
      const external = requests.filter((entry) => {
        const url = new URL(entry.url)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
        }
        return !['kyclaw-office:', 'file:', 'data:', 'blob:', 'devtools:', 'about:'].includes(
          url.protocol
        )
      })
      const officeAssets = requests.filter((entry) => entry.url.startsWith(SURFACE_PREFIX))
      expect(external, `出现外请：${JSON.stringify(external.slice(0, 5))}`).toEqual([])
      for (const scheme of schemes) {
        expect(['kyclaw-office:', 'file:', 'data:', 'blob:', 'http:']).toContain(scheme)
      }
      // 面内资源（wasm/字体/CSS/JS）全部走 kyclaw-office://surface/
      expect(officeAssets.some((entry) => entry.url.endsWith('.wasm'))).toBe(true)
      expect(officeAssets.some((entry) => /\.(otf|ttf)$/.test(entry.url))).toBe(true)
      expect(officeAssets.some((entry) => /\.css$/.test(entry.url))).toBe(true)
      expect(
        requests.filter(
          (entry) => entry.url.startsWith('file:') && /fonts|\.wasm|\.otf/.test(entry.url)
        )
      ).toEqual([])
      const metrics = await app.evaluate(({ app: electronApp }) =>
        electronApp.getAppMetrics().map((metric) => ({
          type: metric.type,
          workingSetMiB: Math.round(((metric.memory?.workingSetSize ?? 0) / 1024) * 100) / 100
        }))
      )
      checks.network = {
        total: requests.length,
        schemes,
        externalCount: external.length,
        officeAssetCount: officeAssets.length,
        wasm: officeAssets.filter((entry) => entry.url.endsWith('.wasm')).length,
        fonts: officeAssets.filter((entry) => /\.(otf|ttf)$/.test(entry.url)).length
      }
      checks.memory = metrics

      // ⑦ 产物验收（S0/S2 口径：4 wasm / 65 ttf / 5 otf）
      const rendererAssets = join(REPO_ROOT, 'out', 'renderer')
      const assetFiles: string[] = []
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) walk(path)
          else assetFiles.push(path)
        }
      }
      walk(rendererAssets)
      const bytesOf = (filter: (path: string) => boolean): number =>
        assetFiles.filter(filter).reduce((sum, path) => sum + statSync(path).size, 0)
      const wasmFiles = assetFiles.filter((path) => path.endsWith('.wasm'))
      const otfFiles = assetFiles.filter((path) => path.endsWith('.otf'))
      const ttfTotal = bytesOf((path) => path.endsWith('.ttf'))
      const assets = {
        wasmCount: wasmFiles.length,
        wasmBytes: bytesOf((path) => path.endsWith('.wasm')),
        otfCount: otfFiles.length,
        otfBytes: bytesOf((path) => path.endsWith('.otf')),
        ttfCount: assetFiles.filter((path) => path.endsWith('.ttf')).length,
        ttfBytes: ttfTotal
      }
      expect(assets.wasmCount).toBe(4)
      expect(assets.wasmBytes).toBe(30_073_417)
      expect(assets.otfCount).toBe(5)
      expect(assets.otfBytes).toBe(34_818_280)
      // BetterOffice 65 ttf = 14,876,000B；既有 KaTeX 20 ttf = 513,664B → 合计 15,389,664B
      expect(assets.ttfCount).toBe(85)
      expect(assets.ttfBytes).toBe(15_389_664)
      checks.assets = assets

      // ⑧ 重开保存后的文件（新实例）：能打开、面内 sha 与磁盘一致、编辑器 ready（不冒错误）
      await closeApp(launched)
      launched = await launchApp({ env: { KYCLAW_OFFICE_OPEN: fixture.path } })
      app = launched.app
      page = launched.page
      await waitForChat(page)
      const reopened = await openAndWaitEditor(page)
      const reopenedDoc = await reopened.frame
        .getByTestId('surface-doc-open')
        .evaluate((element) => ({
          state: element.getAttribute('data-state'),
          sha256: element.getAttribute('data-sha256'),
          bytes: element.getAttribute('data-bytes')
        }))
      expect(reopenedDoc.state).toBe('loaded')
      expect(reopenedDoc.sha256).toBe(savedSha)
      expect(reopenedDoc.bytes).toBe(String(savedBytes.byteLength))
      // 文本正确：重新解 zip，键入文本仍在 document.xml 的纯文本里（与重开前一致）
      const reopenedParts = assertSavedParts(fixture.originalBytes, savedBytes, TYPED_TEXT)
      expect(reopenedParts.changedParts).toEqual(['word/document.xml'])
      checks.reopen = { ...reopenedDoc, shellOpenMs: reopened.shellOpenMs }

      evidence.finishedAt = new Date().toISOString()
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-result.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      evidence.failedAt = new Date().toISOString()
      evidence.error = String(error)
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

  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('写失败（只读文件 → write-locked）：dirty 保持 + 错误条；恢复可写后重试成功', async ({}) => {
    test.setTimeout(300_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixture = await writeFixture()
    const launched: LaunchedApp = await launchApp({
      env: { KYCLAW_OFFICE_OPEN: fixture.path }
    })
    const { page } = launched
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} }
    const checks = evidence.checks as Record<string, unknown>

    try {
      await waitForChat(page)
      const { frame } = await openAndWaitEditor(page)

      // 把目标文件设为只读（Windows 上 chmod 0o444 = readonly 属性；rename 覆盖会 EPERM/EACCES）
      chmodSync(fixture.path, 0o444)
      await typeIntoEditor(page, frame, '写失败-中文')
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true', {
        timeout: 60_000
      })

      await page.keyboard.press('Control+s')
      await page.getByTestId('office-save-error').waitFor({ timeout: 180_000 })
      const errorText = (await page.getByTestId('office-save-error').textContent()) ?? ''
      expect(errorText.length).toBeGreaterThan(0)
      // 失败绝不清脏
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
      await page.screenshot({ path: join(EVIDENCE_DIR, 'docx-save-write-failed.png') })
      // 磁盘内容仍是原始那份（没有被半截覆盖）
      expect(sha256(readFileSync(fixture.path))).toBe(fixture.originalSha)
      checks.writeFailure = { errorText, dirty: true, diskSha: fixture.originalSha }

      // 恢复可写 → 点「重试」→ 成功清脏、磁盘变化
      chmodSync(fixture.path, 0o666)
      await page.getByTestId('office-save-retry').click()
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false', {
        timeout: 180_000
      })
      await expect(page.getByTestId('office-save-error')).toHaveCount(0)
      const retrySha = sha256(readFileSync(fixture.path))
      expect(retrySha).not.toBe(fixture.originalSha)
      checks.retry = { diskSha: retrySha }

      evidence.finishedAt = new Date().toISOString()
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-write-failure.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      evidence.failedAt = new Date().toISOString()
      evidence.error = String(error)
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-write-failure.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
      throw error
    } finally {
      await closeApp(launched)
      try {
        chmodSync(fixture.path, 0o666)
      } catch {
        // 文件可能已被清理
      }
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })
})
