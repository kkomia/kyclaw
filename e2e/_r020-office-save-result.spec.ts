/**
 * A4.5 真机探针：**保存结果回传**（`doc:save-result` 事件驱动面内 QAT，去掉 1.5s 乐观窗口）。
 *
 * 跑法（先 build；Electron 前清 `ELECTRON_RUN_AS_NODE`）：
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *   corepack pnpm exec playwright test e2e/_r020-office-save-result.spec.ts --reporter=line
 *
 * 验的门：
 *   ① **成功路径是事件驱动**：点 QAT 保存 → 面内状态先出现 `saving`（data-state 变化序列），
 *      写盘成功回执到达后才变 `saved`；壳状态栏（A4 真值）同帧一致；磁盘字节确实变了。
 *   ② **失败注入（Windows 只读文件 → write-locked）**：QAT 停在「未保存修改」+ 面内错误行
 *      （文案 = 壳给的分类人话，不是面自己编的），壳 `office-save-error` 同时出现、dirty 保持、
 *      磁盘未变；恢复可写后重试 → QAT 由壳回执转「已保存」。
 *   ③ **面内 Ctrl+S 与 QAT 同一条回执链路**：键盘触发保存后 QAT 也走 saving→saved，
 *      且 `surface-save-stats[data-save-state]` 反映壳真值。
 *
 * 超时（15s 无回执 → 回 dirty +「保存未确认」）在 jsdom 单测覆盖（surface-boot.spec）；
 * 真机无法在不改产品的情况下让壳"故意不回执"，见报告 §失败与超时矩阵。
 *
 * fixture：产品 devDep `docx@9.9.0` 现场生成（含中文段落），只写临时目录，二进制不入 git。
 * 证据：`.superpowers/office-docx/a4/`（截图 + probe-result*.json；本地，不入库）。
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { closeApp, launchApp, waitForChat } from './harness'

const EVIDENCE_DIR = resolve('.superpowers', 'office-docx', 'a4')
const SURFACE_PREFIX = 'kyclaw-office://surface'
const TYPED_TEXT = 'A4.5-SAVE-RESULT-中文'

interface Fixture {
  directory: string
  path: string
  originalBytes: Buffer
  originalSha: string
}

/** 生成一份含中文段落的真实 docx（产品 devDep docx@9.9.0） */
async function writeFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-a45-'))
  const document = new Document({
    creator: 'kyclaw A4.5 probe',
    title: 'A4.5 保存结果验证',
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('kyclaw A4.5 保存结果验证：第一段中文')] }),
          new Paragraph({ children: [new TextRun('第二段：键入后保存。')] })
        ]
      }
    ]
  })
  const originalBytes = await Packer.toBuffer(document)
  const path = join(directory, '保存结果.docx')
  writeFileSync(path, originalBytes)
  return { directory, path, originalBytes, originalSha: sha256(originalBytes) }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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

/** 打开 fixture 并等到编辑器可交互（KYCLAW_OFFICE_OPEN 绕过原生选择器） */
async function openAndWaitEditor(page: Page): Promise<Frame> {
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
  const frame = await surfaceFrame(page)
  await expect(frame.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'ready')
  return frame
}

/** 在编辑器正文里聚焦并键入（canvas 分页编辑器，输入走隐藏的 yrs-input） */
async function typeIntoEditor(page: Page, frame: Frame, text: string): Promise<void> {
  await frame.locator('.canvas-page').first().click({ timeout: 60_000 })
  await page.keyboard.type(text, { delay: 20 })
  await page.waitForTimeout(300)
  const revision = Number(
    await frame.getByTestId('surface-editor-state').getAttribute('data-revision')
  )
  if (revision === 0) await page.keyboard.insertText(text)
}

/** 记录面内 QAT 保存态的 data-state 变化序列（证明 saving 确实是事件驱动的中间态） */
async function startSaveStateObserver(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const element = document.querySelector('[data-testid="office-ribbon-save-state"]')
    if (element === null) throw new Error('没有 QAT 保存态元素')
    const states: string[] = [String(element.getAttribute('data-state'))]
    ;(window as unknown as { __a45SaveStates: string[] }).__a45SaveStates = states
    const observer = new MutationObserver(() => {
      states.push(String(element.getAttribute('data-state')))
    })
    observer.observe(element, { attributes: true, attributeFilter: ['data-state'] })
  })
}

async function saveStateSequence(frame: Frame): Promise<string[]> {
  return frame.evaluate(
    () => (window as unknown as { __a45SaveStates?: string[] }).__a45SaveStates ?? []
  )
}

test.describe('A4.5 · 保存结果回传（真机 preview）', () => {
  test('成功：QAT 走 saving→saved（写盘后才已保存）+ 壳状态栏一致 + 磁盘真的变了', async () => {
    test.setTimeout(300_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixture = await writeFixture()
    const launched = await launchApp({ env: { KYCLAW_OFFICE_OPEN: fixture.path } })
    const { page } = launched
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} }
    const checks = evidence.checks as Record<string, unknown>

    try {
      await waitForChat(page)
      const frame = await openAndWaitEditor(page)
      const qat = frame.getByTestId('office-ribbon-save-state')
      const ribbonState = (): Promise<string> => qat.getAttribute('data-state').then(String)
      expect(await ribbonState()).toBe('saved')

      await typeIntoEditor(page, frame, TYPED_TEXT)
      await expect(qat).toHaveAttribute('data-state', 'dirty', { timeout: 60_000 })
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')

      await startSaveStateObserver(frame)
      await frame.getByTestId('office-qat-save').click()

      // ① 面内 QAT 最终由壳回执落到 saved
      await expect(qat).toHaveAttribute('data-state', 'saved', { timeout: 180_000 })
      await expect(frame.getByTestId('surface-save-stats')).toHaveAttribute(
        'data-save-state',
        'saved'
      )
      await expect(frame.getByTestId('surface-save-error')).toHaveCount(0)
      const sequence = await saveStateSequence(frame)
      expect(sequence).toContain('saving')
      expect(sequence[sequence.length - 1]).toBe('saved')
      checks.qat = { sequence }

      // ② 壳状态栏（A4 真值）与面内 QAT 一致
      await expect(page.getByTestId('office-statusbar')).toHaveAttribute(
        'data-save-state',
        'saved',
        {
          timeout: 15_000
        }
      )
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false')
      await expect(page.getByTestId('office-dirty-status')).toHaveText('已保存')
      checks.statusbar = { saveState: 'saved', dirty: false }

      // ③ 磁盘字节真的变了（"已保存"不是乐观显示）
      const savedBytes = readFileSync(fixture.path)
      expect(savedBytes.equals(fixture.originalBytes), '磁盘字节应当变化').toBe(false)
      checks.disk = {
        originalSha: fixture.originalSha,
        savedSha: sha256(savedBytes)
      }

      const screenshot = join(EVIDENCE_DIR, 'save-result-success.png')
      await page.screenshot({ path: screenshot })
      checks.screenshot = screenshot

      evidence.finishedAt = new Date().toISOString()
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-save-result-success.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      evidence.failedAt = new Date().toISOString()
      evidence.error = String(error)
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-save-result-success.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
      throw error
    } finally {
      await closeApp(launched)
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  test('失败注入（只读文件 → write-locked）：QAT 停在未保存 + 面内错误行（壳人话）+ 壳错误条；恢复后重试转已保存', async () => {
    test.setTimeout(300_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixture = await writeFixture()
    const launched = await launchApp({ env: { KYCLAW_OFFICE_OPEN: fixture.path } })
    const { page } = launched
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} }
    const checks = evidence.checks as Record<string, unknown>

    try {
      await waitForChat(page)
      const frame = await openAndWaitEditor(page)
      const qat = frame.getByTestId('office-ribbon-save-state')

      // Windows 只读属性：rename 覆盖 → EPERM → 主进程分类 write-locked
      chmodSync(fixture.path, 0o444)
      await typeIntoEditor(page, frame, 'A4.5-写失败-中文')
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true', {
        timeout: 60_000
      })

      await frame.getByTestId('office-qat-save').click()

      // ① 面内 QAT 停在「未保存修改」（绝不显示已保存）+ 面内错误行显示壳给的人话。
      // 注意：面的调试状态条默认隐藏（A1 收口，只有 ?officeDebug=1 才显示），所以这里断言
      // 元素存在 + 文本（toHaveText 不要求可见）；用户可见的失败表现是壳的 office-save-error。
      const surfaceError = frame.getByTestId('surface-save-error')
      await expect(surfaceError).toHaveCount(1, { timeout: 180_000 })
      const surfaceErrorText = (await surfaceError.textContent()) ?? ''
      expect(surfaceErrorText.length).toBeGreaterThan(0)
      await expect(qat).toHaveAttribute('data-state', 'dirty')
      await expect(qat).not.toHaveText('已保存')
      await expect(frame.getByTestId('surface-save-stats')).toHaveAttribute(
        'data-save-state',
        'dirty'
      )
      expect(await frame.getByTestId('surface-save-stats').getAttribute('data-save-error')).toBe(
        surfaceErrorText
      )
      checks.surface = { state: 'dirty', errorText: surfaceErrorText }

      // ② 壳错误条同时出现（同一结果的两端表现），dirty 保持、磁盘未变
      await page.getByTestId('office-save-error').waitFor({ timeout: 60_000 })
      const shellErrorText = (await page.getByTestId('office-save-error').textContent()) ?? ''
      await expect(page.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
      expect(sha256(readFileSync(fixture.path))).toBe(fixture.originalSha)
      checks.shell = { errorText: shellErrorText, dirty: true, diskUnchanged: true }

      const failedScreenshot = join(EVIDENCE_DIR, 'save-result-write-failed.png')
      await page.screenshot({ path: failedScreenshot })
      checks.screenshot = failedScreenshot

      // ③ 恢复可写 → 壳「重试」→ QAT 由壳回执转「已保存」（事件驱动，不靠乐观窗口）
      chmodSync(fixture.path, 0o666)
      await page.getByTestId('office-save-retry').click()
      await expect(qat).toHaveAttribute('data-state', 'saved', { timeout: 180_000 })
      await expect(frame.getByTestId('surface-save-error')).toHaveCount(0)
      await expect(page.getByTestId('office-statusbar')).toHaveAttribute('data-save-state', 'saved')
      const retriedSha = sha256(readFileSync(fixture.path))
      expect(retriedSha).not.toBe(fixture.originalSha)
      checks.retry = { savedSha: retriedSha }

      evidence.finishedAt = new Date().toISOString()
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-save-result-failure.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      evidence.failedAt = new Date().toISOString()
      evidence.error = String(error)
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-save-result-failure.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
      throw error
    } finally {
      chmodSync(fixture.path, 0o666)
      await closeApp(launched)
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  test('面内 Ctrl+S 与 QAT 同一条回执链路：saving→saved + 壳状态栏一致', async () => {
    test.setTimeout(300_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixture = await writeFixture()
    const launched = await launchApp({ env: { KYCLAW_OFFICE_OPEN: fixture.path } })
    const { page } = launched

    try {
      await waitForChat(page)
      const frame = await openAndWaitEditor(page)
      const qat = frame.getByTestId('office-ribbon-save-state')

      await typeIntoEditor(page, frame, 'A4.5-CtrlS-中文')
      await expect(qat).toHaveAttribute('data-state', 'dirty', { timeout: 60_000 })

      await startSaveStateObserver(frame)
      // 焦点仍在编辑器 canvas（typeIntoEditor 点的第一页），Ctrl+S 由面 capture 拦下 → 面自己发
      // 带 requestId 的 doc:save-request（与 QAT 同一条路）
      await page.keyboard.press('Control+s')

      await expect(qat).toHaveAttribute('data-state', 'saved', { timeout: 180_000 })
      const sequence = await saveStateSequence(frame)
      expect(sequence).toContain('saving')
      expect(sequence[sequence.length - 1]).toBe('saved')
      await expect(page.getByTestId('office-statusbar')).toHaveAttribute('data-save-state', 'saved')
      expect(sha256(readFileSync(fixture.path))).not.toBe(fixture.originalSha)

      const screenshot = join(EVIDENCE_DIR, 'save-result-ctrl-s.png')
      await page.screenshot({ path: screenshot })
    } finally {
      await closeApp(launched)
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })
})
