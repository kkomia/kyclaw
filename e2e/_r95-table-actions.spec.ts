import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'
import { defaultSettings } from '../src/shared/settings'

/**
 * 0.1.3 · 007（回复里的表格：圆角 + 横向滚动 + 复制 / 下载）的**真实 Electron 验证**。
 *
 *   pnpm build && KYCLAW_TABLE_PROBE=1 pnpm exec playwright test e2e/_r95-table-actions.spec.ts
 *
 * 用**隔离实例**跑（harness.launchApp：临时 userData + 随机端口脚本 provider，`KYCLAW_FORCE_MOCK=0`：
 * 走真模型那条链路、真 HTTP + SSE，不读任何真实凭据、不碰用户的 profile）。
 *
 * 核的是一条链**真的能跑**（jsdom 核不了）：
 *   1. 真剪贴板：点复制 → 读**系统剪贴板**（主进程 clipboard.readText）→ 与这段 Markdown **逐字节**相等
 *      （含 `\|` 转义、`:---:` 对齐、行内代码）；
 *   2. 真下载：点下载 → 下载落在磁盘上 → 读回来同样逐字节相等，文件名带表头标识与本地时间戳；
 *   3. 真布局窄窗（800×800）：圆角外壳的 computed style、表格在容器里**真溢出**、scrollLeft 真推得动；
 *   4. 真流式门：流挂着时操作行 `display:none`（不可点不可见），放行结束时按钮出现；流式期间追加的 delta
 *      不把已画好的表格 DOM 换掉（判据 = 给表格打的探针属性还在，节点没被重挂）；浅/深色各留截图。
 *
 * 边界（如实写在这里，不冒充全覆盖）：
 *   - 截图只产图片，**不做目视结论** —— 观感结论由看图的人写；
 *   - 多张表"复制不串台"核的是两张不同的表（同表头不同内容那种同名文件由浏览器自己加序号，未核）；
 *   - 窄窗核的是"内容超出容器时能滚"，没有核触控板横向手势；
 *   - 流式核的是真 SSE 分帧（两段正文 + 闸门），**不是**逐 token 的真模型；真实模型那条链路由
 *     单元与既有 e2e 覆盖（round 73）。
 */

const enabled = process.env.KYCLAW_TABLE_PROBE === '1'
const evidenceRoot = resolve('.superpowers/table-actions')

/** 宽表（窄窗里必然溢出）+ 转义管道 + 对齐记号 + 行内代码：复制/下载要与这几个逐字节对上 */
const TABLE_MAIN = [
  '| 项目 | 负责人 | 状态 | 预计完成 | 备注说明 | 风险等级 |',
  '| :--- | --- | :-: | ---: | --- | :---: |',
  '| 需求梳理 | 张三 | 已完成 | 10-01 | 与业务方逐条过了一遍口径 | 低 |',
  '| 接口联调 | 李四 | 进行中 | 10-08 | 依赖上游的鉴权改造，联调环境还没就绪 | 中 |',
  '| 灰度放量 | 王五 | 未开始 | 10-15 | 需要在发布窗口前排好回滚预案 | 高 |',
  '| 验收报告 | 赵六 | 未开始 | 10-20 | 转义样例 `a\\|b` 与对齐样例 | 低 |'
].join('\n')

/** 第二张表：表头完全不同的另一张，用来核"各复制各的" */
const TABLE_SECOND = [
  '| 名称 | 数量 | 备注 |',
  '| --- | --- | --- |',
  '| 苹果 | 3 | 一箱 |',
  '| 梨 | 12 | 两箱 |'
].join('\n')

const TWO_TABLES = [
  '先把两张表放在同一条回复里：',
  '',
  TABLE_MAIN,
  '',
  '第二张表：',
  '',
  TABLE_SECOND,
  '',
  '两张表各自的按钮只对自己那张生效。'
].join('\n')

/**
 * 流式那一轮的第一段：把表推完，后面直接接一句正文（**不切块** —— 表格所在的那一块每进来一个
 * delta 都会重渲染，正是"组件每帧重建会不会把已画好的表整棵重挂"要压的那个面）。
 */
const STREAM_HEAD = ['先看这张表：', '', TABLE_MAIN, '', '表格后面这半段先推到这里。'].join('\n')

interface StreamStep {
  /** 这一轮正文按顺序发出的增量 */
  pieces: string[]
  /** 发 pieces[i] 之前要等一次 release()（下标升序） */
  holdAt?: number[]
}

interface ScriptedProvider {
  url: string
  /** 放行一个闸门（调用早于闸门建立也算数，不会空放） */
  release: () => void
  streamRequests: () => number
  close: () => Promise<void>
}

/**
 * 脚本 provider：非流式（标题生成 / 连通性探测）回一句固定的，不占脚本；
 * 流式按 `script` 逐轮发出正文增量，`holdAt` 的位置等 release（探针靠它把"流挂着"这一档停住）。
 */
async function startScriptedProvider(script: StreamStep[]): Promise<ScriptedProvider> {
  let sequence = 0
  let streamRequests = 0
  let credit = 0
  const gates: Array<() => void> = []
  const gate = (): Promise<void> => {
    if (credit > 0) {
      credit -= 1
      return Promise.resolve()
    }
    return new Promise<void>((done) => {
      gates.push(() => done())
    })
  }
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'table-probe' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
    const id = `table-probe-${++sequence}`

    if (body.stream !== true) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: 1,
          model: 'table-probe',
          choices: [
            { index: 0, message: { role: 'assistant', content: '探针会话' }, finish_reason: 'stop' }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
      return
    }

    const step = script[streamRequests] ?? { pieces: ['TABLE_PROBE_DONE'] }
    streamRequests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frame = (delta: unknown, finish: string | null): void => {
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'table-probe', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      )
    }
    const holds = new Set(step.holdAt ?? [])
    // 逐段发（增量语义与真模型一致：每个增量一个 frame）；闸门卡在指定下标的那一段之前
    for (const [index, piece] of step.pieces.entries()) {
      if (holds.has(index)) await gate()
      frame(index === 0 ? { role: 'assistant', content: piece } : { content: piece }, null)
    }
    frame({}, 'stop')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('探针 provider 没绑上端口')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    release: () => {
      const next = gates.shift()
      if (next) next()
      else credit += 1
    },
    streamRequests: () => streamRequests,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

async function launchProbeApp(providerUrl: string): Promise<Awaited<ReturnType<typeof launchApp>>> {
  return launchApp({
    settings: {
      semanticRecall: { ...defaultSettings().semanticRecall, enabled: false },
      providers: [
        {
          id: 'table-probe',
          type: 'openai-compatible',
          baseUrl: providerUrl,
          model: 'table-probe',
          isDefault: true
        }
      ]
    },
    env: { KYCLAW_FORCE_MOCK: '0' }
  })
}

type ProbeApp = Awaited<ReturnType<typeof launchApp>>['app']

async function resizeWindow(
  app: ProbeApp,
  page: Page,
  width: number,
  height: number
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('没有窗口')
      win.unmaximize()
      win.setBounds({ x: 0, y: 0, ...size })
    },
    { width, height }
  )
  await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 4, width, {
    timeout: 10_000
  })
}

/** 系统剪贴板（主进程那一侧读，绕开渲染进程的读权限） */
function readClipboard(app: ProbeApp): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

/**
 * 本机剪贴板能不能读回来：主进程 `writeText` 之后立刻 `readText`，比一比哨兵串。
 *
 * 为什么要这条自检：本机（agent 会话里起 Electron）实测**整个剪贴板子系统读回恒为空** ——
 * 主进程自写自读为空、渲染端 writeText 之后主进程读为空、`Ctrl+V` 粘出来也是空
 * （诊断输出留在 `_r95-clipboard-diag.spec.ts` 那一轮日志里，与 R90 记过的现象一致）。
 * 那种环境下"OS 剪贴板内容"这一跳**没法核**：探针如实记录，并且**只在能读回来时才硬断言**。
 */
function clipboardRoundTripWorks(app: ProbeApp): Promise<boolean> {
  return app.evaluate(({ clipboard }) => {
    const sentinel = `kyclaw-r95-${String(Date.now())}`
    clipboard.writeText(sentinel)
    // 主进程的 clipboard.readText() 是同步的（Electron API），但 Playwright 这里把它按 DOM 版
    // Clipboard 推类型（Promise<string>）：用 String() 归一到字符串再比，类型与运行时都对
    return String(clipboard.readText()) === sentinel
  })
}

/**
 * 在**渲染端**拦一层 `clipboard.writeText`：记下应用交给剪贴板的字节，同时照旧调真实现。
 * 这一层核的是"应用复制的内容对不对"（真 Chromium、真点击、真组件），
 * 与上面那条 OS 读回互补 —— 机器剪贴板读不回来时，至少这一半是有据的。
 */
async function installClipboardCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __r95Copied?: string[] }
    store.__r95Copied = []
    const clipboard = navigator.clipboard
    const original = clipboard.writeText.bind(clipboard)
    clipboard.writeText = (text: string): Promise<void> => {
      store.__r95Copied?.push(text)
      return original(text)
    }
  })
}

async function capturedCopies(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __r95Copied?: string[] }).__r95Copied ?? [])
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async (next) => {
    if (!window.kyclaw) throw new Error('缺少生产桥')
    await window.kyclaw.settings.update({ theme: next })
  }, theme)
  await page.reload()
  await waitForChat(page)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ''))
    .toBe(theme)
}

test.describe('0.1.3 · 007 表格（窄窗 / 真剪贴板 / 真下载 / 流式门）', () => {
  test.skip(!enabled, 'KYCLAW_TABLE_PROBE=1 时才跑（真实例探针，需要 pnpm build 的 out/ 产物）')
  test.setTimeout(6 * 60 * 1000)

  test('浅/深色窄窗观感 + 横向滚动 + 复制（真剪贴板）/ 下载（真落盘）', async () => {
    const provider = await startScriptedProvider([
      { pieces: [TWO_TABLES] },
      { pieces: [TWO_TABLES] }
    ])
    const launched = await launchProbeApp(provider.url)
    const { app, page } = launched
    const runDir = join(evidenceRoot, `run-${Date.now()}`)
    const downloadDir = mkdtempSync(join(tmpdir(), 'kyclaw-r95-dl-'))
    const savePath = join(downloadDir, 'table-download.md')
    const shots: string[] = []
    try {
      mkdirSync(runDir, { recursive: true })
      await resizeWindow(app, page, 800, 800)

      /** 等一轮真跑完：正文落地 + 操作行出现（操作行出现本身就是"流结束了"的界面判据） */
      const waitDone = async (): Promise<void> => {
        await expect(page.getByTestId('message-text').last()).toContainText(
          '两张表各自的按钮只对自己那张生效。',
          { timeout: 60_000 }
        )
        await expect(page.getByTestId('table-actions').first()).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId('markdown-table')).toHaveCount(2)
      }

      const shot = async (name: string): Promise<void> => {
        const file = join(runDir, `${name}.png`)
        await page.getByTestId('markdown-table').last().scrollIntoViewIfNeeded()
        await page.screenshot({ path: file, fullPage: true })
        shots.push(file)
        console.log(`[r95] 截图 → ${file}`)
      }

      await sendMessage(page, '探针：把两张表放在一条回复里')
      await waitDone()
      await shot('light-narrow-tables')

      // ---- 圆角外壳：真实 computed style（jsdom 核不了样式） ----
      const shellStyle = await page
        .getByTestId('markdown-table')
        .first()
        .evaluate((el) => {
          const style = getComputedStyle(el)
          return {
            radius: Number.parseFloat(style.borderTopLeftRadius),
            border: style.borderTopWidth + ' ' + style.borderTopStyle,
            overflow: style.overflowX
          }
        })
      expect(shellStyle.radius).toBeGreaterThan(0)
      expect(shellStyle.border).toContain('solid')
      expect(shellStyle.overflow).toBe('hidden')

      // ---- 横向滚动：内容真溢出，scrollingElement 真推得动 ----
      const scroll = page.getByTestId('markdown-table-scroll').first()
      const metrics = await scroll.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth
      }))
      expect(
        metrics.scrollWidth,
        `表格没有溢出容器（scrollWidth ${metrics.scrollWidth} ≤ clientWidth ${metrics.clientWidth}）`
      ).toBeGreaterThan(metrics.clientWidth)
      const scrollLeft = await scroll.evaluate((el) => {
        el.scrollLeft = 60
        return el.scrollLeft
      })
      expect(scrollLeft).toBeGreaterThan(0)
      await scroll.evaluate((el) => {
        el.scrollLeft = 0
      })

      // ---- 复制：真点击 → 应用交给 clipboard API 的字节（渲染端捕获，逐字节核） ----
      await installClipboardCapture(page)
      const shells = page.getByTestId('markdown-table')
      await shells.nth(1).getByTestId('table-copy').click()
      // 先看界面反馈（2s 后自清）
      await expect(shells.nth(1).getByTestId('table-status')).toHaveText('已复制')
      expect(await capturedCopies(page)).toEqual([TABLE_SECOND])

      await shells.nth(0).getByTestId('table-copy').click()
      await expect(shells.nth(0).getByTestId('table-status')).toHaveText('已复制')
      const copies = await capturedCopies(page)
      // 多表隔离 + 逐字节：第二张只有第二张，第一张只有第一张
      expect(copies).toEqual([TABLE_SECOND, TABLE_MAIN])
      const copied = copies[1] ?? ''
      expect(copied).toContain('`a\\|b`')
      expect(copied).toContain(':---')
      expect(copied).not.toContain('名称')
      expect(copies[0] ?? '').not.toContain('接口联调')

      // OS 那一跳：能读回来就硬断言；本机读不回来（见 clipboardRoundTripWorks 注）就如实记一笔
      const osClipboardReadable = await clipboardRoundTripWorks(app)
      if (osClipboardReadable) {
        await shells.nth(0).getByTestId('table-copy').click()
        await expect.poll(() => readClipboard(app), { timeout: 20_000 }).toBe(TABLE_MAIN)
        console.log('[r95] OS 剪贴板读回：已核（与渲染端捕获一致）')
      } else {
        console.log(
          '[r95] OS 剪贴板读回：本机不可用（主进程自写自读也为空）→ 这一跳未验，见 manifest'
        )
      }

      // ---- tooltip：hover 与聚焦两条路都核（house Tooltip 的既有口径见 tooltip.spec.tsx） ----
      const copyButton = shells.nth(0).getByTestId('table-copy')
      // 先把指针挪开再 hover：Playwright 的 hover 落在"指针已经在的位置"上**不会**产生
      // pointermove，而 Radix 只在 pointermove 上开 tooltip —— 上一次点击刚点过这个按钮，
      // 位置完全相同，第三跑实测 trigger 一直是 closed；对照控件（换了个位置）就浮出来了。
      await page.mouse.move(5, 5)
      await copyButton.hover()
      await page.waitForTimeout(1200)
      const hoverTooltipOpen = (await page.locator('[role="tooltip"]').count()) > 0
      const hoverTriggerState = await copyButton.getAttribute('data-state')
      console.log(
        `[r95] tooltip hover：role=tooltip=${String(hoverTooltipOpen)} trigger data-state=${String(hoverTriggerState)}`
      )
      await expect(
        page.getByRole('tooltip').filter({ hasText: '复制表格 Markdown' })
      ).toContainText('复制表格 Markdown', { timeout: 10_000 })
      // 对照：界面里另一个 Tooltip 控件（上下文环）在同一台机器上一样能浮出来
      const contextChip = page.getByTestId('composer-context')
      if ((await contextChip.count()) > 0) {
        await contextChip.hover()
        await page.waitForTimeout(1200)
        console.log(
          `[r95] 对照（composer-context hover）：role=tooltip 数量=${String(await page.locator('[role="tooltip"]').count())}`
        )
      }
      // 键盘这条路（聚焦）也核一遍
      await page.mouse.move(5, 5)
      // 前面点过这个按钮 → 它还是 document.activeElement，再 focus() **不会**产生 focus 事件
      // （Radix 的 onFocus 是开的唯一入口）→ 先 blur 掉再聚焦
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.waitForTimeout(200)
      await copyButton.focus()
      await expect(
        page.getByRole('tooltip').filter({ hasText: '复制表格 Markdown' })
      ).toContainText('复制表格 Markdown', { timeout: 10_000 })
      console.log('[r95] tooltip：hover 与聚焦两条路都核过')
      await page.mouse.move(10, 10)

      // ---- 下载：真落盘 + 文件名带表头标识与时间戳 ----
      // 主进程直接指定落点（不然 Electron 会弹原生"另存为"，自动化里点不到）；
      // 文件名从下载项本身取，核的是应用给的那个名字。
      await app.evaluate(({ session }, target) => {
        const names: string[] = []
        ;(globalThis as unknown as { __r95DownloadNames?: string[] }).__r95DownloadNames = names
        session.defaultSession.on('will-download', (_event, item) => {
          names.push(item.getFilename())
          item.setSavePath(target)
        })
      }, savePath)
      // Playwright 也接了下载事件：两条路谁先到都算，内容两边核
      const viaPlaywright = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
      await shells.nth(0).getByTestId('table-download').click()
      // 界面反馈 2s 后自清：先抓住它，再去核下载本身
      await expect(shells.nth(0).getByTestId('table-status')).toHaveText('已开始下载')
      const download = await viaPlaywright
      if (download !== null) {
        expect(download.suggestedFilename()).toMatch(/^kyclaw-表格-项目-\d{8}-\d{6}\.md$/)
        const path = await download.path()
        expect(path).not.toBeNull()
        expect(readFileSync(String(path), 'utf8')).toBe(TABLE_MAIN)
        console.log(`[r95] 下载证据走 Playwright：${download.suggestedFilename()}`)
      } else {
        await expect.poll(() => existsSync(savePath), { timeout: 30_000 }).toBe(true)
        expect(readFileSync(savePath, 'utf8')).toBe(TABLE_MAIN)
        const names = await app.evaluate(
          () =>
            (globalThis as unknown as { __r95DownloadNames?: string[] }).__r95DownloadNames ?? []
        )
        expect(names[0] ?? '').toMatch(/^kyclaw-表格-项目-\d{8}-\d{6}\.md$/)
        console.log(`[r95] 下载证据走 will-download：${names[0] ?? '(无)'}`)
      }

      // ---- 深色：换主题（重载 → 新会话）后再跑一轮，窄窗留一张 ----
      await setTheme(page, 'dark')
      // 换主题要重载页面；重载后开个新会话，别让上一轮的表格混进这一轮的计数
      await page.getByTestId('new-session').click()
      await expect(page.getByTestId('composer-input')).toHaveValue('')
      await sendMessage(page, '探针：深色再放两张表')
      await waitDone()
      await shot('dark-narrow-tables')
      await installClipboardCapture(page)
      await shells.nth(0).getByTestId('table-copy').click()
      await expect(shells.nth(0).getByTestId('table-status')).toHaveText('已复制')
      expect(await capturedCopies(page)).toEqual([TABLE_MAIN])

      writeFileSync(
        join(runDir, 'manifest.json'),
        `${JSON.stringify(
          {
            round: '0.1.3 · 007 表格（表代理 _r95）',
            generatedAt: new Date().toISOString(),
            isolation:
              'harness.launchApp：临时 userData + 随机端口脚本 provider（KYCLAW_FORCE_MOCK=0）；不读凭据、不碰用户 profile',
            window: '800×800（浅色 + 深色）',
            asserted: [
              '圆角外壳 computed style（radius > 0 / solid hairline / overflow hidden）',
              '横向滚动：scrollWidth > clientWidth 且 scrollLeft 真推得动',
              '复制：真点击后应用交给 clipboard API 的字节逐字节相等（含 `a\\|b` 与 :---:）；两张表各复制各的',
              'tooltip：真 hover 浮出"复制表格 Markdown"',
              '下载：落盘内容逐字节相等；文件名 kyclaw-表格-项目-<时间戳>.md',
              '浅/深色窄窗截图各一张'
            ],
            clipboardEvidence: osClipboardReadable
              ? '渲染端捕获（应用交给 API 的字节）+ OS 读回：双证'
              : '仅渲染端捕获；OS 剪贴板读回本机恒空（主进程自写自读也为空、Ctrl+V 亦为空）→ OS 一跳未验',
            tooltipEvidence:
              'hover 与聚焦两条路都硬核过（Radix 的 hover 只认 pointermove：Playwright 的 hover 落在指针原位不产生事件，探针先挪开指针再 hover）',
            downloadEvidence:
              download === null ? '主进程 will-download' : 'Playwright download 事件',
            screenshots: shots,
            note: '只产证据（截图 + 断言结果）；目视结论由看图的人写，本文件不冒充目视通过'
          },
          null,
          2
        )}\n`
      )
      console.log(`[r95] 证据 → ${runDir}（${shots.length} 张截图）`)
    } finally {
      await closeApp(launched)
      await provider.close()
      rmSync(downloadDir, { recursive: true, force: true })
    }
  })

  test('流式门：挂着时操作不可见，结束后出现；增量 delta 不重挂已画好的表', async () => {
    const provider = await startScriptedProvider([
      { pieces: [STREAM_HEAD, '再推一段。', '收尾。'], holdAt: [1, 2] }
    ])
    const launched = await launchProbeApp(provider.url)
    const { app, page } = launched
    const runDir = join(evidenceRoot, `run-${Date.now()}`)
    const shots: string[] = []
    try {
      mkdirSync(runDir, { recursive: true })
      await resizeWindow(app, page, 800, 800)

      const shot = async (name: string): Promise<void> => {
        const file = join(runDir, `${name}.png`)
        await page.getByTestId('markdown-table').last().scrollIntoViewIfNeeded()
        await page.screenshot({ path: file, fullPage: true })
        shots.push(file)
        console.log(`[r95] 截图 → ${file}`)
      }

      await sendMessage(page, '探针：流式里的表')
      // 第一段就到（表 + 一段正文），流还挂着
      await expect(page.getByTestId('markdown-table')).toHaveCount(1, { timeout: 60_000 })
      await expect(page.getByTestId('message-text').last()).toContainText(
        '表格后面这半段先推到这里。'
      )
      // 输出没结束：操作行整行不可见（真 Chromium 的 computed style，不是 DOM 里有没有）
      await expect(page.getByTestId('table-actions')).toBeHidden()
      await expect(page.getByTestId('table-copy')).toBeHidden()
      await expect(page.getByTestId('table-download')).toBeHidden()
      await shot('narrow-streaming-actions-hidden')

      // 给已画好的表打个探针属性：节点要是被重挂，这个属性就没了
      await page
        .getByTestId('markdown-table')
        .evaluate((el) => el.setAttribute('data-probe-stamp', 'r95'))

      // 放行一段增量：正文继续长，但流还没结束
      provider.release()
      await expect(page.getByTestId('message-text').last()).toContainText('再推一段。', {
        timeout: 30_000
      })
      await expect(page.getByTestId('table-actions')).toBeHidden()
      await expect(page.getByTestId('markdown-table')).toHaveAttribute('data-probe-stamp', 'r95')
      await shot('narrow-streaming-growing')

      // 收尾：流结束 → 操作行出现（按钮"结束后出现"的那一跳）
      provider.release()
      await expect(page.getByTestId('table-actions')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('table-copy')).toBeVisible()
      await expect(page.getByTestId('message-text').last()).toContainText('收尾。')
      await shot('narrow-done-actions-visible')

      // 结束后那一下仍能复制（把原文切片这条路在真引擎里再走一遍：捕获到的字节逐字节相等）
      await installClipboardCapture(page)
      await page.getByTestId('table-copy').click()
      await expect(page.getByTestId('table-status')).toHaveText('已复制')
      expect(await capturedCopies(page)).toEqual([TABLE_MAIN])

      writeFileSync(
        join(runDir, 'manifest.json'),
        `${JSON.stringify(
          {
            round: '0.1.3 · 007 表格 · 流式门（表代理 _r95）',
            generatedAt: new Date().toISOString(),
            isolation: '同上（临时 userData + 本地 SSE 脚本 provider，真分帧推送）',
            asserted: [
              '流挂着（data-streaming=true）时 table-actions / table-copy / table-download 均 toBeHidden',
              '流式期间追加一段 delta：已画好的表格 DOM 节点未被重挂（data-probe-stamp 还在）',
              '流结束后 table-actions 转 visible；复制交给 clipboard API 的字节与原文逐字节相等'
            ],
            screenshots: shots,
            boundary:
              '真分帧（两段正文 + 两道闸门），不是逐 token 的真模型；窄窗 800×800；OS 剪贴板那一跳本机读回恒空（见 test 1 的 clipboardEvidence），只核到"应用交给 API 的字节"',
            note: '只产证据；目视结论由看图的人写'
          },
          null,
          2
        )}\n`
      )
      console.log(`[r95] 证据 → ${runDir}（${shots.length} 张截图）`)
    } finally {
      await closeApp(launched)
      await provider.close()
    }
  })
})
