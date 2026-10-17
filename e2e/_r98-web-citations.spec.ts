import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'
import { defaultSettings } from '../src/shared/settings'

/**
 * 0.1.3 网页引用 · 真实 Electron / SSE 探针（不进常规 e2e 闸门）。
 *
 *   pnpm build && KYCLAW_CHAT_PROBE=1 pnpm exec playwright test e2e/_r98-web-citations.spec.ts
 *
 * 链路是**真的**：本地 OpenAI 兼容 SSE provider → Mastra → 内置 web_search → 本地 MCP 端点
 * （Exa 文本格式）→ AI SDK 流 → 渲染端。所有服务都绑 127.0.0.1，临时 userData，不读真实凭据。
 *
 * 钉住：
 *   - 正文 `[1](url "title")` 命中**已完成 web_search 结果**才出角标；hover / focus 出
 *     host + title + snippet（snippet 来自本轮 web_search 工具结果）；
 *   - 正文里不在工具结果中的数字 URL 保持普通外链（不出角标、不进来源面板）；
 *   - 流式中来源入口 / 面板都不出现（正文引用已可见）；放行结束后只出现 icon-only 入口
 *     （`aria-label="来源（N）"`，钮上零可见文字），列表**默认折叠**，点入口才展开；
 *   - 点击角标走主进程 `shell.openExternal`（在 e2e 里替换该方法取证，不真开系统浏览器）；
 *   - `page.reload()` 走真实历史回读：角标、摘要、来源入口仍在（列表仍默认折叠，点开可回读）；
 *   - 普通 Markdown 链接保持普通链接。
 */
const enabled = process.env.KYCLAW_CHAT_PROBE === '1'
const MODEL = 'citation-probe'
const TOOL_CALL_ID = 'call-web-search-1'
const SOURCE_URL = 'https://example.org/paris'
const SOURCE_TITLE = 'Paris - Wikipedia'
const SOURCE_SNIPPET = '巴黎是法国的首都，人口约 210 万。'
const PARTIAL_REPLY = `巴黎人口约 210 万 [1](${SOURCE_URL} "${SOURCE_TITLE}")。`
const UNMATCHED_URL = 'https://evil.example/not-in-tool-results'
const FINAL_REPLY =
  `\n\n更多历史见 [1](${SOURCE_URL}#history "${SOURCE_TITLE}")。` +
  `未命中工具结果的数字链接 [9](${UNMATCHED_URL}) 只能是普通外链。` +
  '普通链接 [示例](https://example.org/about) 仍然可点。'

interface ChatProbeProvider {
  url: string
  releaseFinal: () => void
  close: () => Promise<void>
}

/**
 * 自包含的 OpenAI 兼容 SSE provider：
 *   第一次流式请求 → `web_search` 工具调用（Mastra 会真的执行本地 MCP 搜索）；
 *   拿到工具结果后的第一次流式请求 → 先推带引用的正文，**按住**流（测流式中面板隐藏），
 *   `releaseFinal()` 后补完后半段并结束。
 */
async function startChatProbe(): Promise<ChatProbeProvider> {
  let sequence = 0
  let finalCredit = 0
  let finalWaiter: (() => void) | null = null
  let finalRequests = 0

  const waitFinal = (): Promise<void> => {
    if (finalCredit > 0) {
      finalCredit -= 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      finalWaiter = resolve
    })
  }
  const releaseFinal = (): void => {
    const waiter = finalWaiter
    if (waiter !== null) {
      finalWaiter = null
      waiter()
      return
    }
    finalCredit += 1
  }

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models') === true) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL }] }))
      return
    }
    if (request.method !== 'POST' || request.url?.startsWith('/v1/chat/completions') !== true) {
      response.writeHead(404).end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: { stream?: boolean }
    try {
      body = JSON.parse(raw) as { stream?: boolean }
    } catch {
      response.writeHead(400).end()
      return
    }
    const id = `citation-probe-${++sequence}`

    if (body.stream !== true) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: 1,
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '引用探针会话' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
      return
    }

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frame = (delta: unknown, finish: string | null = null): void => {
      response.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }]
        })}\n\n`
      )
    }
    const finishStream = (): void => {
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    }

    // 工具结果已经回到模型请求里：这是最终回答那一步
    if (raw.includes(TOOL_CALL_ID)) {
      finalRequests += 1
      if (finalRequests > 1) {
        frame({ role: 'assistant', content: '补充完成。' })
        finishStream()
        return
      }
      frame({ role: 'assistant', content: PARTIAL_REPLY })
      await waitFinal()
      frame({ role: 'assistant', content: FINAL_REPLY })
      finishStream()
      return
    }

    frame({ role: 'assistant', content: '' })
    frame({
      tool_calls: [
        {
          index: 0,
          id: TOOL_CALL_ID,
          type: 'function',
          function: {
            name: 'web_search',
            arguments: JSON.stringify({ query: '巴黎人口', numResults: 3 })
          }
        }
      ]
    })
    frame({}, 'tool_calls')
    response.end('data: [DONE]\n\n')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('引用探针 provider 没绑上端口')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    releaseFinal,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

interface McpProbe {
  url: string
  close: () => Promise<void>
}

/** 本地 MCP 端点：initialize / notifications/initialized / tools/call，返回 Exa 文本块 */
async function startMcpProbe(): Promise<McpProbe> {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    let body: Record<string, unknown>
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      response.writeHead(400).end()
      return
    }

    if (body.method === 'initialize') {
      response.setHeader('content-type', 'application/json')
      response.setHeader('mcp-session-id', 'citation-probe-session')
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 1,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'citation-probe', version: '1.0.0' }
          }
        })
      )
      return
    }
    if (body.method === 'notifications/initialized') {
      response.writeHead(202).end()
      return
    }
    if (body.method === 'tools/call') {
      const text = [
        `Title: ${SOURCE_TITLE}`,
        `URL: ${SOURCE_URL}`,
        'Published: 2026-10-01',
        'Highlights:',
        SOURCE_SNIPPET
      ].join('\n')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 1,
          result: { content: [{ type: 'text', text }] }
        })
      )
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: {} }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('引用探针 MCP 没绑上端口')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

function probeSettings(
  providerUrl: string,
  workspace: string,
  mcpUrl: string
): ReturnType<typeof defaultSettings> {
  const base = defaultSettings()
  return {
    ...base,
    providers: [
      {
        id: 'citation-probe',
        type: 'openai-compatible',
        baseUrl: providerUrl,
        model: MODEL,
        isDefault: true
      }
    ],
    workspaces: [{ path: workspace, mode: 'full' }],
    defaultWorkspace: workspace,
    defaultWorkspaceInitialized: true,
    semanticRecall: { ...base.semanticRecall, enabled: false },
    webSearch: {
      mode: 'free',
      provider: 'exa',
      exaEndpoint: mcpUrl,
      readerEndpoint: 'https://r.jina.ai'
    }
  }
}

async function waitForIdle(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const stopVisible = await page
          .getByTestId('composer-stop')
          .isVisible()
          .catch(() => false)
        if (stopVisible) return 'busy'
        const sendVisible = await page
          .getByTestId('composer-send')
          .isVisible()
          .catch(() => false)
        return sendVisible ? 'idle' : 'pending'
      },
      { timeout: 60_000 }
    )
    .toBe('idle')
}

test.describe('0.1.3 · 网页引用真实链路', () => {
  test.skip(
    !enabled,
    'KYCLAW_CHAT_PROBE=1 时才跑（真实 Electron 探针，需 pnpm build 的 out/ 产物）'
  )
  test.setTimeout(8 * 60 * 1000)

  test('web_search → 正文角标 / hover 摘要 / 外链 / 来源入口（默认折叠）/ 历史回读', async () => {
    const provider = await startChatProbe()
    const mcp = await startMcpProbe()
    const workspace = mkdtempSync(join(tmpdir(), 'kyclaw-citation-probe-'))
    mkdirSync(workspace, { recursive: true })
    const launched = await launchApp({
      settings: probeSettings(provider.url, workspace, mcp.url),
      env: { KYCLAW_FORCE_MOCK: '0' }
    })
    const { app, page } = launched

    try {
      await waitForChat(page)
      await sendMessage(page, '巴黎人口多少？请查一下。')

      const article = page.locator('[data-role="assistant"]').last()
      const chip = article.getByTestId('citation-chip').first()
      await expect(chip).toBeVisible({ timeout: 60_000 })
      await expect(chip).toHaveAttribute('href', SOURCE_URL)
      await expect(chip).toHaveAttribute('target', '_blank')
      await expect(article.getByTestId('message-text').last()).toContainText('巴黎人口约 210 万')

      // 流式还没结束：角标已在正文里，来源入口 / 面板都必须还没出现
      await expect(article.getByTestId('sources-toggle')).toHaveCount(0)
      await expect(article.getByTestId('sources-panel')).toHaveCount(0)

      // hover：host / title / snippet（snippet 来自同一条消息的 web_search 工具结果）
      await chip.hover()
      const card = page.getByTestId('citation-card')
      await expect(card).toBeVisible({ timeout: 10_000 })
      await expect(card).toContainText(SOURCE_TITLE)
      await expect(card).toContainText('example.org')
      await expect(card).toContainText(SOURCE_SNIPPET)

      // 键盘 focus 出卡，Escape 收起
      await chip.focus()
      await expect(card).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('citation-card')).toHaveCount(0)

      // 放行最终正文：来源入口出现（icon-only，默认折叠）；同一 URL 的 fragment 变体只算一条来源
      provider.releaseFinal()
      await expect(article.getByTestId('message-text').last()).toContainText('更多历史', {
        timeout: 60_000
      })
      await waitForIdle(page)
      const sourcesToggle = article.getByTestId('sources-toggle')
      await expect(sourcesToggle).toBeVisible()
      // 新语义（0.1.3 返工）：钮上零可见文字，语义只在 aria-label / title 里，且不出现「引用」
      await expect(sourcesToggle).toHaveAttribute('aria-label', '来源（1）')
      await expect(sourcesToggle).toHaveAttribute('title', '来源（1）')
      await expect(sourcesToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(sourcesToggle).toHaveText('')
      await expect(sourcesToggle.locator('svg')).toHaveCount(1)
      // 默认折叠：列表整段不渲染；旧的可见文字「来源 · 1」不存在
      await expect(article.getByTestId('sources-panel')).toHaveCount(0)
      await expect(article.getByText('来源 · 1')).toHaveCount(0)
      await expect(article.getByText('引用', { exact: true })).toHaveCount(0)
      await expect(article.getByTestId('citation-chip')).toHaveCount(2)

      // P0 provenance：正文里不在工具结果里的数字 URL 只能是普通外链
      const unmatched = article.getByRole('link', { name: '9' })
      await expect(unmatched).toBeVisible()
      await expect(unmatched).toHaveAttribute('href', UNMATCHED_URL)
      await expect(unmatched).not.toHaveAttribute('data-testid', 'citation-chip')

      // 命中区至少 24×24
      const chipBox = await article.getByTestId('citation-chip').first().boundingBox()
      expect(chipBox?.width ?? 0).toBeGreaterThanOrEqual(24)
      expect(chipBox?.height ?? 0).toBeGreaterThanOrEqual(24)

      // 窗口失焦收起摘要卡
      await article.getByTestId('citation-chip').first().focus()
      await expect(card).toBeVisible()
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await expect(card).toHaveCount(0)

      // 普通 Markdown 链接仍是普通链接
      const normal = article.getByRole('link', { name: '示例' })
      await expect(normal).toBeVisible()
      await expect(normal).toHaveAttribute('href', 'https://example.org/about')
      await expect(normal).not.toHaveAttribute('data-testid', 'citation-chip')

      // 点开入口才展开列表：一条来源，链接到首次出现的正文 URL
      await sourcesToggle.click()
      await expect(article.getByTestId('sources-panel')).toBeVisible()
      await expect(sourcesToggle).toHaveAttribute('aria-expanded', 'true')
      const items = article.getByTestId('source-item')
      await expect(items).toHaveCount(1)
      const sourceLink = items.first().getByTestId('source-link')
      await expect(sourceLink).toHaveAttribute('href', SOURCE_URL)
      await expect(sourceLink).toContainText(SOURCE_TITLE)
      // 受控列表不会在面板里重复渲染入口：动作行仍只有一枚
      await expect(article.getByTestId('sources-toggle')).toHaveCount(1)
      // 位置：入口在动作行（与复制 / 重新生成同一排），列表在动作行上方、正文之后；
      // 动作行顺序固定为 复制 → 重新生成 → 单竖线 → 来源（用户复验口径：入口在最后）
      expect(
        await article.evaluate((element) => {
          const toggle = element.querySelector('[data-testid="sources-toggle"]')
          const actions = element.querySelector('[data-testid="message-actions"]')
          const panel = element.querySelector('[data-testid="sources-panel"]')
          const texts = [...element.querySelectorAll('[data-testid="message-text"]')]
          const lastText = texts[texts.length - 1]
          return {
            toggleInActions: toggle !== null && actions !== null && actions.contains(toggle),
            actionOrder:
              actions === null
                ? []
                : [...actions.children].map((child) => child.getAttribute('data-testid')),
            panelBeforeActions:
              panel !== null &&
              actions !== null &&
              Boolean(panel.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING),
            panelAfterText:
              panel !== null &&
              lastText !== undefined &&
              Boolean(lastText.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)
          }
        })
      ).toEqual({
        toggleInActions: true,
        actionOrder: [
          'message-copy',
          'message-regenerate',
          'message-actions-divider',
          'sources-toggle'
        ],
        panelBeforeActions: true,
        panelAfterText: true
      })

      // 点击角标 → 主进程 shell.openExternal（替换实现取证，不真开系统浏览器）
      await app.evaluate(({ shell }) => {
        const target = shell as unknown as {
          __opened: string[]
          openExternal: (url: string) => Promise<void>
        }
        target.__opened = []
        target.openExternal = async (url: string): Promise<void> => {
          target.__opened.push(url)
        }
      })
      await article.getByTestId('citation-chip').first().click()
      await expect
        .poll(() =>
          app.evaluate(({ shell }) => {
            const target = shell as unknown as { __opened?: string[] }
            return (target.__opened ?? []).slice()
          })
        )
        .toContain(SOURCE_URL)

      // 历史回读：刷新渲染端，正文 / 工具结果都从存储还原
      await page.waitForTimeout(1_000)
      await page.reload()
      await waitForChat(page)

      const reloaded = page.locator('[data-role="assistant"]').last()
      await expect(reloaded.getByTestId('message-text').last()).toContainText('更多历史', {
        timeout: 60_000
      })
      await expect(reloaded.getByTestId('citation-chip')).toHaveCount(2)
      const reloadedToggle = reloaded.getByTestId('sources-toggle')
      await expect(reloadedToggle).toBeVisible()
      // 回读后入口仍是 icon-only、aria-label 带条数
      await expect(reloadedToggle).toHaveAttribute('aria-label', '来源（1）')
      await expect(reloadedToggle).toHaveText('')
      // 回读后仍默认折叠：先点入口，再断言列表
      await expect(reloaded.getByTestId('sources-panel')).toHaveCount(0)
      await expect(reloaded.getByText('来源 · 1')).toHaveCount(0)
      await expect(reloaded.getByRole('link', { name: '9' })).toHaveAttribute('href', UNMATCHED_URL)

      await reloadedToggle.click()
      await expect(reloaded.getByTestId('sources-panel')).toBeVisible()
      await expect(reloaded.getByTestId('source-item')).toHaveCount(1)
      await reloaded.getByTestId('citation-chip').first().focus()
      await expect(page.getByTestId('citation-card')).toContainText(SOURCE_SNIPPET)
    } finally {
      await closeApp(launched)
      await provider.close()
      await mcp.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
