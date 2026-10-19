/**
 * P0 回归（长期保留）：Excel 查找入口与 commands 模式工具栏：`af56ab9` 给 commands 模式 EditorToolbar 传 onSearchMenus
 * 导致 xlsx 整块崩（上游断言）。本探针在**真实 Electron（out/ 构建产物、隔离 userData）**里：
 *   1. 打开现场生成的 xlsx → 编辑器 ready（报错消失、无 error banner）；
 *   2. 工具栏「查找」按钮 → 查找条出现；关闭后 Ctrl+F 也能开；
 *   3. 输入存在的文本 → 计数 1/N（真查询 + 定位）；
 *   4. 页面/控制台无 `commands-mode EditorToolbar` 断言。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Frame } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'
import { materializeStubKernel } from './kernel-stub/launcher'

delete process.env.ELECTRON_RUN_AS_NODE
const repoRoot = resolve(__dirname, '..')
const EVIDENCE = join(repoRoot, '.superpowers/dev-verify/20261019-0.1.6/b2')

/** 生成一个最小可用 xlsx（不依赖本地 fixture，便于做成长期回归） */
function buildMinimalXlsx(): Buffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>'
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>'
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>'
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData><row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>预算</t></is></c>' +
        '<c r="B1"><v>1200</v></c>' +
        '</row></sheetData></worksheet>'
    )
  }
  return Buffer.from(zipSync(files))
}

test('P0：xlsx 打开不再崩（commands 模式断言消失）+ 查找两条入口可用', async () => {
  test.setTimeout(5 * 60 * 1000)
  mkdirSync(EVIDENCE, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-xlsx-find-'))
  const fixture = join(userDataDir, 'find-fixture.xlsx')
  writeFileSync(fixture, buildMinimalXlsx())
  writeFileSync(
    join(userDataDir, 'settings.json'),
    `${JSON.stringify({ theme: 'system' })}\n`,
    'utf8'
  )
  // 0.2.0 / PB-021：内核替身（离线）。本 spec 不发消息，只要求应用能带内核起来。
  const stub = materializeStubKernel({
    rootDir: join(userDataDir, 'kernel-stub'),
    logFile: join(userDataDir, 'kernel-stub.log')
  })
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...stub.env,
      KYCLAW_OFFICE_OPEN: fixture
    } as Record<string, string>
  })
  const page = await app.firstWindow()
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  try {
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 90_000 })
    await page.getByTestId('primary-nav-office').click()
    await expect(page.getByTestId('office-page')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('office-open').click()
    await expect(page.getByTestId('office-workspace').first()).toHaveAttribute(
      'data-document-state',
      'loaded',
      { timeout: 60_000 }
    )

    let frame: Frame | undefined
    await expect
      .poll(
        async () => {
          for (const candidate of page.frames()) {
            if (!candidate.url().startsWith('kyclaw-office://surface')) continue
            const count = await candidate
              .locator('[data-testid="surface-xlsx-editor"]')
              .count()
              .catch(() => 0)
            if (count > 0) {
              frame = candidate
              return true
            }
          }
          return false
        },
        { timeout: 120_000 }
      )
      .toBe(true)
    if (frame === undefined) throw new Error('没有 kyclaw-office://surface frame')
    const surface = frame

    // ① 编辑器 ready（此前这里直接报 commands-mode 断言、整块空白）
    await expect(surface.locator('[data-testid="surface-editor-state"]')).toHaveAttribute(
      'data-state',
      'ready',
      { timeout: 180_000 }
    )
    const bodyText = await surface.locator('body').innerText()
    expect(bodyText).not.toContain('commands-mode')
    expect(bodyText).not.toContain('EditorToolbar')
    expect(bodyText).not.toContain('重试')
    await page.screenshot({ path: join(EVIDENCE, 'real-xlsx-open-ready.png') })

    // ② 工具栏按钮 → 查找条
    await surface.locator('[data-testid="xlsx-find-button"]').click()
    await expect(surface.locator('[data-testid="xlsx-find-bar"]')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(EVIDENCE, 'real-xlsx-find-toolbar.png') })

    // ③ 输入存在的文本 → 1/N（真查询 + 定位）
    await surface.locator('[data-testid="xlsx-find-input"]').fill('预算')
    await expect
      .poll(
        async () => (await surface.locator('[data-testid="xlsx-find-count"]').innerText()).trim(),
        {
          timeout: 15_000
        }
      )
      .toMatch(/^\d+\/\d+$/)
    expect(await surface.locator('[data-testid="xlsx-find-count"]').innerText()).toBe('1/1')
    await page.screenshot({ path: join(EVIDENCE, 'real-xlsx-find-results.png') })

    // ④ 关闭后 Ctrl+F 再开
    await surface.locator('[data-testid="xlsx-find-close"]').click()
    await expect(surface.locator('[data-testid="xlsx-find-bar"]')).toHaveCount(0)
    await surface
      .locator('[data-testid="surface-xlsx-editor"]')
      .click({ position: { x: 220, y: 220 } })
    await page.keyboard.press('Control+f')
    await expect(surface.locator('[data-testid="xlsx-find-bar"]')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(EVIDENCE, 'real-xlsx-find-ctrl-f.png') })

    const joined = [...pageErrors, ...consoleErrors].join('\n')
    expect(joined).not.toContain('commands-mode')
    expect(joined).not.toContain('EditorToolbar')
  } finally {
    try {
      await app.close()
    } catch {
      // 已退出
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
