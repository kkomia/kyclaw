/**
 * R90 预览发布验收探针（**真实应用级**）：真 Electron + 真临时 profile + 真工作区，
 * 一路走"点文件树 → IPC → 观看器"，把发布前要过的预览面逐条验一遍。
 *
 * ── 覆盖（与验收清单一一对应）────────────────────────────────────────────────
 *   · Office 四类（doc/docx/ppt/pptx）→ `workbench:office-pdf` → **真 DshOfficeViewer 实例**
 *     （`dsh-office-viewer` → `dsh-pdf-viewer` 那套新阅读器，**不拿独立 .pdf 旧入口冒充**）；
 *   · 表格四类（xls/xlsx/csv/tsv）→ `workbench:table-bytes` → `ExcelPreview`；
 *   · `.pdf`：**既有入口**，缩略图 + 目录书签两样都还在（这是它的长处，本轮不换）；
 *   · 图片（png/svg/ico）→ `DshImageBody`；
 *   · HTML：`dsh-html-preview` 的 sandbox 预览 → 脚本与外链**都不执行**（自带哨兵服务对账）；
 *   · Markdown：正文 + 数学（`.katex`，依赖 remark-math / rehype-katex）；
 *   · 文本 / 代码（shiki 高亮）；
 *   · 窄侧栏、放大（整屏）、缩放档、文字选择复制（读 Electron 剪贴板对账）；
 *   · 切走取消：切走后不留错误态、**引擎还能接着用**（下一条同文件要能再转成功）；
 *   · 浅色 / 深色两套截图（**截图要人眼看**，本文件只负责产出 + 落盘路径）。
 *
 * ── "真取消"这件事分三层，别把哪一层读大（本探针**不做猴子补丁**）─────────────
 *  `contextBridge.exposeInMainWorld` 暴露的 `window.kyclaw` 在渲染端是**只读**的（Electron 会把
 *  暴露对象冻上），所以在页面里"裹一层 bridge 记账"这条路**不可靠**：要么赋不进去、要么在严格模式
 *  直接抛 —— 那样"取消成功"就成了假证据。本探针改成**只报产品可观察的东西**，IPC 层的真话由各自
 *  的层举证：
 *    1) **渲染端真发了取消**：`dsh-document/__tests__/office-bridge.spec.ts`
 *       （`AbortSignal` 一响就调 `cancelOfficePdf`，且用的是这次发起时的同一个 requestId）；
 *    2) **主进程收到取消并按 `cancelled` 回**：`src/main/__tests__/workbench-office-preview.spec.ts`
 *       的「转换中途被取消：回 cancelled，不是把中止当失败往外抛」（B 的 239 条里那两条）；
 *    3) **本探针**：切走后没有错误态、没留下上一份的残留视图，**并且同一份文件随后还能再转成功**
 *       （取消把引擎弄挂 / 把队列堵死，这里就会红）。
 *
 * ── 夹具来源（逐条见 `fixtures/r90/index.ts` 的 `provenance`）──────────────────
 *   自产（docx / pptxgenjs / exceljs / 文本 / 手工拼 PDF）+ 仓库 `resources/icon.ico` 只读复制
 *   + `.superpowers/office-legacy-fixtures/` 里的**真实旧版** `.doc/.xls/.ppt`（本地件、不入库）。
 *   全程只往临时工作区写，不改任何源件。
 *
 * ── 前置是**硬闸门**（发布必验，不许 skip 漏掉）────────────────────────────────
 *   门开着（`KYCLAW_R90_PREVIEW=1`）时：13 份自产夹具 + 3 份旧版夹具**一份都不能少**、
 *   随包 kit 必须在 —— 缺任何一样都在 `beforeAll` **直接 fail**（带上缺哪一份、路径是什么）。
 *   门没开时整个文件 skip（默认口径，合理）。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────────
 *   KYCLAW_R90_PREVIEW=1 node_modules/.bin/playwright test e2e/_r90-preview-release.spec.ts
 * 证据落盘：`.superpowers/preview-release/`（截图 + `fixtures.json` 清单）。
 *
 * ── 已知未接线依赖（写就时的事实；别人装完自然就绿）──────────────────────────
 *   本文件写就时 `remark-math` / `rehype-katex` 未安装 → `dsh-media/markdown-body.tsx` 那时连构建都
 *   过不去（`Rollup failed to resolve import "remark-math"`）。**依赖一落地，markdown / 数学这条
 *   自然绿**；若跑的时候还红，先看那两个包在不在 `node_modules` 里，再怀疑渲染器。
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'
import {
  LONG_TEXT_TAIL,
  writeR90Fixtures,
  type R90Fixture,
  type R90FixtureSet
} from './fixtures/r90'

const ENABLED = process.env.KYCLAW_R90_PREVIEW === '1'
const EVIDENCE_DIR = resolve('.superpowers', 'preview-release')
/** 随包 kit 的那个 CLI（office 用例的前置；没有就如实 skip）。 */
const KIT_CLI = resolve(
  'resources',
  'libreoffice-kit',
  'node_modules',
  '@deepseek-ai',
  'libreoffice-kit',
  'lib',
  'cli.js'
)

/**
 * 把浮动缩放面板露出来：它的设计是「鼠标离开底部 72px 露头区 420ms 后收起」，
 * 指针不在那儿的时候 `pointer-events:none` —— 这时连 hover 都够不着，必须先移指针再点。
 * 收起是定时的，所以这里重试几拍（真实用户就是「把鼠标挪回去」）。
 *
 * 目标点要**夹进视口**：预览铺满面板时框架下沿可能压到窗口外面，真人也只能把鼠标停
 * 在看得见的像素上（把事件发到视口外等于发给了空气）。每拍打一行日志，红了能直接看出
 * 是"点不在露头区"还是"露头区根本没收到指针"。
 */
async function revealZoomControls(page: Page, frame: Locator, controls: Locator): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await controls.getAttribute('data-dsh-zoom-visible')) === 'true') return
    const box = await frame.boundingBox()
    if (box === null) break
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    }))
    const x = box.x + box.width / 2
    // 底边往上 16px 就是露头区正中；框架下沿探出窗口时退到视口里最后一像素
    const y = Math.min(box.y + box.height - 16, viewport.height - 4)
    const hit = await page.evaluate(
      ([px, py]) => {
        const element = document.elementFromPoint(px as number, py as number)
        return element === null ? 'null' : element.className || element.tagName
      },
      [x, y]
    )
    console.log(
      `[r90] 露头手势 #${attempt}: frame=${JSON.stringify(box)} viewport=${viewport.width}x${viewport.height} target=(${String(Math.round(x))},${String(Math.round(y))}) hit=${String(hit)}`
    )
    await page.mouse.move(x, y)
    await page.waitForTimeout(120)
  }
  // 红了先把祖先链量出来（每层的实际盒子与高度口径）——"框架多高"这件事要一次说清，
  // 免得下一轮还在猜是露头区坐标不对还是高度链断了
  const chain = await page.evaluate(() => {
    const frame = document.querySelector('[data-testid="dsh-zoom-frame"]')
    const lines: string[] = []
    let node: Element | null = frame
    for (let depth = 0; node !== null && depth < 7; depth += 1) {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      lines.push(
        `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 48)} ${String(Math.round(rect.top))}..${String(Math.round(rect.bottom))} h=${String(Math.round(rect.height))} css.h=${style.height} ovf=${style.overflowY} dsp=${style.display} flx=${style.flex}`
      )
      node = node.parentElement
    }
    return lines
  })
  console.log('[r90] 祖先链:', chain.join(' || '))
  await expect(controls).toHaveAttribute('data-dsh-zoom-visible', 'true', { timeout: 5000 })
}

/**
 * 点缩放面板上的一个档位按钮（放大 / 缩小），**点到生效为止**。
 *
 * 为什么不用 `locator.click()`：那一步在这里**不可靠** —— 面板是"露头式"的，`click()` 的
 * 命中判定（"目标元素自己收不收得到指针"）会被面板的收起过渡与重绘卡住，实测出现过
 * "textLayer 拦截指针"连试 30s 的情况。这里改成人手的动作顺序：
 *   1) 把指针挪进露头区（revealZoomControls），面板真露出来；
 *   2) 读面板的**真实可交互性**（`data-dsh-zoom-visible` + 计算样式 `pointer-events`），
 *      露着才点；收起就再挪一次指针（真人也是这么重试的）；
 *   3) 用 `page.mouse.click(按钮中心)` 发**真输入事件**——落在哪个元素上由页面自己决定；
 *   4) 点完由 `applied` 证明**这一击真的生效了**（倍率变了 / 模式变 fixed）；没生效就再点一次
 *      （面板入场是 180ms 的过渡，按钮还在动的那一下点击会被吞掉——官方 DSH 那边也是这套
 *      "露头→点→看结果"的节奏）。四次都不生效就把最后一次的失败原样抛出去，不吞。
 * 探针只做"重试"，不放宽判据：生效与否仍由产品自己的可观察状态说话。
 */
async function clickZoomControl(
  page: Page,
  frame: Locator,
  controls: Locator,
  testId: 'dsh-zoom-in' | 'dsh-zoom-out',
  applied: () => Promise<void>
): Promise<void> {
  const button = page.getByTestId(testId)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await revealZoomControls(page, frame, controls)
    const box = await button.boundingBox()
    if (box === null) throw new Error(`${testId} 没有盒子（面板没挂出来？）`)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const state = await page.evaluate(
      ([px, py]) => {
        const panel = document.querySelector('[data-testid="dsh-zoom-controls"]')
        const style = panel === null ? null : getComputedStyle(panel)
        const hit = document.elementFromPoint(px as number, py as number)
        return {
          visible: panel?.getAttribute('data-dsh-zoom-visible') ?? null,
          opacity: style?.opacity ?? null,
          pointerEvents: style?.pointerEvents ?? null,
          hit:
            hit === null
              ? 'null'
              : (hit.closest('[data-testid]')?.getAttribute('data-testid') ??
                String(hit.className).slice(0, 40))
        }
      },
      [x, y]
    )
    console.log(
      `[r90] 点 ${testId} @(${String(Math.round(x))},${String(Math.round(y))}) 第 ${String(attempt + 1)} 次:`,
      JSON.stringify(state)
    )
    if (state.pointerEvents !== 'auto') {
      await page.waitForTimeout(200)
      continue
    }
    await page.mouse.click(x, y)
    try {
      await applied()
      return
    } catch (error) {
      console.log(`[r90] ${testId} 第 ${String(attempt + 1)} 次点击没生效，重试`)
      if (attempt === 3) throw error
    }
  }
  throw new Error(`${testId} 反复点不到：面板一直收着（pointer-events 不是 auto）`)
}

/**
 * 截预览区一张图（按**视口里看得见的那一块**剪裁）。
 *
 * 为什么不直接对预览体做元素截图：长文本那档"加载更多读到底"以后正文能到 **61 万像素高**
 * （整份 ~700KB 文本一次铺开的样子）。Chromium 对元素截图会去申请一张 `891×611944` 的位图，
 * Skia 直接 `FATAL ... tryAllocPixels` 把**渲染进程带走**（R90 实测：探针在截图那一步把应用崩了，
 * 后面所有断言连带全红）。按视口剪裁既躲开了这个死法，出来的也是"用户看得见的样子"。
 */
async function shotPreview(page: Page, file: string): Promise<void> {
  const box = await page.getByTestId('file-preview-body').boundingBox()
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  if (box === null) {
    await page.screenshot({ path: join(EVIDENCE_DIR, file) })
    return
  }
  const x = Math.max(0, Math.min(box.x, viewport.width - 1))
  const y = Math.max(0, Math.min(box.y, viewport.height - 1))
  const clip = {
    x,
    y,
    width: Math.max(1, Math.min(box.x + box.width, viewport.width) - x),
    height: Math.max(1, Math.min(box.y + box.height, viewport.height) - y)
  }
  await page.screenshot({ path: join(EVIDENCE_DIR, file), clip })
}

/**
 * 点文件树里的某一行：
 *   · `inline` = 单击看内联预览；
 *   · `tab` = 在预览标签里打开。走**右键菜单那条真路径**（`在新标签页中查看`）——
 *     双击试过两条路都不稳：单击那一下会把这份文件的内联预览层挂到面板底部，列表高度当场变、
 *     行会挪位，而双击要求两次点击落在**同一个元素**上；实测第二击落到了相邻那一行
 *     （于是新标签打开的是邻居文件）。右键菜单是产品自己的入口，不受这个挪位影响。
 */
async function clickFile(page: Page, name: string, mode: 'inline' | 'tab'): Promise<void> {
  const row = page.locator(`[data-testid="file-row"][data-kind="file"][data-relative="${name}"]`)
  // 文件树不一定在最前面（上一条用例可能把预览标签留成了当前标签，文件列表就被压到后面去了）
  // ——先把它切回前台，否则行在 DOM 里但不可见
  if ((await row.count()) === 0 || !(await row.isVisible())) {
    await openFilesTool(page)
  }
  await expect(row).toBeVisible({ timeout: 30_000 })
  if (mode === 'inline') {
    await row.click()
    return
  }
  await row.click({ button: 'right' })
  await page.getByTestId('workbench-context-menu-preview').click()
}

/**
 * 打开右栏的文件工具。三个坑（都踩过）：
 *   1) `work-panel-toggle` 是**同名不同事**的两颗按钮（面板关着时是浮动"展开工作台"，开着时是
 *      头部的"收起工作台"）——不能拿它当"确保打开"用；面板已开的稳定信号是头部的 `workbench-close`。
 *   2) 标签按钮**没有 `data-kind`**（只有面板有）。按 `id` 前缀认文件标签：id = `workbench-tab-files-<seq>`。
 *   3) 面板里已有别的标签（没有文件标签）时，空态入口不在 DOM 里——那就走窗口级快捷键 Ctrl+Shift+E。
 */
async function openFilesTool(page: Page): Promise<void> {
  const panel = page.locator('[data-testid="workbench-panel"][data-kind="files"]')
  if ((await page.getByTestId('workbench-close').count()) === 0) {
    await page.getByTestId('work-panel-toggle').click()
    await expect(page.getByTestId('workbench-close')).toBeVisible({ timeout: 10_000 })
  }
  if ((await panel.count()) === 0) {
    const empty = page.getByTestId('workbench-empty-action-files')
    if ((await empty.count()) > 0 && (await empty.isVisible())) {
      await empty.click()
    } else {
      await page.keyboard.press('Control+Shift+E')
    }
  } else if ((await panel.getAttribute('data-active')) !== 'true') {
    await page.locator('[id^="workbench-tab-files-"]').first().click()
  }
  await expect(panel).toHaveAttribute('data-active', 'true', { timeout: 10_000 })
  await expect(page.getByTestId('files-root')).toBeVisible({ timeout: 30_000 })
}

/** 造一个只记账、不回包的哨兵服务（HTML 夹具的脚本与外链都指向它）。 */
function startSentinel(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'image/png' }).end()
  })
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('哨兵没绑上端口')
      done({
        url: `http://127.0.0.1:${String(address.port)}`,
        hits,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections()
            server.close(() => closed())
          })
      })
    })
  })
}

test.describe.serial('R90 · 预览发布验收（真应用：文件树 → IPC → 观看器）', () => {
  // 仓库默认每条 90s：Office 那次冷启动 + 多份转换会超（本文件是"逐个格式真跑一遍"的长用例），
  // 所以按文件放宽到 5 分钟；`expect` 的默认 15s 不动（断言级别的时间都另外给了）。
  test.describe.configure({ timeout: 300_000 })
  test.skip(!ENABLED, 'KYCLAW_R90_PREVIEW=1 才跑（需先 pnpm build）')

  let provider: Awaited<ReturnType<typeof startInteractiveProvider>>
  let sentinel: Awaited<ReturnType<typeof startSentinel>>
  let app: Awaited<ReturnType<typeof createInteractiveApp>>
  let fixtures: R90FixtureSet
  /** 页面发起过的请求（验"没有字体 / CMap 资产请求"这一条） */
  const requests: string[] = []
  /** 选字复制的证据（命令 + 拿回的长度/片段；空值在汇总里如实标出） */
  let clipboardEvidence: { command: string; length: number; text: string } | null = null

  const has = (name: string): boolean => fixtures.written.some((fixture) => fixture.name === name)

  test.beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    // 发布必验的前置之一：随包 kit 必须在。这条独立于应用，**先查**——
    // 缺了就别白起一次 Electron（失败信息里带上路径，直接能定位）
    expect(existsSync(KIT_CLI), `随包 kit 不在：${KIT_CLI}`).toBe(true)

    provider = await startInteractiveProvider()
    sentinel = await startSentinel()
    app = await createInteractiveApp(provider.url)
    app.page.on('request', (request) => requests.push(request.url()))

    // 主进程 stderr：万一是"应用自己退出/崩了"，日志里要有原因（不是只看到 page closed）
    app.app.process().stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') console.log(`[r90:main-stderr] ${text}`)
    })
    // 用例池共享一个实例：万一渲染进程崩了 / 窗口被关了，日志里要能看出来
    // （否则只会看到下游症状 'Target page has been closed'）
    app.page.on('crash', () => {
      console.log('[r90] page crashed')
    })
    app.page.on('close', () => {
      console.log('[r90] page closed')
    })
    app.app.on('close', () => {
      console.log('[r90] app closed')
    })

    // 会话起来工作台才有根：借助脚本化 provider 走一条最小回合
    provider.enqueue({ text: 'R90 就绪' })
    await app.page.getByTestId('composer-input').fill('R90 准备')
    await app.page.getByTestId('composer-send').click()
    await expect(app.page.locator('[data-testid^="session-item-"]').first()).toBeVisible({
      timeout: 30_000
    })
    await openFilesTool(app.page)

    // 文件树的根**不是**默认工作区根：无项目会话落在 `<默认工作区>/tasks/<threadId 前 8 位>`
    // （见 `src/shared/session-dir.ts`）。所以夹具要写进**产品自己那个根**——路径直接从界面读
    // （`files-root` 的 title 就是它），不自己推、也不写死。
    const sessionRoot = await app.page.getByTestId('files-root').getAttribute('title')
    expect(sessionRoot ?? '', '文件树没给出根路径（工作台还没就绪？）').not.toBe('')
    fixtures = await writeR90Fixtures(sessionRoot ?? '', { sentinelUrl: sentinel.url })
    await app.page.getByTestId('files-refresh').click()
    await expect(
      app.page.locator('[data-testid="file-row"][data-kind="file"][data-relative="报告.docx"]')
    ).toBeVisible({ timeout: 30_000 })

    writeFileSync(
      join(EVIDENCE_DIR, 'fixtures.json'),
      `${JSON.stringify(
        {
          workspace: app.workspace,
          sessionRoot,
          written: fixtures.written,
          skipped: fixtures.skipped,
          kit: existsSync(KIT_CLI)
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    // 发布必验：门开着就不许"缺哪份跳哪份"——缺一份直接红，并把缺的路径写进报错里
    expect(fixtures.skipped, `缺夹具：${JSON.stringify(fixtures.skipped, null, 2)}`).toEqual([])
    expect(fixtures.written.length).toBe(15 + 3)
  })

  test.afterAll(async () => {
    await app?.close()
    await provider?.close()
    await sentinel?.close()
  })

  test('切走取消：不留残留、不报错，且同一份文件随后还能再转成功', async () => {
    // 前置在 beforeAll 硬失败过了，这里不再 skip（发布必验，缺夹具就该红）
    expect(has('压力.pptx')).toBe(true)
    // 放在 office 用例最前面：引擎冷启动那一下最长，取消窗口最稳
    await clickFile(app.page, '压力.pptx', 'inline')
    // 转换真发起了（组件进的是"正在加载预览…"，不是错误态）
    await expect(app.page.getByTestId('dsh-office-loading')).toBeVisible({ timeout: 30_000 })
    await expect(app.page.getByTestId('dsh-office-error')).toHaveCount(0)

    // 立刻切走：office 观看器卸载（渲染端会因此发 cancelOfficePdf —— 那一层由
    // `office-bridge.spec.ts` 举证；主进程收到并按 cancelled 回，由 B 的
    // `workbench-office-preview.spec.ts` 举证。这里只验产品看得见的结果）
    await clickFile(app.page, '笔记.txt', 'inline')
    await expect(app.page.getByTestId('dsh-text-body')).toBeVisible({ timeout: 30_000 })
    await expect(app.page.getByTestId('dsh-office-viewer')).toHaveCount(0)
    await expect(app.page.getByTestId('file-preview-error')).toHaveCount(0)

    // 取消把引擎弄挂 / 把队列堵死的话，这一条会红
    await clickFile(app.page, '压力.pptx', 'inline')
    await expect(app.page.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'ready', {
      timeout: 120_000
    })
  })

  test('office 四类：真 DshOfficeViewer → 新阅读器（页式 / 缩放控件 / 文字层）', async () => {
    for (const name of ['报告.docx', '汇报.pptx', '旧方案.doc', '旧汇报.ppt']) {
      expect(has(name), `缺夹具 ${name}（发布必验，不许跳过）`).toBe(true)
      await clickFile(app.page, name, 'inline')

      const office = app.page.getByTestId('dsh-office-viewer')
      await expect(office).toBeVisible({ timeout: 30_000 })
      await expect(office).toHaveAttribute('data-state', 'ready', { timeout: 90_000 })

      const viewer = app.page.getByTestId('dsh-pdf-viewer')
      await expect(viewer).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 })
      expect(Number(await viewer.getAttribute('data-pages'))).toBeGreaterThan(0)
      // 本地资源是**内联分块**：全程不该出现字体 / CMap 的资产请求（判据与 R89 那条一致）。
      // 反过来说：真需要预定义 CMap 时，会在 requests 里看到 `assets/UniGB-UCS2-H-*.js` 这类分块
      // （Office 转换出来的 PDF 自带嵌入字体，通常不会走到那一步）
      expect(requests.filter((url) => /\.(bcmap|ttf|pfb)(\?|$)/i.test(url))).toEqual([])

      // 第一页真画出来了：surface 摘掉 hidden、文字层挂在画布之上
      const surface = app.page.getByTestId('dsh-pdf-page-surface').first()
      await expect(surface).not.toHaveAttribute('hidden', { timeout: 30_000 })
      await expect(app.page.getByTestId('dsh-pdf-page-text').first()).toBeAttached()
      // 这是**新阅读器**，不是独立 .pdf 那个旧入口
      await expect(app.page.getByTestId('pdf-viewer')).toHaveCount(0)
      // 框架必须**装得进窗口**：阅读器自己的滚动口在它里面，装不下就说明高度链又断了——
      // 那时候底部 72px 的"露头区"会落到可视区外（浮动缩放控件够不着），是用户看得见的问题
      const frame = app.page.getByTestId('dsh-zoom-frame')
      const frameBox = await frame.boundingBox()
      const innerHeight = await app.page.evaluate(() => window.innerHeight)
      console.log(
        `[r90] 页式框架几何（${name}）:`,
        JSON.stringify({ frame: frameBox, innerHeight })
      )
      expect(
        (frameBox?.y ?? 0) + (frameBox?.height ?? 0),
        `页式预览的框架比窗口还高（${String(frameBox?.height)} > ${String(innerHeight)}）：滚动口没落在框内，浮动控件会够不着`
      ).toBeLessThanOrEqual(innerHeight + 1)
      // 缩放：控件是**露头式**的（鼠标离开底部 72px 露头区 420ms 后收起、pointer-events:none）。
      // 真实手势的顺序是「把鼠标挪到控件上」——hover() 这一步本身就在露头区里触发 pointermove，
      // 所以下面用"把指针挪进露头区再点"来还原它（见 revealZoomControls）。
      const mode = await frame.getAttribute('data-dsh-zoom-mode')
      expect(['fit-width', 'fixed']).toContain(mode)
      const controls = app.page.getByTestId('dsh-zoom-controls')
      await expect(controls).toBeAttached()
      const percentBefore = await app.page.getByTestId('dsh-zoom-value').textContent()
      // 放大一档：生效的判据 = 模式转成 fixed **且**面板上的百分比真的变了
      await clickZoomControl(app.page, frame, controls, 'dsh-zoom-in', async () => {
        await expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fixed', { timeout: 3000 })
        await expect
          .poll(async () => app.page.getByTestId('dsh-zoom-value').textContent(), { timeout: 3000 })
          .not.toBe(percentBefore)
      })
      const percentAfter = await app.page.getByTestId('dsh-zoom-value').textContent()
      // 再收一档（面板收起时 pointer-events:none，鼠标够不着 —— 所以还要先露头）
      await clickZoomControl(app.page, frame, controls, 'dsh-zoom-out', async () => {
        await expect
          .poll(async () => app.page.getByTestId('dsh-zoom-value').textContent(), { timeout: 3000 })
          .not.toBe(percentAfter)
      })
    }
  })

  test('office：文字选择 + 复制进系统剪贴板；浅色/深色各一张截图', async () => {
    expect(has('报告.docx')).toBe(true)

    await clickFile(app.page, '报告.docx', 'inline')
    await expect(app.page.getByTestId('dsh-pdf-viewer')).toHaveAttribute('data-state', 'loaded', {
      timeout: 90_000
    })
    await expect(app.page.getByTestId('dsh-pdf-page-surface').first()).not.toHaveAttribute(
      'hidden',
      { timeout: 30_000 }
    )

    // 选中文字层整层 → Ctrl+C → 读 Electron 剪贴板对账
    await app.page.evaluate(() => {
      const layer = document.querySelector('[data-testid="dsh-pdf-page-text"] .textLayer')
      if (layer === null) throw new Error('没有文字层（pdf.js 的 TextLayerBuilder 没挂上）')
      const range = document.createRange()
      range.selectNodeContents(layer)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    // 选中的内容先硬断言（选区本身就是"能选"的证据）
    const selected = await app.page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(selected.trim().length, '文字层没选中任何东西').toBeGreaterThan(0)
    expect(selected).toContain('R90')

    // 复制：Ctrl+C → 看系统剪贴板；空就补一次 `execCommand('copy')` 并**看它的返回值**。
    // 拿到内容就硬断言内容；两条路都空（无头/自动化环境常见）就**如实记一笔**，
    // 不把空剪贴板当"复制通过"。
    await app.page.keyboard.press('Control+C')
    let copied = await app.app.evaluate(({ clipboard }) => clipboard.readText())
    let copyCommand = 'ctrl-c'
    if (copied.trim() === '') {
      copyCommand = `execCommand:${String(await app.page.evaluate(() => document.execCommand('copy')))}`
      await app.page.waitForTimeout(300)
      copied = await app.app.evaluate(({ clipboard }) => clipboard.readText())
    }
    clipboardEvidence = {
      command: copyCommand,
      length: copied.trim().length,
      text: copied.slice(0, 60)
    }
    if (copied.trim().length > 0) {
      expect(copied).toContain('R90')
    } else {
      console.log(
        '[r90] 系统剪贴板读回为空（选区与复制命令都成功）——待真机人眼复核:',
        clipboardEvidence
      )
    }

    // 浅色 / 深色各截一张（**截图要人眼看**；这里只保证两张都在、且确实切了主题）。
    // 两张都把浮动缩放面板请出来（露头式，鼠标不在底部就收起）——不然浅深两图一张有一张没有，
    // 看着像"深色下控件没了"
    const themeFrame = app.page.getByTestId('dsh-zoom-frame')
    const themeControls = app.page.getByTestId('dsh-zoom-controls')
    await revealZoomControls(app.page, themeFrame, themeControls)
    await shotPreview(app.page, 'office-light.png')
    // 深色：先走设置那条真实路径；设置没生效就直接改 html[data-theme]（令牌认的就是这个属性），
    // 并**记下用的是哪条路**——截图是真深色，但「设置改主题」这条链路通不通要分开说。
    const themeBefore = await app.page.locator('html').getAttribute('data-theme')
    await app.page.evaluate(() => window.kyclaw.settings.update({ theme: 'dark' }))
    let themeVia = 'settings'
    try {
      await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark', {
        timeout: 5000
      })
    } catch {
      themeVia = 'dom-attribute'
      await app.page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
      })
    }
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await revealZoomControls(app.page, themeFrame, themeControls)
    await shotPreview(app.page, 'office-dark.png')
    await app.page.evaluate((previous: string | null) => {
      document.documentElement.dataset.theme = previous ?? 'light'
    }, themeBefore)
    console.log('[r90] 深色截图取得方式:', themeVia)
  })

  test('表格四类：原始字节 → ExcelPreview（xls/xlsx/csv/tsv）', async () => {
    for (const name of ['台账.xlsx', '名单.csv', '名单.tsv', '底表.xls']) {
      expect(has(name), `缺夹具 ${name}（发布必验，不许跳过）`).toBe(true)
      await clickFile(app.page, name, 'inline')
      const host = app.page.getByTestId('file-preview-table')
      await expect(host).toBeVisible({ timeout: 30_000 })
      await expect(app.page.getByTestId('excel-preview')).toBeVisible({ timeout: 60_000 })
      // 表格**不**走办公档那条 PDF 管线
      await expect(app.page.getByTestId('dsh-office-viewer')).toHaveCount(0)
      await expect(app.page.getByTestId('excel-preview-error')).toHaveCount(0)
      const box = await app.page.getByTestId('excel-preview').boundingBox()
      expect(box?.height ?? 0).toBeGreaterThan(80)
      await shotPreview(app.page, `table-${name.replace(/\./g, '-')}.png`)
    }
  })

  test('PDF：既有入口保留缩略图与目录大纲（本轮不换成新阅读器）', async () => {
    expect(has('样本.pdf')).toBe(true)
    await clickFile(app.page, '样本.pdf', 'inline')

    // 既有 PdfPreview（独立 PDF 入口按原样保留 —— 这里验的就是它，不冒充新链路）
    await expect(app.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 })
    await expect(app.page.getByTestId('file-preview-pdf')).toHaveAttribute('data-pages', '3', {
      timeout: 30_000
    })
    // 不冒充：新版阅读器**不该**出现在这条路径上
    await expect(app.page.getByTestId('dsh-pdf-viewer')).toHaveCount(0)

    await app.page.getByTestId('pdf-sidebar-toggle').click()
    await expect(app.page.getByTestId('pdf-sidebar')).toHaveAttribute('data-open', 'true')
    await expect(app.page.getByTestId('pdf-thumb')).toHaveCount(3)
    // 大纲：夹具 PDF 带 /Outlines，点第二项要跳到第 2 页
    const outlineTab = app.page.getByTestId('pdf-tab-outline')
    await expect(outlineTab).toBeVisible({ timeout: 30_000 })
    await outlineTab.click()
    const items = app.page.getByTestId('pdf-outline-item')
    await expect(items).toHaveCount(3)
    await expect(items.nth(1)).toHaveText(/Chapter 2/)
    // 跳页靠"滚到那一页的 canvas 顶上"，所以目标页的 canvas 得先在：
    // 画布还没画出来时产品那边直接不滚（`jumpToPage` 拿不到 canvas 就返回），随后"跟着可见页走"
    // 的那次量测会把高亮退回第 1 页——实测 4 轮里撞到 1 次。这里等稳态再点；这条竞态
    // 作为一条已知小瑕疵单独记在报告里（点得早的用户会有一次"点了没反应"）。
    await expect(app.page.locator('canvas[data-page="2"]')).toBeAttached({ timeout: 30_000 })
    await items.nth(1).click()
    await expect(items.nth(1)).toHaveAttribute('data-current', 'true', { timeout: 30_000 })
  })

  test('图片：svg / ico 都按图片渲染（DshImageBody）', async () => {
    for (const name of ['预览.svg', '图标.ico']) {
      expect(has(name), `缺夹具 ${name}（发布必验，不许跳过）`).toBe(true)
      await clickFile(app.page, name, 'inline')
      const image = app.page.getByTestId('file-preview-image').first()
      await expect(image).toBeVisible({ timeout: 30_000 })
      await expect(image).toHaveAttribute('data-loaded', 'true', { timeout: 30_000 })
      await expect(app.page.getByTestId('file-preview-image-error')).toHaveCount(0)
      await shotPreview(app.page, `image-${name.replace(/\./g, '-')}.png`)
    }
  })

  test('HTML：sandbox 预览，脚本与外链都不执行（哨兵服务零命中）', async () => {
    expect(has('网页.html')).toBe(true)
    await clickFile(app.page, '网页.html', 'inline')

    await expect(app.page.getByTestId('file-preview-html')).toBeVisible({ timeout: 30_000 })
    const frame = app.page.getByTestId('dsh-html-preview')
    await expect(frame).toBeVisible({ timeout: 30_000 })
    // 结构性断言：sandbox 必须**不带** allow-scripts / allow-same-origin
    const sandbox = (await frame.getAttribute('sandbox')) ?? ''
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')

    await app.page.waitForTimeout(1500) // 给"万一真执行了"留出打点时间
    // 两件事各由一条机制挡住，别混着说：
    //   · **脚本不执行** ← `sandbox=""`（上面那条断言：没有 allow-scripts / allow-same-origin）
    //   · **外链不打** ← 渲染端 CSP 的 `img-src 'self' data:` 与 `connect-src 'self'`（http 外链先被 CSP 拦掉）
    // 这里断言的是"两条合起来的可观察结果"：哨兵服务一次都没被敲过。
    expect(sentinel.hits).toEqual([])
    expect(requests.filter((url) => url.startsWith(sentinel.url))).toEqual([])
    await shotPreview(app.page, 'html-preview.png')
  })

  test('Markdown：正文渲染 + 数学（.katex）', async () => {
    expect(has('说明.md')).toBe(true)
    await clickFile(app.page, '说明.md', 'inline')

    await expect(app.page.getByTestId('dsh-markdown-body')).toBeVisible({ timeout: 30_000 })
    await expect(app.page.getByTestId('dsh-markdown-body')).toContainText('R90 预览验收')
    // 数学：dsh-media 的 markdown 走 remark-math + rehype-katex（那两个包不在，这条就红）
    await expect(app.page.locator('.katex').first()).toBeVisible({ timeout: 30_000 })
    await shotPreview(app.page, 'markdown-math.png')
  })

  test('文本 / 代码：纯文本与 shiki 高亮各一条', async () => {
    await clickFile(app.page, '笔记.txt', 'inline')
    await expect(app.page.getByTestId('dsh-text-body')).toContainText('R90 纯文本')

    if (has('片段.ts')) {
      await clickFile(app.page, '片段.ts', 'inline')
      const code = app.page.getByTestId('file-preview-code')
      await expect(code).toBeVisible({ timeout: 30_000 })
      await expect(code.getByTestId('code-block')).toHaveAttribute('data-highlighted', 'true', {
        timeout: 30_000
      })
      await shotPreview(app.page, 'code-highlight.png')
    }
  })

  test('窄侧栏：窗口收窄后预览仍可用（新阅读器不掉高度）', async () => {
    expect(has('报告.docx')).toBe(true)

    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 980, height: 760 })
    })
    await expect
      .poll(async () => app.page.evaluate(() => window.innerWidth), { timeout: 10_000 })
      .toBeLessThan(1080)

    await clickFile(app.page, '报告.docx', 'inline')
    await expect(app.page.getByTestId('dsh-pdf-viewer')).toHaveAttribute('data-state', 'loaded', {
      timeout: 90_000
    })
    const frame = await app.page.getByTestId('dsh-zoom-frame').boundingBox()
    expect(frame?.height ?? 0).toBeGreaterThan(120)
    const body = await app.page.getByTestId('file-preview-body').boundingBox()
    await app.page.screenshot({ path: join(EVIDENCE_DIR, 'narrow-sidebar.png') })
    expect(body?.width ?? 0).toBeGreaterThan(0)
  })

  test('放大（整屏）：预览标签里仍可用，且不冒充新链路的那条断言照旧', async () => {
    expect(has('说明.md')).toBe(true)
    // 先把窗口还原成宽窗：窄窗（上一条用例留下的 980×760）下工作台头部中间那一格**不是**全屏开关，
    // 而是「恢复并排 / 返回对话」（见 Workbench 的 spaceConstrained 分支）——要验整屏得先有那颗按钮
    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1400, height: 900 })
    })
    await expect
      .poll(async () => app.page.evaluate(() => window.innerWidth), { timeout: 10_000 })
      .toBeGreaterThan(1200)
    await openFilesTool(app.page)
    await clickFile(app.page, '说明.md', 'tab')
    // 打开的是**这份文件**的预览标签（不是"反正有个预览标签"——上一份的表标签也满足可见性）
    await expect(app.page.getByTestId('preview-tool')).toHaveAttribute('data-relative', '说明.md', {
      timeout: 30_000
    })

    // 全屏开关是**硬断言**：它不在这儿说明形态判断反了，不该悄悄跳过这一条
    const fullscreen = app.page.getByTestId('workbench-fullscreen')
    await expect(fullscreen).toBeVisible({ timeout: 10_000 })
    await fullscreen.click()
    // 真的进了整屏：按钮语义翻成"回到窗口化"（Workbench 自己的口径，不是探针的猜测）
    await expect(fullscreen).toHaveAccessibleName('回到窗口化', { timeout: 10_000 })
    await expect(app.page.getByTestId('dsh-markdown-body')).toBeVisible({ timeout: 30_000 })
    // 滚动状态留一笔：整屏那张截图里正文**左边被切掉一截**（"R90 预览验收"只剩"验收"）——
    // 是"哪个容器横向滚过"要拿数字说话，别靠眼睛猜
    const scrolls = await app.page.evaluate(() => {
      const lines: string[] = []
      let node: Element | null = document.querySelector('[data-testid="dsh-markdown-body"]')
      for (let depth = 0; node !== null && depth < 8; depth += 1) {
        const style = getComputedStyle(node)
        if (/auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) {
          lines.push(
            `${node.tagName}.${String(node.className).slice(0, 28)} x=${String(node.scrollLeft)}/${String(node.scrollWidth)}-${String(node.clientWidth)} y=${String(node.scrollTop)}/${String(node.scrollHeight)}-${String(node.clientHeight)}`
          )
        }
        node = node.parentElement
      }
      return lines
    })
    console.log('[r90] 整屏 markdown 的滚动容器:', scrolls.join(' || ') || '（没有滚动容器）')
    const geometry = await app.page.evaluate(() => {
      const body = document.querySelector('[data-testid="dsh-markdown-body"]')
      const rect = body?.getBoundingClientRect() ?? null
      const panel =
        document
          .querySelector('[data-testid="preview-tool"]')
          ?.parentElement?.getBoundingClientRect() ?? null
      return {
        innerWidth: window.innerWidth,
        scrollX: window.scrollX,
        docScrollLeft: document.documentElement.scrollLeft,
        visualOffsetLeft: window.visualViewport?.offsetLeft ?? null,
        visualWidth: window.visualViewport?.width ?? null,
        zoom: window.devicePixelRatio,
        markdown: rect === null ? null : { x: rect.x, width: rect.width },
        panel: panel === null ? null : { x: panel.x, width: panel.width }
      }
    })
    console.log('[r90] 整屏 markdown 几何:', JSON.stringify(geometry))
    const chain = await app.page.evaluate(() => {
      const lines: string[] = []
      let node: Element | null = document.querySelector('[data-testid="dsh-markdown-body"]')
      while (node !== null) {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        const testId = node.getAttribute('data-testid') ?? ''
        lines.push(
          `${node.tagName.toLowerCase()}${testId === '' ? '' : `[${testId}]`}.${String(node.className).slice(0, 26)} x=${String(Math.round(rect.x))} w=${String(Math.round(rect.width))} pos=${style.position} z=${style.zIndex} ovf=${style.overflow} tf=${style.transform === 'none' ? '-' : style.transform}`
        )
        if (node.getAttribute('data-testid') === 'shell-row') break
        node = node.parentElement
      }
      return lines
    })
    console.log('[r90] 整屏祖先链:', chain.join(' || '))
    // 面板从"分栏"变成"整屏"是一次布局切换：过渡没走完就截图，可能拍到一帧混合合成结果
    await app.page.waitForTimeout(1000)
    await app.page.screenshot({ path: join(EVIDENCE_DIR, 'enlarged-fullscreen.png') })
    await expect(app.page.getByTestId('preview-refresh')).toBeVisible()

    // 复位：共用实例的用例池，别把'整屏'留给后面的用例
    await fullscreen.click()
    await expect(fullscreen).toHaveAccessibleName('面板全屏', { timeout: 10_000 })
  })

  test('长文本：分页 + 「加载更多」读到底（读到 eof 后按钮消失、尾标记可见）', async () => {
    expect(has('长文.txt')).toBe(true)
    await clickFile(app.page, '长文.txt', 'inline')

    // 定位**都夹在"文件树的内联预览"这一块里**：预览标签那条用例可能还留着一个预览标签，
    // 同一个 testid 会在页面里出现两份（strict mode 直接报"resolved to 2 elements"）
    const body = app.page.getByTestId('file-preview-body')
    const paged = body.getByTestId('paged-text')
    await expect(paged).toBeVisible({ timeout: 30_000 })
    // 一页 256 KB，这份 ~700 KB：第一页读完仍未到底，尾标记这时候不该出现
    await expect(paged).toHaveAttribute('data-complete', 'false', { timeout: 30_000 })
    await expect(body.getByTestId('paged-text-more-row')).toBeVisible()
    await expect(paged).not.toContainText(LONG_TEXT_TAIL)

    // 一路点到 eof：每一击都必须**真的多读到东西**（不是点了个没反应的按钮）
    for (let step = 0; step < 8; step += 1) {
      if ((await body.getByTestId('paged-text-more-row').count()) === 0) break
      const before = (await paged.textContent())?.length ?? 0
      await body.getByTestId('paged-text-more').click()
      await expect
        .poll(async () => (await paged.textContent())?.length ?? 0, { timeout: 30_000 })
        .toBeGreaterThan(before)
    }

    await expect(paged).toHaveAttribute('data-complete', 'true', { timeout: 30_000 })
    await expect(body.getByTestId('paged-text-more-row')).toHaveCount(0)
    await expect(paged).toContainText(LONG_TEXT_TAIL)
    await shotPreview(app.page, 'text-load-more.png')
  })

  test('磁盘编辑：可见的文本预览自动刷到新内容（旧内容不留在同一页里）', async () => {
    expect(has('轮询.txt')).toBe(true)
    await clickFile(app.page, '轮询.txt', 'inline')

    const body = app.page.getByTestId('file-preview-body')
    const paged = body.getByTestId('paged-text')
    await expect(paged).toContainText('R90-V1', { timeout: 30_000 })

    // 真在磁盘上改这份文件（探针自己写；产品只负责发现）。
    // 路径必须是**文件树那个根**（无项目会话落在 `<默认工作区>/tasks/<threadId 前 8 位>`，
    // 不等于 app.workspace）——写错地方产品看的是另一份文件，这条就会假红
    const target = join(fixtures.dir, '轮询.txt')
    writeFileSync(target, 'R90-V2 磁盘上改过了\n第二行也是新的\n第三行\n', 'utf8')

    // 轮询节拍 4s：给到 20s 还没变就是没做自动刷新（读者在顶端、补的范围又小，按口径该自动刷）
    await expect(paged).toContainText('R90-V2', { timeout: 20_000 })
    await expect(paged).not.toContainText('R90-V1')
    await shotPreview(app.page, 'text-auto-refresh.png')

    // 再改一次，但这次先把它**切走**再切回来：重开必须读到最新一份（不是缓存的旧内容）
    writeFileSync(target, 'R90-V3 第三次写入\n', 'utf8')
    await clickFile(app.page, '笔记.txt', 'inline')
    await expect(body.getByTestId('dsh-text-body')).toBeVisible({ timeout: 30_000 })
    await clickFile(app.page, '轮询.txt', 'inline')
    await expect(body.getByTestId('paged-text')).toContainText('R90-V3', { timeout: 30_000 })
  })

  test('汇总：这一轮写完的夹具 / 跳过的夹具（报告里逐条对账）', () => {
    console.log(
      JSON.stringify(
        {
          workspace: fixtures.dir,
          written: fixtures.written.map(
            (fixture: R90Fixture) => `${fixture.name}[${fixture.mode}]`
          ),
          skipped: fixtures.skipped,
          kit: existsSync(KIT_CLI),
          sentinelHits: sentinel.hits.length,
          clipboard: clipboardEvidence,
          evidenceDir: EVIDENCE_DIR
        },
        null,
        2
      )
    )
    expect(fixtures.written.length).toBe(15 + 3)
  })
})
