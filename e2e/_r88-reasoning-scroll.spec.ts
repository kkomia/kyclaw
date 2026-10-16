import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { defaultSettings } from '../src/shared/settings'

/**
 * 思考框滚动 **真实排版** 探针（不进常规 e2e 闸门；只在 `KYCLAW_REASONING_SCROLL=1` 时运行）：
 *
 *   corepack pnpm build && KYCLAW_REASONING_SCROLL=1 corepack pnpm exec playwright test e2e/_r88-reasoning-scroll.spec.ts
 *
 * 为什么单测不够：`reasoning-part.spec` / `reasoning-scroll.spec` 的几何是 stub 出来的
 * （clientHeight / scrollHeight 用 defineProperty 喂），它们验的是**判断逻辑**；这里要验的是
 * "真 Chromium 里 `ResizeObserver` 会不会在长思考时按时触发、`scrollTop` 写下去是不是真的尾行可见"。
 *
 * 隔离：临时 userData + 临时 home + 临时工作区 + **本地脚本化供应商**（不联网、不读任何真实密钥、
 * 不碰用户 profile）。思考流是 SSE 的 `reasoning_content` 增量（与 DeepSeek 官方协议的字段同名，
 * `@ai-sdk/openai-compatible` 把它译成 reasoning part）。
 *
 * 覆盖（用户反馈的那条 bug + 三条边界 + 工具循环那一轮）：
 *   1. 流式贴底：长思考进来自滚，尾行在视野里（修前：scrollTop 恒 0 = 想了一半就不动）；
 *   2. 用户上翻：位置守住，不被新内容拽回底部；
 *   3. 流结束 + 折叠重开：不回到中途位置；
 *   4. 译文切换：贴底的人还在底部（翻译走真 IPC → 本地脚本化翻译端点）；
 *   5. **工具循环**（第二用例，用户现场那一轮的形状）：思考 → 工具行 → 思考 → 正文 ——
 *      写好的那段思考在**工具行上屏、整轮还在跑**的当口自动收起（此时过程块必须仍开着，
 *      工具行看得见），工具之后的第二段思考自己贴底，整轮跑完两段都收起。
 *      这一条特意不靠"轮次结束"撑：第一用例的自动折叠在轮末也会发生（那是 round 6 的老行为），
 *      只有"轮次还在跑"这一档才证明 `settled`（round 88）真的生效。
 */
const enabled = process.env.KYCLAW_REASONING_SCROLL === '1'
/** 排障产物（本地，不入库）：每一步的决策数字落盘，断言失败时也留得下来 */
const decisionsFile = resolve(
  process.env.KYCLAW_R88_OUT ?? join('.superpowers', 'r88-decisions.json')
)

/**
 * 每帧的思考增量（**英文**：思考翻译只在"与目标语言不一致"时才出控件，这里要顺带验译文切换）。
 * 多行、够快撑爆 268px 限高。
 */
const REASONING_DELTA = 'Trace one more lead: check the file layout, then the call chain.\n'
const REASONING_CHUNKS = 45
const CHUNK_DELAY_MS = 170
const FINAL_MARK = 'That ends the thinking for now.'
const ANSWER = '探针回答：已经看过你说的那条路。'

/**
 * 工具循环那一路（第二用例）：思考 → glob 工具 → 思考 → 正文。
 * 两段思考都用**中文**（目标语言是中文 → 不出翻译控件，这条用例只验折叠与贴底）。
 */
const LOOP_DELTA = '再顺着一条线索往下查：先看文件结构，再走一遍调用链上的每个分支。\n'
const LOOP_CHUNKS = 26
const LOOP_DELAY_MS = 90
const LOOP_ANSWER = '探针回答：工具结果看过了，链路是通的。'
/** 第二段思考：比第一段更长（也要撑爆 268px，才有"贴不贴底"可验） */
const AFTER_TOOL_DELTA = '拿到结果了，再核对一遍调用链上的两处细节，确认没有别的分支被漏掉。\n'
const AFTER_TOOL_CHUNKS = 30
/** 工具结果回来之后先停这么久再开第二段：留一个"工具行可见、整轮还在跑"的稳定窗口 */
const TOOL_HOLD_MS = 1500

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-reasoning-probe',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'reasoning-probe',
    choices: [{ index: 0, delta, finish_reason: finish }]
  })}\n\n`
}

/** 脚本化供应商：`/v1/chat/completions`（流式思考 + 非流式兜底）+ 翻译端点 */
async function startProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'reasoning-probe' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const piece of request) chunks.push(Buffer.from(piece))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      stream?: boolean
      messages?: { content?: unknown }[]
    }
    const asked = JSON.stringify(body.messages ?? [])
    // 翻译那一路：主进程直接 POST 提示词，回一句短中文（不进流）
    if (asked.includes('直接输出翻译结果') && body.stream !== true) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'chatcmpl-translate',
          object: 'chat.completion',
          created: 1,
          model: 'reasoning-probe',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: Array.from(
                  { length: 30 },
                  (_, index) =>
                    `译文第 ${index + 1} 行：再顺着一条线索往下查——先看文件结构，再走一遍调用链。`
                ).join('\n')
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
      return
    }
    // 标题生成 / 连接测试这类非流式请求：给一句话就够
    if (body.stream !== true) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'chatcmpl-plain',
          object: 'chat.completion',
          created: 1,
          model: 'reasoning-probe',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '探针会话' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(chunk({ role: 'assistant', content: '' }, null))
    for (let index = 0; index < REASONING_CHUNKS; index += 1) {
      const text =
        index === REASONING_CHUNKS - 1 ? `${REASONING_DELTA}${FINAL_MARK}\n` : REASONING_DELTA
      response.write(chunk({ reasoning_content: text }, null))
      await new Promise((done) => setTimeout(done, CHUNK_DELAY_MS))
    }
    response.write(chunk({ content: ANSWER }, null))
    response.write(chunk({}, 'stop'))
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('供应商没绑定 TCP 端口')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

/**
 * 工具循环的脚本化供应商（第二用例）：两段脚本按**请求里有没有工具结果**分。
 *   1. 第一轮：长思考（够撑爆 268px）→ `glob` 工具调用（id `call-r88-1`）；
 *   2. 第二轮（请求里带着 `call-r88-1` 的结果）：先停 `TOOL_HOLD_MS` 留一个"工具行可见、
 *      整轮还在跑"的窗口，再流第二段思考 → 正文 → stop。
 *
 * 工具挑 `glob`：`read` 档免审批（不会把探针卡在审批条上），目标不传时按**会话根**扫
 * （round 55 的会话子目录由应用自己建出来），所以临时工作区里什么都不用预置就能跑成功。
 */
async function startToolLoopProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'reasoning-probe' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const piece of request) chunks.push(Buffer.from(piece))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = JSON.parse(raw) as { stream?: boolean }
    if (body.stream !== true) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'chatcmpl-loop-plain',
          object: 'chat.completion',
          created: 1,
          model: 'reasoning-probe',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '探针会话' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
      return
    }
    const afterTool = raw.includes('call-r88-1')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(chunk({ role: 'assistant', content: '' }, null))
    if (!afterTool) {
      for (let index = 0; index < LOOP_CHUNKS; index += 1) {
        response.write(chunk({ reasoning_content: LOOP_DELTA }, null))
        await new Promise((done) => setTimeout(done, LOOP_DELAY_MS))
      }
      response.write(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call-r88-1',
                type: 'function',
                function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*' }) }
              }
            ]
          },
          null
        )
      )
      response.write(chunk({}, 'tool_calls'))
      response.end('data: [DONE]\n\n')
      return
    }
    // 工具结果回来：先稳住（这段时间里工具行在屏上、整轮还在跑），再流第二段思考与正文
    await new Promise((done) => setTimeout(done, TOOL_HOLD_MS))
    for (let index = 0; index < AFTER_TOOL_CHUNKS; index += 1) {
      response.write(chunk({ reasoning_content: AFTER_TOOL_DELTA }, null))
      await new Promise((done) => setTimeout(done, LOOP_DELAY_MS))
    }
    response.write(chunk({ content: LOOP_ANSWER }, null))
    response.write(chunk({}, 'stop'))
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('供应商没绑定 TCP 端口')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

async function launchProbeApp(baseUrl: string): Promise<{
  page: Page
  workspace: string
  /** 主进程 stdout/stderr（工具执行等只在这一侧有日志） */
  logs: string[]
  close: () => Promise<void>
}> {
  const root = mkdtempSync(join(tmpdir(), 'kyclaw-reasoning-scroll-'))
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  for (const directory of [profile, home, workspace]) mkdirSync(directory, { recursive: true })
  const settings = defaultSettings()
  settings.workspaces = [{ path: workspace, mode: 'ask' }]
  settings.defaultWorkspace = workspace
  settings.defaultWorkspaceInitialized = true
  settings.semanticRecall.enabled = false
  settings.langfuse.endpoint = ''
  // 译文按按钮模式：流完先看原文，点「翻译」才走翻译那一趟（贴底的人应还在底部）
  settings.reasoningTranslate = {
    ...settings.reasoningTranslate,
    enabled: true,
    mode: 'button',
    baseUrl,
    model: 'reasoning-probe'
  }
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings))
  const main = resolve('out/main/index.js')
  const bootstrap = join(root, 'bootstrap.cjs')
  writeFileSync(
    bootstrap,
    `const { app } = require('electron'); app.setPath('home', ${JSON.stringify(home)}); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(main)});`
  )
  const env: Record<string, string | undefined> = { ...process.env, KYCLAW_FORCE_MOCK: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const app: Awaited<ReturnType<typeof electron.launch>> = await electron.launch({
    args: [bootstrap, `--user-data-dir=${profile}`],
    cwd: resolve('.'),
    env: env as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const logs: string[] = []
  app.process().stdout?.on('data', (piece: Buffer) => logs.push(String(piece)))
  app.process().stderr?.on('data', (piece: Buffer) => logs.push(String(piece)))
  await page.waitForFunction(() => !!window.kyclaw?.settings)
  await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })
  await page.evaluate(async (url) => {
    await window.kyclaw.settings.update({
      providers: [
        {
          id: 'reasoning-probe',
          type: 'openai-compatible',
          baseUrl: url,
          model: 'reasoning-probe',
          isDefault: true
        }
      ]
    })
  }, baseUrl)
  return {
    page,
    workspace,
    logs,
    close: async () => {
      try {
        await app.close()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}

/** 真 DOM 里量一次思考框的滚动几何（差 >1px 才算"不在底部"，避免子像素噪声当成失败） */
async function measure(page: Page): Promise<{
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
  textChars: number
}> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="reasoning-text"]')
    if (!(box instanceof HTMLElement)) throw new Error('没有思考框')
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight
    return {
      scrollTop: box.scrollTop,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      distanceFromBottom,
      textChars: box.textContent?.length ?? 0
    }
  })
}

/** 把思考框的滚动条拖到某个位置，然后等跟随状态稳定下来（真浏览器的 scroll 事件是异步的） */
async function scrollReasoning(page: Page, top: number | 'bottom'): Promise<void> {
  await page.waitForFunction(
    () => {
      const box = document.querySelector('[data-testid="reasoning-text"]')
      return box instanceof HTMLElement && box.clientHeight > 20
    },
    undefined,
    { timeout: 5_000 }
  )
  await page.evaluate((where) => {
    const box = document.querySelector('[data-testid="reasoning-text"]')
    if (!(box instanceof HTMLElement)) return
    // 够滚才滚：内容比容器矮时（例如很短的译文）没有"上翻"这回事，落点只能是 0
    if (box.scrollHeight - box.clientHeight <= 4) return
    box.scrollTop = where === 'bottom' ? box.scrollHeight : where
  }, top)
  // 落点已经是目标值（例如"本来就在底/顶"）时不会派发 scroll 事件，跟随状态也不用翻
  if (top === 0) {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="reasoning-text"]')?.scrollTop === 0,
      undefined,
      { timeout: 5_000 }
    )
    return
  }
  await page.waitForFunction(
    () => {
      const box = document.querySelector('[data-testid="reasoning-text"]')
      return box instanceof HTMLElement && box.dataset.follow === 'bottom'
    },
    undefined,
    { timeout: 5_000 }
  )
}

/**
 * 量第 N 个思考框（`fromEnd` = 0 是最后一个）：工具循环那一轮里同时挂着两个
 * （第一段收起后仍在 DOM 里参与折叠过渡），要看的是后面那段正在写的。
 */
async function measureAt(
  page: Page,
  fromEnd = 0
): Promise<{
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
  textChars: number
}> {
  return page.evaluate((offset) => {
    const boxes = document.querySelectorAll('[data-testid="reasoning-text"]')
    const box = boxes[boxes.length - 1 - offset]
    if (!(box instanceof HTMLElement)) throw new Error('没有思考框')
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight
    return {
      scrollTop: box.scrollTop,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      distanceFromBottom,
      textChars: box.textContent?.length ?? 0
    }
  }, fromEnd)
}

/** 第 N 个思考框的开合（`fromEnd` 同上） */
async function toggleStateAt(page: Page, fromEnd = 0): Promise<string | null> {
  return page.evaluate((offset) => {
    const toggles = document.querySelectorAll('[data-testid="reasoning-toggle"]')
    const toggle = toggles[toggles.length - 1 - offset]
    return toggle?.getAttribute('aria-expanded') ?? null
  }, fromEnd)
}

/** 本轮第一段思考的开合（DOM 顺序里的第一个；从后往前数在"第二段还没到"时会数空） */
async function firstToggleState(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector('[data-testid="reasoning-toggle"]')?.getAttribute('aria-expanded') ??
      null
  )
}

/** 屏上挂着几个思考框（收起的那些如果是**重挂**之后第一次提交就收着，内容不进 DOM —— 见 TraceFold 的 everOpened） */
async function reasoningBoxCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-testid="reasoning-text"]').length)
}

/** 屏上挂着几个思考段的开合钮（= 这一段思考在不在：按钮永远在，内容才受折叠影响） */
async function reasoningToggleCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-testid="reasoning-toggle"]').length)
}

/** 那一刻的界面状态快照（排障用：为什么这段思考是开/收，一眼看出是哪一档判据在说话） */
async function phaseState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const article = document.querySelector('[data-role="assistant"]')
    const block = document.querySelector('[data-testid="trace-block"]')
    const toggles = [...document.querySelectorAll('[data-testid="reasoning-toggle"]')]
    return {
      messageStreaming: article?.getAttribute('data-streaming') ?? null,
      blockOpen: block?.getAttribute('data-open') ?? null,
      blockRunning:
        block?.querySelector('[data-testid="trace-toggle"]')?.getAttribute('data-running') ?? null,
      toggles: toggles.map((toggle) => toggle.getAttribute('aria-expanded')),
      labels: toggles.map((toggle) => toggle.textContent),
      stopVisible: document.querySelector('[data-testid="composer-stop"]') !== null,
      toolStates: [...document.querySelectorAll('[data-testid="tool-card"]')].map((card) =>
        card.getAttribute('data-state')
      ),
      toolNames: [...document.querySelectorAll('[data-testid="tool-card"]')].map((card) =>
        card.getAttribute('data-tool')
      ),
      toolText: [...document.querySelectorAll('[data-testid="tool-card"]')]
        .map((card) => card.textContent)
        .join(' | '),
      articleText: article?.textContent?.slice(-300) ?? null
    }
  })
}

test.describe('思考框滚动（真实排版）', () => {
  test.skip(!enabled, 'KYCLAW_REASONING_SCROLL=1 时才跑真实排版探针')
  test('长思考自滚：流式贴底 / 上翻守住 / 折叠重开不跳 / 译文切换不抢位置', async () => {
    test.setTimeout(180_000)
    const provider = await startProvider()
    const launched = await launchProbeApp(provider.url)
    const decisions: Record<string, unknown> = {}
    try {
      const { page } = launched
      await page.getByTestId('composer-input').fill('请把这段排查思路展开讲讲')
      await page.getByTestId('composer-send').click()
      await expect(page.getByTestId('reasoning-text')).toBeVisible({ timeout: 30_000 })

      // ── 1. 贴底：容器一旦可滚就要贴住底部（修前 scrollTop 恒 0）────────────────────────
      const followed = await page.waitForFunction(
        () => {
          const box = document.querySelector('[data-testid="reasoning-text"]')
          if (!(box instanceof HTMLElement)) return false
          const scrollable = box.scrollHeight - box.clientHeight > 20
          const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 1
          return scrollable && atBottom ? { scrollHeight: box.scrollHeight } : false
        },
        undefined,
        { timeout: 60_000 }
      )
      expect(await followed.jsonValue()).not.toBeNull()

      // 还在流（后面还有帧）、且仍然贴底：多等几帧再量，防止"开头碰巧在底"
      const samples: Awaited<ReturnType<typeof measure>>[] = []
      for (let index = 0; index < 6; index += 1) {
        await page.waitForTimeout(120)
        samples.push(await measure(page))
      }
      decisions.followed = {
        samples: samples.map((sample) => ({
          top: sample.scrollTop,
          sh: sample.scrollHeight,
          ch: sample.clientHeight,
          gap: sample.distanceFromBottom
        }))
      }
      expect(samples.every((sample) => sample.scrollTop > 0)).toBe(true)
      expect(samples.every((sample) => sample.distanceFromBottom <= 1)).toBe(true)
      expect(samples[samples.length - 1].scrollHeight).toBeGreaterThan(samples[0].scrollHeight)

      // ── 2. 用户上翻：位置守住（新内容还在来）───────────────────────────────────────────
      const followState = async (): Promise<{ follow?: string; last?: string }> =>
        page.evaluate(() => {
          const box = document.querySelector('[data-testid="reasoning-text"]')
          if (!(box instanceof HTMLElement)) return {}
          return { follow: box.dataset.follow, last: box.dataset.followLast }
        })
      // 用户滚动的落点要"稳定下来"再往下量：Chromium 派发 scroll 事件的当帧里，
      // 跟随那条 effect 还可能按旧判断再写一次（下一帧就被 onScroll 纠正回来）
      await scrollReasoning(page, 0)
      const heldFrom = await measure(page)
      await page.waitForTimeout(700)
      const heldTo = await measure(page)
      decisions.scrolledUp = {
        from: heldFrom.scrollTop,
        to: heldTo.scrollTop,
        contentGrew: heldTo.scrollHeight > heldFrom.scrollHeight
      }
      writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2))
      expect(heldTo.scrollTop).toBe(heldFrom.scrollTop)
      // "新内容还在来"必须真验到（不然这条能靠"流早就停了"混过去）
      expect(heldTo.scrollHeight).toBeGreaterThan(heldFrom.scrollHeight)

      // ── 等这一轮跑完（发送钮回来）────────────────────────────────────────────────────
      await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('reasoning-text')).toHaveText(new RegExp(FINAL_MARK))

      writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2))

      // ── 0. 自动折叠：正文一开始写，写完的那段思考就该收起来（用户没点过）─────────────────
      const fold = page.getByTestId('reasoning-part').getByTestId('trace-fold')
      const autoFolded = await page.evaluate(
        () =>
          document
            .querySelector('[data-testid="reasoning-toggle"]')
            ?.getAttribute('aria-expanded') ?? null
      )
      decisions.autoFolded = autoFolded
      expect(autoFolded).toBe('false')
      await page.screenshot({ path: resolve('.superpowers', 'r88-auto-collapsed.png') })

      // 用户点开 → 撑着；再等几帧（流已经结束，其间照旧有 re-render）不许被重新压回去
      await page.getByTestId('reasoning-toggle').click()
      await expect(fold).toHaveAttribute('data-open', 'true')
      await page.waitForTimeout(600)
      expect(
        await page.evaluate(
          () =>
            document
              .querySelector('[data-testid="reasoning-toggle"]')
              ?.getAttribute('aria-expanded') ?? null
        )
      ).toBe('true')

      // ── 3a. 自己滚回底：重新贴上（规则 3）──────────────────────────────────────────
      await scrollReasoning(page, 'bottom')

      // ── 3b. 折叠重开：贴底的人重开还在底部（不跳回中途 / 不跳顶部）──────────────────
      await page.getByTestId('reasoning-toggle').click()
      await expect(fold).toHaveAttribute('data-open', 'false')
      await page.getByTestId('reasoning-toggle').click()
      await expect(fold).toHaveAttribute('data-open', 'true')
      await page.waitForTimeout(400)
      const reopened = await measure(page)
      decisions.reopened = reopened
      expect(reopened.distanceFromBottom).toBeLessThanOrEqual(1)

      // ── 3c. 上翻之后再折一次：位置守住（这条才是"不抢阅读位置"）────────────────────
      await scrollReasoning(page, 0)
      await page.getByTestId('reasoning-toggle').click()
      await expect(fold).toHaveAttribute('data-open', 'false')
      await page.getByTestId('reasoning-toggle').click()
      await expect(fold).toHaveAttribute('data-open', 'true')
      await page.waitForFunction(
        () => {
          const box = document.querySelector('[data-testid="reasoning-text"]')
          if (!(box instanceof HTMLElement)) return false
          return box.dataset.follow === 'hold' && box.scrollTop === 0
        },
        undefined,
        { timeout: 5_000 }
      )
      const heldAfterFold = await measure(page)
      decisions.heldAfterFold = heldAfterFold
      expect(heldAfterFold.scrollTop).toBe(0)

      // ── 4. 译文切换：贴底的人切了还在底部 ─────────────────────────────────────────────
      await scrollReasoning(page, 'bottom')
      await page.getByTestId('reasoning-translate-action').click()
      await expect(page.getByTestId('reasoning-text')).toHaveAttribute(
        'data-showing',
        'translated',
        {
          timeout: 30_000
        }
      )
      const translated = await measure(page)
      decisions.translated = translated
      expect(translated.distanceFromBottom).toBeLessThanOrEqual(1)

      // 上翻读译文 → 切回原文：位置守住（翻译那段不该抢阅读位置）
      await scrollReasoning(page, 0)
      const beforeToggle = await measure(page)
      decisions.beforeOriginal = { ...beforeToggle, ...(await followState()) }
      await page.getByTestId('reasoning-show-original').click()
      await expect(page.getByTestId('reasoning-text')).toHaveAttribute('data-showing', 'original')
      await page.waitForTimeout(300)
      const afterToggle = await measure(page)
      const afterState = await followState()
      decisions.backToOriginal = {
        before: beforeToggle.scrollTop,
        after: afterToggle.scrollTop,
        afterState
      }
      writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2))
      // 切回原文：位置守住 —— 上翻的人不许被拽到底部、也不许跳回顶部
      expect(beforeToggle.scrollTop).toBeLessThan(
        beforeToggle.scrollHeight - beforeToggle.clientHeight
      )
      expect(afterToggle.scrollTop).toBeLessThanOrEqual(beforeToggle.scrollTop)

      console.log(`[r88-reasoning-scroll] ${JSON.stringify(decisions)}`)
      writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2))
    } finally {
      await launched.close()
      await provider.close()
    }
  })

  /**
   * 用户现场那一条（工具循环）：思考 → 工具 → 再思考 → 正文。
   * 与上一条的区别正是**"整轮还在跑"**：上一条的自动折叠发生在轮次结束（`live=false` 也会收，
   * 光看它分不出 `settled` 有没有生效）；这一条在工具行上屏、轮次还没完的那一刻验折叠。
   */
  test('工具循环：写完的思考在工具行上屏时自动收起，工具后的新思考继续贴底', async () => {
    test.setTimeout(180_000)
    const provider = await startToolLoopProvider()
    const launched = await launchProbeApp(provider.url)
    const decisions: Record<string, unknown> = {}
    const loopFile = resolve('.superpowers', 'r88-tool-loop.json')
    try {
      const { page } = launched
      await page.getByTestId('composer-input').fill('先扫一眼工作区，再讲讲你的排查思路')
      await page.getByTestId('composer-send').click()

      // ── 1. 第一段思考：容器一可滚就贴底（工具行还没到）──────────────────────────────
      const followed = await page.waitForFunction(
        () => {
          const box = document.querySelector('[data-testid="reasoning-text"]')
          if (!(box instanceof HTMLElement)) return false
          const scrollable = box.scrollHeight - box.clientHeight > 20
          const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 1
          return scrollable && atBottom ? { scrollHeight: box.scrollHeight } : false
        },
        undefined,
        { timeout: 60_000 }
      )
      expect(await followed.jsonValue()).not.toBeNull()
      const firstSamples: Awaited<ReturnType<typeof measureAt>>[] = []
      for (let index = 0; index < 5; index += 1) {
        await page.waitForTimeout(120)
        firstSamples.push(await measureAt(page, 0))
      }
      decisions.firstPhase = {
        samples: firstSamples.map((sample) => ({
          top: sample.scrollTop,
          sh: sample.scrollHeight,
          ch: sample.clientHeight,
          gap: sample.distanceFromBottom
        }))
      }
      expect(firstSamples.every((sample) => sample.scrollTop > 0)).toBe(true)
      expect(firstSamples.every((sample) => sample.distanceFromBottom <= 1)).toBe(true)
      expect(firstSamples[firstSamples.length - 1].scrollHeight).toBeGreaterThan(
        firstSamples[0].scrollHeight
      )

      // ── 2. 工具行上屏（整轮还在跑）：写完的那段思考自动收起，过程块本身开着 ──────────────
      await expect(page.getByTestId('tool-card').first()).toBeVisible({ timeout: 30_000 })
      await page.waitForFunction(
        () => {
          const block = document.querySelector('[data-testid="trace-block"]')
          const toggle = document.querySelector('[data-testid="reasoning-toggle"]')
          return (
            block?.getAttribute('data-open') === 'true' &&
            toggle?.getAttribute('aria-expanded') === 'false'
          )
        },
        undefined,
        { timeout: 30_000 }
      )
      const running = await page.getByTestId('composer-stop').isVisible()
      decisions.toolArrived = {
        state: await phaseState(page),
        boxes: await reasoningBoxCount(page),
        toggles: await reasoningToggleCount(page),
        folded: await firstToggleState(page),
        blockOpen: await page.getByTestId('trace-block').first().getAttribute('data-open'),
        running
      }
      decisions.mainLogs = launched.logs.slice(-25)
      writeFileSync(loopFile, JSON.stringify(decisions, null, 2))
      // 工具行看得见（过程块没跟着收），思考行收着：整轮还在跑（停止键挂着）
      expect(running).toBe(true)
      expect(await reasoningToggleCount(page)).toBe(1)
      expect(await firstToggleState(page)).toBe('false')
      // 撑一会儿（第二段思考紧接着开流）：不许被后续 re-render 弹回来
      await page.waitForTimeout(700)
      expect(await firstToggleState(page)).toBe('false')

      // ── 3. 工具之后的第二段思考：自己的容器也贴底（同一轮里第二段，前面已收着一份）───────
      const secondFollowed = await page.waitForFunction(
        () => {
          const boxes = document.querySelectorAll('[data-testid="reasoning-text"]')
          const box = boxes[boxes.length - 1]
          if (!(box instanceof HTMLElement)) return false
          const scrollable = box.scrollHeight - box.clientHeight > 20
          const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 1
          return scrollable && atBottom ? { count: boxes.length } : false
        },
        undefined,
        { timeout: 60_000 }
      )
      decisions.secondPhaseBoxes = await secondFollowed.jsonValue()
      // 趁它还在写（采样要 600ms，整段流只有 ~2.7s）：两段思考都在，新的一段开着、块开着、第一段仍收着
      decisions.secondPhaseStart = {
        state: await phaseState(page),
        toggles: await reasoningToggleCount(page)
      }
      expect(await reasoningToggleCount(page)).toBe(2)
      expect(await firstToggleState(page)).toBe('false')
      expect(await toggleStateAt(page, 0)).toBe('true')
      expect(await page.getByTestId('trace-block').first().getAttribute('data-open')).toBe('true')

      const secondSamples: Awaited<ReturnType<typeof measureAt>>[] = []
      for (let index = 0; index < 5; index += 1) {
        await page.waitForTimeout(120)
        secondSamples.push(await measureAt(page, 0))
      }
      decisions.secondPhase = {
        state: await phaseState(page),
        samples: secondSamples.map((sample) => ({
          top: sample.scrollTop,
          sh: sample.scrollHeight,
          ch: sample.clientHeight,
          gap: sample.distanceFromBottom
        }))
      }
      writeFileSync(loopFile, JSON.stringify(decisions, null, 2))
      expect(secondSamples.every((sample) => sample.scrollTop > 0)).toBe(true)
      expect(secondSamples.every((sample) => sample.distanceFromBottom <= 1)).toBe(true)
      expect(secondSamples[secondSamples.length - 1].scrollHeight).toBeGreaterThan(
        secondSamples[0].scrollHeight
      )

      // ── 4. 正文到达、整轮跑完：两段思考都收着，过程块跟着收 ──────────────────────────
      await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('message-text').last()).toContainText(LOOP_ANSWER)
      expect(await firstToggleState(page)).toBe('false')
      expect(await toggleStateAt(page, 0)).toBe('false')
      decisions.settled = {
        last: await toggleStateAt(page, 0),
        first: await firstToggleState(page),
        blockOpen: await page.getByTestId('trace-block').first().getAttribute('data-open'),
        toolStates: await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="tool-card"]')].map((card) =>
            card.getAttribute('data-state')
          )
        )
      }
      // 工具这一路是真跑的（生产 glob 工具，结果成功）：上面那些断言不是靠"工具失败了所以整轮提前结束"
      expect(await page.getByTestId('tool-card').first().getAttribute('data-state')).toBe(
        'output-available'
      )
      // 工具结果原文（排障 + 目视证据；best-effort：整轮跑完后过程块是收着的，先点开它）
      try {
        const traceToggle = page.getByTestId('trace-toggle')
        if ((await traceToggle.getAttribute('aria-expanded')) === 'false') await traceToggle.click()
        const rows = page.getByTestId('tool-row')
        if (
          (await rows.count()) > 0 &&
          (await rows.first().getAttribute('aria-expanded')) === 'false'
        ) {
          await rows.first().click()
        }
        decisions.toolCard = await page.evaluate(() => ({
          input: document.querySelector('[data-testid="tool-input"]')?.textContent ?? null,
          output: document.querySelector('[data-testid="tool-output"]')?.textContent ?? null
        }))
        await page.screenshot({ path: resolve('.superpowers', 'r88-tool-loop.png') })
      } catch (cause) {
        decisions.toolCard = { error: String(cause).slice(0, 200) }
      }
      console.log(`[r88-reasoning-tool-loop] ${JSON.stringify(decisions)}`)
      writeFileSync(loopFile, JSON.stringify(decisions, null, 2))
    } finally {
      await launched.close()
      await provider.close()
    }
  })
})
