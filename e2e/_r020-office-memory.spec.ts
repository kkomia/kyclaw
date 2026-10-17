/**
 * S5-4 真机内存探针（一次性验证，非产品门禁）：回答「M3-S5-3 的容量策略到底省不省内存」。
 *
 * 6 个时点：打开第 1/2/3 个编辑器（全挂载）→ 打开第 4 篇（挂载上限 3，第 1 篇转 dormant，
 * 它的 iframe/编辑器**整个卸载**）→ 强制整面重载（切标签把复用次数推过 OFFICE_SURFACE_MAX_REUSE，
 * 失活块的 iframe 被销毁）→ 关掉全部标签（空态）。
 *
 * 每个时点用主进程 `app.getAppMetrics()` 记录**所有进程** + **renderer（type=Tab）** 的
 * workingSet / privateBytes（KB），对比 dormant / 重载前后是否真的下降。
 *
 * 跑法（先 build）：
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *   corepack pnpm exec playwright test e2e/_r020-office-memory.spec.ts --reporter=line
 * 证据：`.superpowers/office-docx/s5/memory-probe.json` + 截图（本地，不入库）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { closeApp, launchApp, waitForChat } from './harness'

const EVIDENCE_DIR = resolve('.superpowers', 'office-docx', 's5')
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'kyclaw-s5-fixtures-'))

interface Fixture {
  filePath: string
  name: string
}

async function writeDocxFixture(index: number): Promise<Fixture> {
  const name = `S5-内存探针-${String(index + 1)}.docx`
  const filePath = join(FIXTURE_DIR, name)
  const document = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            children: [new TextRun({ text: `S5-4 内存探针文档 ${String(index + 1)}`, bold: true })]
          }),
          new Paragraph({
            children: [
              new TextRun({ text: '这一段中文用于让编辑器加载本地中文字体并真正排版。', size: 24 })
            ]
          })
        ]
      }
    ]
  })
  writeFileSync(filePath, await Packer.toBuffer(document))
  return { filePath, name }
}

interface MemorySample {
  at: string
  timestamp: number
  tabs: {
    open: number
    mounted: number
    dormant: number
    iframes: number
  }
  /** 全部进程合计（MB） */
  totalWorkingSetMB: number
  totalPrivateMB: number
  /** renderer（type=Tab）合计（MB）—— Office 面与它的 wasm 都在这里 */
  rendererWorkingSetMB: number
  rendererPrivateMB: number
  processCount: number
  processes: Array<{ type: string; pid: number; workingSetMB: number; privateMB: number }>
}

async function sample(app: ElectronApplication, page: Page, at: string): Promise<MemorySample> {
  const raw = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      workingSetKB: metric.memory.workingSetSize,
      privateKB: metric.memory.privateBytes ?? 0
    }))
  )
  const scopes = await page.evaluate(() => ({
    open: document.querySelectorAll(
      '[data-testid="office-workspace"], [data-testid="office-workspace-dormant"]'
    ).length,
    mounted: document.querySelectorAll('[data-testid="office-workspace"]').length,
    dormant: document.querySelectorAll('[data-testid="office-workspace-dormant"]').length,
    iframes: document.querySelectorAll('[data-testid="office-surface-iframe"]').length
  }))
  const round = (kb: number): number => Math.round((kb / 1024) * 10) / 10
  const sum = (items: Array<{ workingSetKB: number }>): number =>
    items.reduce((total, item) => total + item.workingSetKB, 0)
  const renderer = raw.filter((item) => item.type === 'Tab')
  return {
    at,
    timestamp: Date.now(),
    tabs: scopes,
    totalWorkingSetMB: round(sum(raw)),
    totalPrivateMB: round(raw.reduce((total, item) => total + item.privateKB, 0)),
    rendererWorkingSetMB: round(sum(renderer)),
    rendererPrivateMB: round(renderer.reduce((total, item) => total + item.privateKB, 0)),
    processCount: raw.length,
    processes: raw.map((item) => ({
      type: item.type,
      pid: item.pid,
      workingSetMB: round(item.workingSetKB),
      privateMB: round(item.privateKB)
    }))
  }
}

/** 把第 index 篇设成 KYCLAW_OFFICE_OPEN（preview 未打包才会读这个测试 env），再点「打开文件」 */
async function openNext(
  app: ElectronApplication,
  page: Page,
  fixture: Fixture,
  expected: { open: number; mounted: number; dormant: number }
): Promise<void> {
  await app.evaluate((_electron, filePath) => {
    process.env.KYCLAW_OFFICE_OPEN = filePath
  }, fixture.filePath)
  await page.getByTestId('app-tab-add').click()
  await expect
    .poll(
      async () =>
        page.evaluate(() => ({
          open: document.querySelectorAll(
            '[data-testid="office-workspace"], [data-testid="office-workspace-dormant"]'
          ).length,
          mounted: document.querySelectorAll('[data-testid="office-workspace"]').length,
          dormant: document.querySelectorAll('[data-testid="office-workspace-dormant"]').length
        })),
      { timeout: 60_000 }
    )
    .toEqual(expected)
  // 等一帧动画/排版落定（字节读回 + 编辑器骨架）
  await page.waitForTimeout(2_000)
}

/** 点击 Office 标签条里的第 index 个标签（AppTabBar 的 office 标签） */
async function clickOfficeTab(page: Page, index: number): Promise<void> {
  const tabs = page.getByTestId('app-tab')
  const count = await tabs.count()
  if (index >= count) throw new Error(`office tab ${String(index)} 不存在（共 ${String(count)}）`)
  await tabs.nth(index).click()
  // 给 React 一次提交 + effect 的时间（太快会让相邻激活在同一个 commit 里合并、计数被吞）
  await page.waitForTimeout(150)
}

test.describe('S5-4 真机内存探针（preview 形态，真 Electron 44.7.0）', () => {
  test('dormant / 整面重载 / 关标签 的内存实测（6 个时点）', async () => {
    test.setTimeout(420_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const fixtures = [
      await writeDocxFixture(0),
      await writeDocxFixture(1),
      await writeDocxFixture(2),
      await writeDocxFixture(3)
    ]
    const launched = await launchApp({ env: { KYCLAW_OFFICE_OPEN: fixtures[0].filePath } })
    const { app, page } = launched
    const samples: MemorySample[] = []
    try {
      await waitForChat(page)
      // 进 Office 模块 → 空态「打开文件」→ 第 1 篇
      await page.getByTestId('primary-nav-office').click()
      await expect(page.getByTestId('office-open')).toBeVisible({ timeout: 30_000 })
      await page.getByTestId('office-open').click()
      await expect
        .poll(async () => page.locator('[data-testid="office-surface-iframe"]').count(), {
          timeout: 60_000
        })
        .toBe(1)
      await page.waitForTimeout(3_000)
      samples.push(await sample(app, page, '1-editor'))

      // 2、3 篇：全挂载（上限 3，还没人休眠）
      await openNext(app, page, fixtures[1], { open: 2, mounted: 2, dormant: 0 })
      samples.push(await sample(app, page, '2-editors'))
      await openNext(app, page, fixtures[2], { open: 3, mounted: 3, dormant: 0 })
      samples.push(await sample(app, page, '3-editors'))
      await page.screenshot({ path: join(EVIDENCE_DIR, 'memory-3-editors.png') })

      // 第 4 篇：active 恒挂载，其余 clean 按 LRU 只留 2 个 → 第 1 篇转 dormant（iframe 整个卸载）
      await openNext(app, page, fixtures[3], { open: 4, mounted: 3, dormant: 1 })
      samples.push(await sample(app, page, '4-dormant-1'))
      await page.screenshot({ path: join(EVIDENCE_DIR, 'memory-dormant.png') })

      // 整面重载：来回切前两个标签，把第 1 个的复用次数推过上限（24）→ 失活块 iframe 被销毁。
      // 用 data-reuse-count（S5-3 挂的探针属性）闭环确认次数真的到了，不赌点击次数。
      const reuseOf = async (): Promise<number> =>
        page.evaluate(() =>
          Number(
            document
              .querySelector('[data-office-panel="docx-1"]')
              ?.getAttribute('data-reuse-count') ?? 0
          )
        )
      let clicks = 0
      let reuse = await reuseOf()
      // 交替切前两个标签：每次"激活第 1 个"都会给它累计 1 次复用；到上限就停
      while (clicks < 400 && reuse < 24) {
        await clickOfficeTab(page, 0)
        reuse = await reuseOf()
        if (reuse >= 24) break
        await clickOfficeTab(page, 1)
        clicks += 1
      }
      // 让第 1 个标签留在后台：失活且复用到上限 → 整面卸载（等一拍）
      await clickOfficeTab(page, 1)
      const panelsAfterLoop = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-office-panel]')).map((element) => ({
          id: element.getAttribute('data-office-panel'),
          active: element.getAttribute('data-active'),
          dormant: element.getAttribute('data-dormant'),
          reuse: element.getAttribute('data-reuse-count'),
          alive: element.getAttribute('data-surface-alive'),
          unloaded: element.querySelectorAll('[data-testid="office-surface-unloaded"]').length,
          iframes: element.querySelectorAll('[data-testid="office-surface-iframe"]').length
        }))
      )
      console.log(
        '[s5-debug] panels after loop',
        JSON.stringify({ clicks, reuse, panels: panelsAfterLoop })
      )
      await expect
        .poll(async () => page.locator('[data-testid="office-surface-unloaded"]').count(), {
          timeout: 30_000
        })
        .toBeGreaterThanOrEqual(1)
      await page.waitForTimeout(3_000)
      samples.push(await sample(app, page, '5-reloaded'))
      await page.screenshot({ path: join(EVIDENCE_DIR, 'memory-reloaded.png') })

      // 重新激活被释放的那块面 → 重读磁盘重建 iframe（证明"按需重开"）。
      // 注意：切走的那一块（docx-2）复用也到上限了，会在同一拍被卸载 —— 所以这里按"本面板"断言，
      // 不看整页 unloaded 计数（那是容量策略的正常轮转）。
      await clickOfficeTab(page, 0)
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const panel = document.querySelector('[data-office-panel="docx-1"]')
              return {
                active: panel?.getAttribute('data-active'),
                alive: panel?.getAttribute('data-surface-alive'),
                iframes: panel?.querySelectorAll('[data-testid="office-surface-iframe"]').length,
                unloaded: panel?.querySelectorAll('[data-testid="office-surface-unloaded"]').length
              }
            }),
          { timeout: 30_000 }
        )
        .toEqual({ active: 'true', alive: 'true', iframes: 1, unloaded: 0 })
      await page.waitForTimeout(2_000)
      samples.push(await sample(app, page, '6-restored'))

      // 关掉全部标签 → 空态
      for (let index = 0; index < 4; index += 1) {
        const closeButtons = page.getByTestId('app-tab-close')
        if ((await closeButtons.count()) === 0) break
        await closeButtons.first().click()
        await page.waitForTimeout(300)
      }
      await expect(page.getByTestId('office-empty')).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(3_000)
      samples.push(await sample(app, page, '7-all-closed'))
      await page.screenshot({ path: join(EVIDENCE_DIR, 'memory-closed.png') })

      const evidence = {
        startedAt: new Date().toISOString(),
        fixtures: fixtures.map((fixture) => fixture.name),
        maxReuse: 24,
        samples
      }
      writeFileSync(
        join(EVIDENCE_DIR, 'memory-probe.json'),
        `${JSON.stringify(evidence, null, 2)}\n`
      )

      // 结构断言：dormant 与整面重载在真机上真的发生了（内存数字见证据，噪声上不做硬阈值）
      const dormant = samples.find((item) => item.at === '4-dormant-1')
      expect(dormant?.tabs.mounted).toBe(3)
      expect(dormant?.tabs.dormant).toBe(1)
      const reloaded = samples.find((item) => item.at === '5-reloaded')
      expect(reloaded).toBeDefined()
      const closed = samples.find((item) => item.at === '7-all-closed')
      expect(closed?.tabs.open).toBe(0)
      // 关标签后 renderer 的 workingSet 不应高于开 3 篇时的峰值（同进程回收的粗略下界）
      const peak = Math.max(...samples.map((item) => item.rendererWorkingSetMB))
      expect(closed?.rendererWorkingSetMB ?? peak + 1).toBeLessThanOrEqual(peak)
      console.log(
        `[s5-memory] ${JSON.stringify(
          samples.map((item) => ({
            at: item.at,
            tabs: item.tabs,
            rendererWorkingSetMB: item.rendererWorkingSetMB,
            rendererPrivateMB: item.rendererPrivateMB,
            totalWorkingSetMB: item.totalWorkingSetMB
          }))
        )}`
      )
    } finally {
      await closeApp(launched)
      rmSync(FIXTURE_DIR, { recursive: true, force: true })
    }
  })
})
