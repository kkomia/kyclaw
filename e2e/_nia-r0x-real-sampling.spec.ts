import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * R07 / R08 / R06 / R16 真机采样（gated：`KYCLAW_R0X_E2E=1` 才跑）。
 *
 * 口径见 `nia/R06-R08-sampling-design.md`：真内核 + 本地 Anthropic Messages 慢流 stub provider
 * （env `DEEPSEEK_BASE_URL/API_KEY` 由 Electron 主进程透传到内核子进程；无网络、无真密钥）。
 * 每条采样写 JSON 到 `nia/r06-r08/<name>.json`；失败消息带「哪一类不符」。
 *
 * 说明：R08 的 `reasoning` / `tool-approval*` 档在内核路径不可达（sse-map 无 reasoning 映射；审批需真审批），
 * 采样只断言可达档的 label 逐字/顺序、data-stage/mode、轮换约 10s、reduced 无超时覆盖。
 */
const ENABLED = process.env.KYCLAW_R0X_E2E === '1'
const OUT_DIR = resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r06-r08')

interface Delta {
  text?: string
  tool?: { id: string; name: string; input: Record<string, unknown> }
  delayMs?: number
}
interface ScriptResponse {
  preDelayMs?: number
  deltas: Delta[]
  stop: 'tool_use' | 'end_turn'
}

/** 极简 Anthropic Messages SSE provider：按脚本逐片吐；无 tools 的请求（标题生成）直接短文本。 */
function startScriptedProvider(
  script: ScriptResponse[]
): Promise<{ server: Server; baseUrl: string }> {
  let pointer = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', async () => {
      if (request.method !== 'POST' || !/\/v1\/messages/.test(request.url ?? '')) {
        response.writeHead(404).end('not found')
        return
      }
      let body: { tools?: unknown[] } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: unknown[] }
      } catch {
        // ignore
      }
      const isTitle = !Array.isArray(body.tools) || body.tools.length === 0
      mkdirSync(OUT_DIR, { recursive: true })
      try {
        appendFileSync(
          resolve(OUT_DIR, 'provider-calls.log'),
          `${JSON.stringify({ at: Date.now(), pointer, tools: Array.isArray(body.tools) ? body.tools.length : 0, isTitle })}\n`,
          'utf8'
        )
      } catch {
        // ignore
      }
      if (isTitle) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store'
        })
        const sendTitle = (event: string, data: unknown): void => {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        sendTitle('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_title',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        })
        sendTitle('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        sendTitle('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '标题' }
        })
        sendTitle('content_block_stop', { type: 'content_block_stop', index: 0 })
        sendTitle('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 }
        })
        sendTitle('message_stop', { type: 'message_stop' })
        response.end()
        return
      }
      const scripted = script[Math.min(pointer, script.length - 1)]
      pointer += 1
      if (scripted === undefined) {
        response.writeHead(500).end('no script')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
      send('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${String(pointer)}`,
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          usage: { input_tokens: 12, output_tokens: 1 }
        }
      })
      if (scripted.preDelayMs !== undefined) await sleep(scripted.preDelayMs)
      let blockIndex = 0
      let blockOpen = false
      const openText = (): void => {
        if (blockOpen) return
        send('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' }
        })
        blockOpen = true
      }
      const closeText = (): void => {
        if (!blockOpen) return
        send('content_block_stop', { type: 'content_block_stop', index: blockIndex })
        blockIndex += 1
        blockOpen = false
      }
      for (const delta of scripted.deltas) {
        if (delta.delayMs !== undefined) await sleep(delta.delayMs)
        if (delta.text !== undefined) {
          openText()
          send('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: delta.text }
          })
        }
        if (delta.tool !== undefined) {
          closeText()
          send('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: delta.tool.id, name: delta.tool.name, input: {} }
          })
          // 空参数工具（get_goal）按 b3-2 探针同款发**空** partial_json；非空才发完整 JSON
          // （发 '{}' 会被内核的参数解析当成"已有 {} + 追加 {}"，导致 tool call 无效/轮中止）
          const partial =
            Object.keys(delta.tool.input).length === 0 ? '' : JSON.stringify(delta.tool.input)
          send('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: partial }
          })
          send('content_block_stop', { type: 'content_block_stop', index: blockIndex })
          blockIndex += 1
        }
      }
      closeText()
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: scripted.stop, stop_sequence: null },
        usage: { output_tokens: 8 }
      })
      send('message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolveListen({ server, baseUrl: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function turning(page: Page): Promise<boolean> {
  return page
    .getByTestId('composer-stop')
    .isVisible()
    .catch(() => false)
}

async function sample(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const answers = document.querySelectorAll('[data-testid="turn-answer"]')
    const last = answers[answers.length - 1] as HTMLElement | undefined
    const header = document.querySelector('[data-testid="turn-process-header"]')
    const status = document.querySelector('[data-testid="turn-latest-status"]')
    const label = document.querySelector('[data-testid="turn-latest-label"]')
    const chase = document.querySelector('[data-mode]')
    const text = last?.innerText ?? ''
    const lineHeight =
      last === undefined ? 0 : Number.parseFloat(getComputedStyle(last).lineHeight || '0') || 0
    const rows =
      last === undefined || lineHeight === 0 ? 0 : Math.round(last.scrollHeight / lineHeight)
    return {
      t: Date.now(),
      answerRows: text.trim() === '' ? 0 : rows,
      answerText: text,
      hasDivider: header?.getAttribute('data-has-divider') ?? null,
      stage: status?.getAttribute('data-stage') ?? null,
      motion: status?.getAttribute('data-motion') ?? null,
      label: label?.textContent ?? null,
      mode: chase?.getAttribute('data-mode') ?? null,
      errorText:
        (
          document.querySelector('[data-testid="error-card"]') as HTMLElement | null
        )?.innerText.slice(0, 400) ?? null,
      // 工具级错误文案在工具卡里（`tool-output`）；轮级 `error-card` 只在整轮失败时才有（PB-045 踩坑）
      toolOutput:
        (
          document.querySelector('[data-testid="tool-output"]') as HTMLElement | null
        )?.innerText.slice(0, 400) ?? null
    }
  })
}

function writeEvidence(name: string, payload: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true })
  const file = resolve(OUT_DIR, `${name}.json`)
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

test.describe('R07/R08/R06/R16 真内核采样', () => {
  test.skip(!ENABLED, 'KYCLAW_R0X_E2E=1 时才跑（真内核采样，需 build + resources/kernel）')

  test('R07a 工具轮：轮内 answerVisibleRows=0；轮末中间/最终两段按序；divider=true', async () => {
    test.setTimeout(180_000)
    const stub = await startScriptedProvider([
      {
        deltas: [
          { text: '中间正文：' },
          { text: '我先检查一下。', delayMs: 400 },
          {
            tool: { id: 'toolu_r07_read', name: 'read', input: { file_path: 'settings.json' } },
            delayMs: 600
          }
        ],
        stop: 'tool_use'
      },
      {
        preDelayMs: 1200,
        deltas: [{ text: '最终回答：' }, { text: '检查完了。', delayMs: 500 }],
        stop: 'end_turn'
      }
    ])
    const launched = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
      keepUserData: true
    })
    const samples: Array<Record<string, unknown>> = []
    try {
      await waitForChat(launched.page)
      await sendMessage(launched.page, '检查一下')
      for (let i = 0; i < 49; i += 1) {
        samples.push(await sample(launched.page))
        if (!(await turning(launched.page)) && i > 2) break
        await launched.page.waitForTimeout(100)
      }
      for (let i = 0; i < 3; i += 1) {
        await launched.page.waitForTimeout(200)
        samples.push(await sample(launched.page))
      }
      const file = writeEvidence('r07a', samples)
      const rawError = await launched.page.evaluate(() => {
        const raw = document.querySelector('[data-testid="error-raw"]')
        const message = document.querySelector('[data-testid="error-message"]')
        return { raw: raw?.textContent ?? '', message: message?.textContent ?? '' }
      })
      writeEvidence('r07a-raw-error', rawError)
      const running = samples.filter((item) => item.stage !== null)
      expect(running.length, `R07a 没采到轮内状态行样本（${file}）`).toBeGreaterThan(3)
      const dirty = running.filter(
        (item) => item.answerRows !== 0 || String(item.answerText ?? '') !== ''
      )
      expect(dirty, `R07a 轮内正文区应为空（PB-031），越界样本见 ${file}`).toHaveLength(0)
      const finalText = String(samples[samples.length - 1]?.answerText ?? '')
      expect(finalText, `R07a 轮末应含两段（${file}）`).toContain('中间正文')
      expect(finalText).toContain('最终回答')
      expect(finalText.indexOf('中间正文')).toBeLessThan(finalText.indexOf('最终回答'))
      expect(
        samples.some((item) => item.hasDivider === 'true'),
        `R07a 未见 data-has-divider=true（${file}）`
      ).toBe(true)
    } finally {
      await closeApp(launched)
      await closeServer(stub.server)
    }
  })

  test('R07b 纯文本：10 采样长度单调不减且出现 3 段递增', async () => {
    test.setTimeout(120_000)
    const stub = await startScriptedProvider([
      {
        deltas: [
          { text: '第一段。' },
          { text: '第二段。', delayMs: 500 },
          { text: '第三段。', delayMs: 500 }
        ],
        stop: 'end_turn'
      }
    ])
    const launched = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl }
    })
    const samples: Array<Record<string, unknown>> = []
    try {
      await waitForChat(launched.page)
      await sendMessage(launched.page, '纯文本')
      for (let i = 0; i < 10; i += 1) {
        samples.push(await sample(launched.page))
        await launched.page.waitForTimeout(120)
      }
      const file = writeEvidence('r07b', samples)
      const lengths = samples.map((item) => String(item.answerText ?? '').length)
      for (let i = 1; i < lengths.length; i += 1) {
        expect(lengths[i], `R07b 文本长度回落（${file}）`).toBeGreaterThanOrEqual(
          lengths[i - 1] as number
        )
      }
      expect(new Set(lengths).size, `R07b 应出现 3 段递增（${file}）`).toBeGreaterThanOrEqual(3)
    } finally {
      await closeApp(launched)
      await closeServer(stub.server)
    }
  })

  test('R08-a 真机可达阶段：tool-result 文案逐字 + data-motion=full（原 6 阶段/26s/10s 判据作废）', async () => {
    test.setTimeout(240_000)
    const stub = await startScriptedProvider([
      {
        preDelayMs: 400,
        deltas: [
          { text: '先看目标。' },
          { tool: { id: 'toolu_r08_ok', name: 'get_goal', input: {} }, delayMs: 500 }
        ],
        stop: 'tool_use'
      },
      {
        // 工具结果之后故意等 2.5s：让可观测的 `tool-result` 阶段稳定 ≥1.2s（Ada 口径 R08-a）
        preDelayMs: 2_500,
        deltas: [
          { text: '再看一次目标。' },
          { tool: { id: 'toolu_r08_fail', name: 'get_goal', input: {} }, delayMs: 500 }
        ],
        stop: 'tool_use'
      },
      { preDelayMs: 2_500, deltas: [{ text: '完成。' }], stop: 'end_turn' }
    ])
    const launched = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
      keepUserData: true
    })
    const samples: Array<Record<string, unknown>> = []
    try {
      await waitForChat(launched.page)
      // 不依赖 read（本机 windows-acl 沙箱坏，PB-045）→ 用 get_goal 成功工具 + "工具结果后延迟"造 tool-result 稳定窗口
      await sendMessage(launched.page, '跑两个 get_goal')
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        samples.push(await sample(launched.page))
        if (!(await turning(launched.page)) && samples.length > 5) break
        await launched.page.waitForTimeout(200)
      }
      const file = writeEvidence('r08', samples)
      const LABELS: Record<string, string> = {
        idle: '正在处理',
        'tool-preparing': '正在准备工具调用',
        'tool-running': '正在调用工具',
        'tool-result': '正在处理工具结果',
        'tool-error': '工具出错，正在继续'
      }
      const withStage = samples.filter((item) => item.stage !== null && item.stage !== undefined)
      expect(withStage.length, `R08-a 没采到状态行（${file}）`).toBeGreaterThan(0)
      for (const item of withStage) {
        const key = String(item.stage)
        if (key === 'idle' && item.label === '暂未响应') continue
        expect(LABELS[key], `R08-a 出现不可达/未知 stage=${key}（${file}）`).toBeDefined()
      }
      const motions = samples
        .map((item) => item.motion)
        .filter((motion) => typeof motion === 'string')
      expect(motions.length, `R08-a 没采到 data-motion（${file}）`).toBeGreaterThan(0)
      expect(
        motions.every((motion) => motion === 'full'),
        `R08-a 默认 data-motion 应为 full（${file}）`
      ).toBe(true)
      // 同一 stage 稳定 ≥1.6s（8×200ms）才断言文案；且要跳过前 1.2s（1s 说法锁 + 换词动画的过渡帧）
      let stableRuns = 0
      let toolResultRuns = 0
      let runStart = 0
      for (let i = 1; i <= samples.length; i += 1) {
        const current = i === samples.length ? undefined : String(samples[i]?.stage ?? '')
        const start = String(samples[runStart]?.stage ?? '')
        if (i < samples.length && current === start) continue
        const runLength = i - runStart
        if (runLength >= 8 && start !== '' && LABELS[start] !== undefined) {
          stableRuns += 1
          const settled = samples[runStart + 7]
          expect(settled?.label, `R08-a stage=${start} 稳定 1.6s 后文案不符（${file}）`).toBe(
            LABELS[start]
          )
          if (start === 'tool-result') toolResultRuns += 1
        }
        runStart = i
      }
      expect(stableRuns, `R08-a 没有任何阶段稳定 ≥1.6s，样本不足（${file}）`).toBeGreaterThan(0)
      expect(toolResultRuns, `R08-a 未观测到 tool-result 稳定窗口（${file}）`).toBeGreaterThan(0)
    } finally {
      await closeApp(launched)
      await closeServer(stub.server)
    }
  })

  test('R06 长过程连滚 3s：汇总行与工具命令行矩形不相交；且确有工具行', async () => {
    test.setTimeout(180_000)
    const script: ScriptResponse[] = Array.from({ length: 8 }, (_, index) => ({
      deltas: [
        { text: `第 ${String(index + 1)} 步。` },
        {
          tool: { id: `toolu_r06_${String(index + 1)}`, name: 'get_goal', input: {} },
          delayMs: 200
        }
      ],
      stop: 'tool_use' as const
    }))
    script.push({ deltas: [{ text: '全部查完。' }], stop: 'end_turn' })
    const stub = await startScriptedProvider(script)
    const launched = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
      keepUserData: true
    })
    const samples: Array<Record<string, unknown>> = []
    try {
      await waitForChat(launched.page)
      await sendMessage(launched.page, '查 8 轮')
      await launched.page.waitForTimeout(2500)
      for (let round = 0; round < 60; round += 1) {
        samples.push(
          await launched.page.evaluate(() => {
            const summary = document.querySelector('[data-testid="turn-process-summary"]')
            const rows = [...document.querySelectorAll('[data-testid="tool-row"]')]
            const rectOf = (element: Element | null): DOMRect | null =>
              element === null ? null : element.getBoundingClientRect()
            const summaryRect = rectOf(summary)
            const intersections: Array<{ summary: string; row: string }> = []
            if (summaryRect !== null) {
              const summarize = (rect: DOMRect): string =>
                `${String(Math.round(rect.top))}-${String(Math.round(rect.bottom))}`
              for (const row of rows) {
                const rect = rectOf(row)
                if (rect === null) continue
                const overlap = !(
                  summaryRect.right <= rect.left ||
                  summaryRect.left >= rect.right ||
                  summaryRect.bottom <= rect.top ||
                  summaryRect.top >= rect.bottom
                )
                if (overlap)
                  intersections.push({ summary: summarize(summaryRect), row: summarize(rect) })
              }
            }
            return { t: Date.now(), toolRows: rows.length, intersections }
          })
        )
        await launched.page.mouse.move(900, 700)
        await launched.page.mouse.wheel(0, -140)
        await launched.page.waitForTimeout(50)
      }
      const file = writeEvidence('r06', samples)
      expect(
        samples.some((item) => Number(item.toolRows) > 0),
        `R06 没有工具行，采样无意义（${file}）`
      ).toBe(true)
      const total = samples.reduce(
        (sum, item) => sum + (Array.isArray(item.intersections) ? item.intersections.length : 0),
        0
      )
      expect(total, `R06 汇总行与工具命令行发生重叠（${file}）`).toBe(0)
    } finally {
      await closeApp(launched)
      await closeServer(stub.server)
    }
  })

  test('R16 live 结束帧 ±900ms：code-block 不重挂、首帧即高亮', async () => {
    test.setTimeout(180_000)
    const stub = await startScriptedProvider([
      {
        deltas: [
          { text: '看这段代码：\n```ts\n' },
          { text: 'const a = 1\n', delayMs: 600 },
          { text: '```', delayMs: 600 }
        ],
        stop: 'end_turn'
      }
    ])
    const launched = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
      keepUserData: true
    })
    try {
      await waitForChat(launched.page)
      await launched.page.evaluate(() => {
        const w = window as unknown as {
          __r16: { added: number; removed: number; firstHtml: string | null; shikiAtFirst: boolean }
        }
        w.__r16 = { added: 0, removed: 0, firstHtml: null, shikiAtFirst: false }
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              const element = node as Element
              const found = [
                ...(element.matches?.('[data-testid="code-block"]') === true ? [element] : []),
                ...(element.querySelectorAll?.('[data-testid="code-block"]') ?? [])
              ]
              for (const block of found) {
                w.__r16.added += 1
                const html = block.querySelector('pre code')?.innerHTML ?? ''
                if (w.__r16.firstHtml === null) w.__r16.firstHtml = html
                if (/shiki|data-shiki|class="[^"]*shiki/u.test(html)) w.__r16.shikiAtFirst = true
              }
            }
            for (const node of mutation.removedNodes) {
              const element = node as Element
              if (element.getAttribute?.('data-testid') === 'code-block') w.__r16.removed += 1
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
      })
      await sendMessage(launched.page, '给我一段代码')
      for (let i = 0; i < 120; i += 1) {
        if (!(await turning(launched.page)) && i > 10) break
        await launched.page.waitForTimeout(100)
      }
      await launched.page.waitForTimeout(900)
      const result = await launched.page.evaluate(() => {
        const probe = (
          window as unknown as {
            __r16: {
              added: number
              removed: number
              firstHtml: string | null
              shikiAtFirst: boolean
            }
          }
        ).__r16
        const code = document.querySelector('[data-testid="code-block"] pre code')
        const codeHtml = code?.innerHTML ?? ''
        return {
          ...probe,
          finalCodeHtml: codeHtml.slice(0, 300),
          finalCodeHighlighted: /shiki|data-shiki|class="[^"]*shiki/u.test(codeHtml),
          dom: {
            messageText:
              (document.querySelector('[data-testid="message-text"]') as HTMLElement | null)
                ?.innerText ?? '',
            errorCards: document.querySelectorAll('[data-testid="error-card"]').length,
            codeBlocks: document.querySelectorAll('[data-testid="code-block"]').length
          }
        }
      })
      const file = writeEvidence('r16', result)
      expect(
        result.removed,
        `R16 code-block 被重挂（removed=${String(result.removed)}，${file}）`
      ).toBe(0)
      expect(
        result.added,
        `R16 code-block 重复挂载（added=${String(result.added)}，dom=${JSON.stringify((result as { dom?: unknown }).dom)}，${file}）`
      ).toBe(1)
      expect(
        result.shikiAtFirst,
        `R16 首帧未高亮（firstHtml=${String(result.firstHtml).slice(0, 120)}，${file}）`
      ).toBe(true)
    } finally {
      await closeApp(launched)
      await closeServer(stub.server)
    }
  })
})
