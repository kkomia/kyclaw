/**
 * M3-S4 真机探针：**Office 模块保活 + 多 workspace 常驻 + 标签关闭/快捷键**（preview 形态）。
 *
 * 跑法（先 `corepack pnpm build`）：
 *   corepack pnpm exec playwright test e2e/_r020-office-tabs.spec.ts e2e/_r020-office-docx-save.spec.ts \
 *     e2e/_r020-office-docx.spec.ts e2e/_r020-office-surface.spec.ts --reporter=line
 *
 * 验收（task-15 / `.superpowers/handover/s4-recon.md` §1/§2/§5）：
 *   ① 开 2 个 docx → 两个标签都在、两个 workspace/iframe **同时挂载**；切标签 iframe 节点不重建；
 *   ② 切聊天再回 Office：同一 iframe 节点仍在 DOM（`module-office` hidden+inert），标签/编辑内容/dirty 不丢；
 *   ③ 非 /office 路由按 Ctrl+W：Office 标签数不变、应用不关（D14：preventDefault + no-op）；
 *      /office 下 Ctrl+W 才关当前干净标签；
 *   ④ 脏标签关闭三态：取消保留、放弃才关（保存档由 S3 探针覆盖成功路径）；
 *   ⑤ 壳侧 Ctrl+S（焦点在壳里）→ 保存成功、dirty 消失、磁盘字节变化。
 *
 * fixture：产品 devDep `docx` 现场生成两份中文 docx，只写临时目录（二进制不入 git）。
 * 第二个文件的打开方式：`KYCLAW_OFFICE_OPEN` 在未打包构建里是**每次调用现读**的测试 env，
 * 主进程实测按 `process.env` 取值 —— 这里用 `app.evaluate` 把它换成 B 再点「＋」打开第二份
 * （不新增产品代码，也不依赖真选择器）。
 * 证据：`.superpowers/office-docx/s4/`（本地，不入库）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Frame, type Locator, type Page } from '@playwright/test'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { closeApp, launchApp, waitForChat, type LaunchedApp } from './harness'

const EVIDENCE_DIR = resolve('.superpowers', 'office-docx', 's4')
const ACTIVE_PANEL = '[data-office-panel][data-active="true"]'
const ALL_PANELS = '[data-office-panel]'
const EDITOR_READY = '[data-testid="office-workspace"][data-editor-state="ready"]'

interface Fixture {
  directory: string
  path: string
  title: string
  bytes: Buffer
}

/** 生成一份含中文段落的真实 docx */
async function writeFixture(seed: string): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-s4-'))
  const title = `${seed}文档`
  const document = new Document({
    creator: 'kyclaw M3-S4 probe',
    title,
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun(`${seed}：第一段中文`)] }),
          new Paragraph({ children: [new TextRun(`${seed}：第二段用于保活验证`)] })
        ]
      }
    ]
  })
  const bytes = await Packer.toBuffer(document)
  const path = join(directory, `${seed}.docx`)
  writeFileSync(path, bytes)
  return { directory, path, title, bytes }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 当前激活 panel 里的隔离面 frame */
async function activeSurfaceFrame(page: Page): Promise<Frame> {
  const iframe = page.locator(`${ACTIVE_PANEL} [data-testid="office-surface-iframe"]`)
  const handle = await iframe.elementHandle({ timeout: 30_000 })
  const frame = handle === null ? null : await handle.contentFrame()
  if (frame === null) throw new Error('没有找到激活标签的 office frame')
  return frame
}

/** 点「打开文件」（KYCLAW_OFFICE_OPEN 脚本选择器）并等激活标签的编辑器可交互 */
async function openViaScriptedPicker(page: Page): Promise<{ shellOpenMs: number }> {
  const startedAt = Date.now()
  await page.getByTestId('office-open').click()
  await expect(page.locator(`${ACTIVE_PANEL} ${EDITOR_READY}`)).toHaveCount(1, {
    timeout: 180_000
  })
  return { shellOpenMs: Date.now() - startedAt }
}

/** 在激活编辑器正文里键入（canvas 分页编辑器：点第一页再键入） */
async function typeIntoActiveEditor(page: Page, text: string): Promise<void> {
  const frame = await activeSurfaceFrame(page)
  const firstPage = frame.locator('.canvas-page').first()
  await firstPage.click({ timeout: 60_000 })
  await page.keyboard.type(text, { delay: 20 })
}

/** 当前激活 panel 的 dirty 徽标（每个 workspace 一个） */
function activeDirty(page: Page): Locator {
  return page.locator(`${ACTIVE_PANEL} [data-testid="office-dirty-status"]`)
}

/** 把两个 iframe/workspace 的节点身份记进 window（后面断言"同一节点"） */
async function rememberDom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = window as unknown as {
      __s4Probe?: { iframes: Element[]; workspaces: Element[] }
    }
    probe.__s4Probe = {
      iframes: Array.from(document.querySelectorAll('[data-testid="office-surface-iframe"]')),
      workspaces: Array.from(document.querySelectorAll('[data-testid="office-workspace"]'))
    }
  })
}

/** 断言 iframe/workspace 还是当初那些节点，且都还连着（没被卸载重建） */
async function expectSameDom(page: Page): Promise<{ iframes: number; workspaces: number }> {
  return page.evaluate(() => {
    const probe = window as unknown as {
      __s4Probe: { iframes: Element[]; workspaces: Element[] }
    }
    const iframes = Array.from(document.querySelectorAll('[data-testid="office-surface-iframe"]'))
    const workspaces = Array.from(document.querySelectorAll('[data-testid="office-workspace"]'))
    const sameIframes =
      iframes.length === probe.__s4Probe.iframes.length &&
      iframes.every((element, index) => element === probe.__s4Probe.iframes[index])
    const sameWorkspaces =
      workspaces.length === probe.__s4Probe.workspaces.length &&
      workspaces.every((element, index) => element === probe.__s4Probe.workspaces[index])
    if (!sameIframes || !sameWorkspaces) {
      throw new Error(
        `Office DOM 被重建：iframes ${iframes.length}/${probe.__s4Probe.iframes.length}`
      )
    }
    if (!iframes.every((element) => element.isConnected)) {
      throw new Error('iframe 节点已断开')
    }
    return { iframes: iframes.length, workspaces: workspaces.length }
  })
}

test.describe('M3-S4 · Office 模块保活 + 多 workspace 常驻（真机 preview）', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('两个标签都常驻、切标签不重建 iframe、切聊天保活、非 Office Ctrl+W no-op、脏关闭三态', async ({}, testInfo) => {
    test.setTimeout(600_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixtureA = await writeFixture('甲')
    const fixtureB = await writeFixture('乙')
    const launched: LaunchedApp = await launchApp({ env: { KYCLAW_OFFICE_OPEN: fixtureA.path } })
    const { app, page } = launched
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} }
    const checks = evidence.checks as Record<string, unknown>
    try {
      await waitForChat(page)
      evidence.electron = await app.evaluate(() => process.versions.electron)

      // ① 打开 A（脚本选择器）→ 编辑器可交互
      await page.getByTestId('primary-nav-office').click()
      await expect(page.getByTestId('office-page')).toBeVisible({ timeout: 30_000 })
      const firstOpen = await openViaScriptedPicker(page)
      expect(await page.getByTestId('app-tab').count()).toBe(1)
      expect(
        await page.locator(`${ACTIVE_PANEL} [data-testid="office-surface-iframe"]`).count()
      ).toBe(1)

      // A 里键入 → dirty（用来验证切标签/切模块后编辑状态还在）
      await typeIntoActiveEditor(page, 'S4-A-编辑')
      await expect(activeDirty(page)).toHaveAttribute('data-dirty', 'true', { timeout: 60_000 })
      const frameA = await activeSurfaceFrame(page)
      await expect(frameA.getByTestId('surface-editor-state')).toHaveAttribute(
        'data-revision',
        /\d+/
      )
      const revisionABefore = Number(
        await frameA.getByTestId('surface-editor-state').getAttribute('data-revision')
      )
      expect(revisionABefore).toBeGreaterThan(0)

      // ② 打开 B：把脚本选择器换成 B（未打包构建每次调用现读 env）→ 点「＋」
      await app.evaluate((_electron, target: string) => {
        process.env.KYCLAW_OFFICE_OPEN = target
      }, fixtureB.path)
      await page.getByTestId('app-tab-add').click()
      await expect(page.getByTestId('app-tab')).toHaveCount(2, { timeout: 60_000 })
      await expect(page.locator(`${EDITOR_READY}`)).toHaveCount(2, { timeout: 180_000 })
      expect(await page.locator(ALL_PANELS).count()).toBe(2)
      // A 的 dirty 圆点还在（切走不丢编辑态）
      expect(await page.getByTestId('app-tab-dirty').count()).toBe(1)
      // 两个 panel id 唯一
      const panelIds = await page
        .locator(ALL_PANELS)
        .evaluateAll((elements) => elements.map((element) => element.id))
      expect(new Set(panelIds).size).toBe(2)

      await rememberDom(page)
      // 多编辑器常驻的内存成本（S6 要据此做上限/LRU；每个 Tab 就是一条独立 renderer 进程）
      checks.memory = await app.evaluate(({ app: electronApp }) =>
        electronApp.getAppMetrics().map((metric) => ({
          type: metric.type,
          workingSetMiB: Math.round(((metric.memory?.workingSetSize ?? 0) / 1024) * 100) / 100
        }))
      )
      checks.open = {
        firstOpen,
        tabs: 2,
        iframes: await page.locator('[data-testid="office-surface-iframe"]').count(),
        panelIds
      }

      // ③ 切回 A：同一 iframe 节点、编辑内容（revision）还在、dirty 还在
      const tabA = page.getByTestId('app-tab').filter({ hasText: '甲' })
      await tabA.click()
      await expect(page.locator(`${ACTIVE_PANEL} [data-testid="office-workspace"]`)).toContainText(
        '甲'
      )
      const sameAfterSwitch = await expectSameDom(page)
      await expect(activeDirty(page)).toHaveAttribute('data-dirty', 'true')
      const frameAAfter = await activeSurfaceFrame(page)
      const revisionAAfter = Number(
        await frameAAfter.getByTestId('surface-editor-state').getAttribute('data-revision')
      )
      expect(revisionAAfter).toBe(revisionABefore)
      checks.switchTab = { ...sameAfterSwitch, revisionAAfter }

      // ④ 切聊天：Office 仍在 DOM（hidden+inert），iframe 节点不变
      await page.getByTestId('app-tab-chat').click()
      await expect(page.getByTestId('module-office')).toHaveAttribute('data-active', 'false')
      await expect(page.getByTestId('module-office')).toHaveAttribute('inert')
      expect(
        await page
          .getByTestId('module-office')
          .evaluate((element) => getComputedStyle(element).display)
      ).toBe('none')
      expect(await page.getByTestId('office-page').count()).toBe(1)
      await expectSameDom(page)

      // ⑤ 非 /office 按 Ctrl+W：Office 标签数不变、应用不关（D14）
      await page.getByTestId('composer-input').click()
      await page.keyboard.press('Control+w')
      await expect(page.getByTestId('app-tab')).toHaveCount(2)
      await expect(page.getByTestId('titlebar')).toBeVisible()
      checks.ctrlWOnChat = { tabsStill: 2 }

      // ⑥ 回 Office：同一 iframe，A 的编辑/脏状态还在
      await page.getByTestId('primary-nav-office').click()
      await expect(page.getByTestId('module-office')).toHaveAttribute('data-active', 'true')
      await expectSameDom(page)
      await expect(activeDirty(page)).toHaveAttribute('data-dirty', 'true')

      // ⑦ /office 下 Ctrl+W 关当前干净标签 B（先切到 B，它不脏）
      const tabB = page.getByTestId('app-tab').filter({ hasText: '乙' })
      await tabB.click()
      await expect(activeDirty(page)).toHaveAttribute('data-dirty', 'false')
      await page.getByTestId('office-page-title').click()
      await page.keyboard.press('Control+w')
      await expect(page.getByTestId('app-tab')).toHaveCount(1, { timeout: 60_000 })
      checks.ctrlWOnOffice = { tabsAfter: 1 }

      // ⑧ 脏标签 A 的关闭三态：取消保留；放弃才关（面 doc:close → office:release → store close）
      await page.getByRole('button', { name: '关闭 甲.docx' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: '保存' })).toBeVisible()
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByTestId('app-tab')).toHaveCount(1)
      await expect(activeDirty(page)).toHaveAttribute('data-dirty', 'true')
      const dirtyScreenshot = join(EVIDENCE_DIR, 'tabs-dirty-close.png')
      await page.screenshot({ path: dirtyScreenshot })
      await testInfo.attach('tabs-dirty-close', { path: dirtyScreenshot, contentType: 'image/png' })

      await page.getByRole('button', { name: '关闭 甲.docx' }).click()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '放弃修改' }).click()
      await expect(page.getByTestId('app-tab')).toHaveCount(0, { timeout: 60_000 })
      await expect(page.getByTestId('office-empty')).toBeVisible()
      checks.dirtyClose = { cancelled: true, discarded: true }

      evidence.finishedAt = new Date().toISOString()
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-tabs.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      evidence.failedAt = new Date().toISOString()
      evidence.error = String(error)
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-tabs.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
      throw error
    } finally {
      await closeApp(launched)
      rmSync(fixtureA.directory, { recursive: true, force: true })
      rmSync(fixtureB.directory, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('壳侧 Ctrl+S（焦点在壳里）→ 保存成功、dirty 消失、磁盘字节变化', async ({}) => {
    test.setTimeout(420_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixture = await writeFixture('壳存')
    const launched = await launchApp({ env: { KYCLAW_OFFICE_OPEN: fixture.path } })
    const { page } = launched
    const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() }
    try {
      await waitForChat(page)
      await page.getByTestId('primary-nav-office').click()
      await openViaScriptedPicker(page)
      await typeIntoActiveEditor(page, 'S4-壳存-中文')
      await expect(activeDirty(page)).toHaveAttribute('data-dirty', 'true', { timeout: 60_000 })

      // 焦点在壳里（点标题区，别点回 iframe）→ Ctrl+S 由 AppTabBar 的 window 监听处理
      await page.getByTestId('office-page-title').click()
      await page.keyboard.press('Control+s')
      await expect(activeDirty(page)).toHaveAttribute('data-dirty', 'false', { timeout: 180_000 })
      const saved = readFileSync(fixture.path)
      expect(sha256(saved)).not.toBe(sha256(fixture.bytes))
      evidence.shellCtrlS = {
        originalBytes: fixture.bytes.byteLength,
        savedBytes: saved.byteLength,
        originalSha: sha256(fixture.bytes),
        savedSha: sha256(saved)
      }
      const shot = join(EVIDENCE_DIR, 'shell-save.png')
      await page.screenshot({ path: shot })
      evidence.finishedAt = new Date().toISOString()
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-shell-save.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      evidence.failedAt = new Date().toISOString()
      evidence.error = String(error)
      writeFileSync(
        join(EVIDENCE_DIR, 'probe-shell-save.json'),
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
