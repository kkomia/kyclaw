import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'
import { defaultSettings } from '../src/shared/settings'

/**
 * 0.1.3 · 013 / 014 的**真实 Electron 探针**（不进常规 e2e 闸门）：
 *
 *   pnpm build && KYCLAW_CHAT_PROBE=1 pnpm exec playwright test e2e/_r97-chat-quote-deliver.spec.ts
 *
 * 隔离实例（harness：临时 userData + 本文件自带的本地 HTTP/SSE 脚本 provider，
 * `KYCLAW_FORCE_MOCK=0`）：走真 Chat 链路、真 HTTP + SSE，不读任何真实凭据、不碰用户 profile。
 * 这里核的是**组件接线**，不是 helper：
 *
 *   013：真选中助手正文（浏览器 Selection）→ 真右键 → 菜单「引用到输入框」→
 *        **输入框里的原草稿一个字不动**，原文收成 `composer-quote-card` 附件卡（折叠态只铺摘要，
 *        点开可看 / 编辑全文）；不自动发送、焦点回到输入框。
 *        口径边界（用户已确认）：引用走**输入卡附件条**，用户可在输入框继续写批注/问题；
 *        显式发送时带的是**完整原文**（不是卡上摘要），**不是**右侧预览那种"在原文位置落编号批注"的系统。
 *
 *   014：真 SSE 多工具（write → deliver_file → read → 最终正文），deliver **不是最后一个工具调用**：
 *        - 交付卡只在最终回复末尾出现一次，不在「使用 N 个工具」过程块里；
 *        - 流式中（最终正文被 provider 按住）卡已经在最终位；放行后仍在最终正文之后；
 *        - 第二个用户回合是轮次边界：卡留在第一轮、不复制到第二轮；
 *        - `page.reload()` 走真实历史回读：卡仍只有一张、仍在第一轮最终回复之后。
 *
 *   008：真实布局 —— 流式中动作闸门关着时 `message-meta` 的 computed height 必须是 0
 *        （`h-0` 不能被子元素 min-height 撑开）；空闲后动作行出现才恢复正常高度。
 */
const enabled = process.env.KYCLAW_CHAT_PROBE === '1'
const MODEL = 'chat-probe'
const TOOL = {
  write: 'call-write-1',
  deliver: 'call-deliver-1',
  read: 'call-read-1'
} as const

const QUOTE_REPLY = '这是可以引用的回复。\n\n这是不要引用的第二段。'
const DELIVER_CONTENT = '# 交付探针\n\n第一轮交付内容。\n'

interface ProbeProvider {
  url: string
  /** 已经收到的**流式**聊天请求数（非流式标题/探测不算） */
  streamRequests: () => number
  /** 已收到的**流式**请求体（解析后的 JSON；按到达顺序）——用于断言真正发出去的载荷 */
  streamBodies: () => unknown[]
  /** 放行第一轮最终正文（deliver/read 已完成、最终正文被按住的那一档） */
  releaseFinal: () => void
  close: () => Promise<void>
}

/**
 * 自包含的 OpenAI 兼容 SSE provider。
 *  - quote：每次流式请求都回两段固定正文；
 *  - deliver：按请求里已有的 toolCallId 推进 write → deliver_file → read → 最终正文；
 *    第一轮最终正文在 `releaseFinal()` 之前**不写**，用来核"流式中卡已经在最终位"。
 * 标题生成 / 模型探测走非流式，立刻回一条 JSON，绝不挂住主流程。
 */
async function startProbeProvider(kind: 'quote' | 'deliver' | 'layout'): Promise<ProbeProvider> {
  let sequence = 0
  let streams = 0
  const bodies: unknown[] = []
  let finalCount = 0
  let finalCredit = 0
  let finalWaiter: (() => void) | null = null

  const waitFinal = (): Promise<void> => {
    if (finalCredit > 0) {
      finalCredit -= 1
      return Promise.resolve()
    }
    return new Promise<void>((done) => {
      finalWaiter = done
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
    const body = JSON.parse(raw) as { stream?: boolean }
    const id = `chat-probe-${++sequence}`

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
              message: { role: 'assistant', content: '探针会话' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
      return
    }

    streams += 1
    bodies.push(body)
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
    const finish = (): void => {
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    }
    const toolCall = (toolCallId: string, name: string, args: unknown): void => {
      frame({ role: 'assistant', content: '' })
      frame({
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          }
        ]
      })
      frame({}, 'tool_calls')
      response.end('data: [DONE]\n\n')
    }

    if (kind === 'quote') {
      frame({ role: 'assistant', content: QUOTE_REPLY })
      finish()
      return
    }
    if (kind === 'layout') {
      // 008 布局探针：流式按住，用户消息的编辑/撤回动作被闸门关掉（无动作档）
      await waitFinal()
      frame({ role: 'assistant', content: '布局探针回复。' })
      finish()
      return
    }

    // deliver 脚本：请求里出现过哪个 toolCallId 就说明上一步已经执行完。
    const stage = raw.includes(TOOL.read)
      ? 'final'
      : raw.includes(TOOL.deliver)
        ? 'read'
        : raw.includes(TOOL.write)
          ? 'deliver'
          : 'write'

    if (stage === 'write') {
      toolCall(TOOL.write, 'write', { path: 'delivered.md', content: DELIVER_CONTENT })
      return
    }
    if (stage === 'deliver') {
      toolCall(TOOL.deliver, 'deliver_file', { path: 'delivered.md', note: '探针交付' })
      return
    }
    if (stage === 'read') {
      toolCall(TOOL.read, 'read', { path: 'delivered.md' })
      return
    }

    finalCount += 1
    if (finalCount === 1) await waitFinal()
    frame({
      role: 'assistant',
      content: finalCount === 1 ? '第一轮最终说明：文件已经交付。' : '第二轮补充完成。'
    })
    finish()
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('探针 provider 没绑上端口')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    streamRequests: () => streams,
    streamBodies: () => bodies,
    releaseFinal,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

function probeSettings(providerUrl: string, workspace: string): ReturnType<typeof defaultSettings> {
  const base = defaultSettings()
  return {
    ...base,
    providers: [
      {
        id: 'chat-probe',
        type: 'openai-compatible',
        baseUrl: providerUrl,
        model: MODEL,
        isDefault: true
      }
    ],
    workspaces: [{ path: workspace, mode: 'full' }],
    defaultWorkspace: workspace,
    defaultWorkspaceInitialized: true,
    semanticRecall: { ...base.semanticRecall, enabled: false }
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

async function launchProbe(
  provider: ProbeProvider
): Promise<{ launched: Awaited<ReturnType<typeof launchApp>>; workspace: string }> {
  const workspace = mkdtempSync(join(tmpdir(), 'kyclaw-chat-probe-'))
  mkdirSync(workspace, { recursive: true })
  const launched = await launchApp({
    settings: probeSettings(provider.url, workspace),
    env: { KYCLAW_FORCE_MOCK: '0' }
  })
  return { launched, workspace }
}

/** 在页面里量一次交付卡的位置（真 DOM 顺序）：是否在最终正文之后、是否误入过程块 */
async function deliverablePlacement(page: Page): Promise<{
  afterText: boolean
  inTrace: boolean
  afterFirstUser: boolean
  beforeSecondUser: boolean
}> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-testid="deliverable-card"]')
    const users = [...document.querySelectorAll('[data-role="user"]')]
    const article = card?.closest('[data-role="assistant"]') ?? null
    const texts =
      article === null ? [] : [...article.querySelectorAll('[data-testid="message-text"]')]
    const lastText = texts[texts.length - 1]
    return {
      afterText:
        card !== null && lastText !== undefined
          ? Boolean(lastText.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false,
      inTrace: card !== null && card.closest('[data-testid="trace-block"]') !== null,
      afterFirstUser:
        card !== null && users[0] !== undefined
          ? Boolean(users[0].compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false,
      beforeSecondUser:
        card !== null && users[1] !== undefined
          ? Boolean(card.compareDocumentPosition(users[1]) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false
    }
  })
}

/** 请求体里所有字符串（消息 content 可能是纯字符串，也可能是 part 数组） */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(stringsOf)
  }
  return []
}

/**
 * 请求体里所有 **user 消息**的文本（按顺序拼接）。
 * 不能直接扫整个请求体：历史里已经有第一轮助手回复，扫全文会把"引用是否真发出去"变成假阳性。
 */
function userText(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return null
  const texts: string[] = []
  for (const message of messages) {
    if (
      message === null ||
      typeof message !== 'object' ||
      (message as { role?: unknown }).role !== 'user'
    ) {
      continue
    }
    const content = (message as { content?: unknown }).content
    const parts = (message as { parts?: unknown }).parts
    texts.push(stringsOf(content ?? parts ?? message).join('\n'))
  }
  return texts.length === 0 ? null : texts.join('\n')
}

test.describe('0.1.3 · 013 / 014 真实聊天链路', () => {
  test.skip(
    !enabled,
    'KYCLAW_CHAT_PROBE=1 时才跑（真实 Electron 探针，需 pnpm build 的 out/ 产物）'
  )
  test.setTimeout(8 * 60 * 1000)

  test('013：同一 message-text 两段真选文 → 引用进附件卡（草稿不动）；不自动发送，发送载荷含全文', async () => {
    const provider = await startProbeProvider('quote')
    const { launched, workspace } = await launchProbe(provider)
    const { page } = launched
    try {
      await waitForChat(page)
      await sendMessage(page, '请回复两段文字。')
      const article = page.locator('[data-role="assistant"]').last()
      await expect(article).toContainText('这是可以引用的回复。', { timeout: 60_000 })
      await waitForIdle(page)

      // 已有草稿：引用**不许写进输入框**，原草稿一个字都不动
      const input = page.getByTestId('composer-input')
      await input.fill('我的原草稿')

      // 真选中同一 message-text 内的**第一段到第二段**（同一个 TextPart；跨段落允许，
      // 跨不同 text part / 过程块才拒绝），再真右键点进选区
      const textPart = article.getByTestId('message-text')
      await textPart.scrollIntoViewIfNeeded()
      // 真实浏览器 Selection（与预览 e2e 同一手法；不是 helper 直接调业务函数）
      await textPart.evaluate((element) => {
        const paragraphs = element.querySelectorAll('p')
        const first = paragraphs[0]
        const last = paragraphs[paragraphs.length - 1]
        if (first === undefined || last === undefined) throw new Error('回复里没有两段正文')
        const startNode = first.firstChild ?? first
        const endNode = last.lastChild ?? last
        const range = document.createRange()
        range.setStart(startNode, 0)
        range.setEnd(endNode, endNode.textContent?.length ?? 0)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
        .toContain('这是可以引用的回复。')
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
        .toContain('这是不要引用的第二段。')
      const selectedText = (
        await page.evaluate(() => window.getSelection()?.toString() ?? '')
      ).replace(/\r\n?/g, '\n')
      const lastParagraph = textPart.locator('p').last()
      const box = await lastParagraph.boundingBox()
      if (box === null) throw new Error('选中的第二段没有布局框')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        button: 'right'
      })

      await expect(page.getByTestId('message-selection-menu')).toBeVisible({ timeout: 10_000 })
      await page.getByTestId('message-selection-menu-quote').click()

      // 新语义（013 返工）：引用收成附件卡，输入框仍只有原草稿、焦点交回输入框
      await expect(input).toHaveValue('我的原草稿')
      await expect(input).toBeFocused()
      const quoteCard = page.getByTestId('composer-quote-card')
      await expect(quoteCard).toHaveCount(1)
      await expect(quoteCard).toBeVisible()
      await expect(quoteCard).toHaveAttribute('data-quote', 'true')
      await expect(page.getByTestId('composer-quote-summary')).toContainText('这是可以引用的回复。')
      await expect(page.getByTestId('composer-quote-count')).toHaveText(
        `共 ${[...selectedText].length} 字`
      )
      await expect(page.getByTestId('composer-quote-send-mode')).toHaveText('发送含原文')
      // 折叠态不铺全文：完整原文只在展开后的编辑框与发送载荷里
      await expect(page.getByTestId('composer-quote-original')).toHaveCount(0)

      // 不自动发送：等一小段，流请求数、用户消息数、发送钮都不变
      await page.waitForTimeout(800)
      expect(provider.streamRequests()).toBe(1)
      await expect(page.locator('[data-role="user"]')).toHaveCount(1)
      await expect(page.getByTestId('composer-send')).toBeVisible()

      // 用户显式发送：载荷必须带**完整原文**（两段都在），不是卡上的摘要
      await page.getByTestId('composer-send').click()
      await expect.poll(() => provider.streamRequests(), { timeout: 60_000 }).toBe(2)
      await waitForIdle(page)
      const bodies = provider.streamBodies()
      expect(bodies.length).toBe(2)
      // 只看第二条请求里的 user 消息：历史里本就有第一轮助手回复，扫全文会假阳性
      const sentByUser = userText(bodies[bodies.length - 1])
      expect(sentByUser).not.toBeNull()
      const payload = sentByUser ?? ''
      expect(payload).toContain('我的原草稿')
      expect(payload).toContain('【引用】回复：回复选段')
      expect(payload).toContain('这是可以引用的回复。')
      expect(payload).toContain('这是不要引用的第二段。')
      expect(payload).toContain(selectedText.trim())
      await expect(page.locator('[data-role="user"]')).toHaveCount(2)
      await expect(page.getByTestId('composer-quote-card')).toHaveCount(0)
    } finally {
      await closeApp(launched)
      await provider.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('008：真实布局——无动作时时间行高度为 0，不额外垫高用户消息', async () => {
    const provider = await startProbeProvider('layout')
    const { launched, workspace } = await launchProbe(provider)
    const { page } = launched
    try {
      await waitForChat(page)
      await sendMessage(page, '布局探针')
      const article = page.locator('[data-role="user"]').last()
      await expect(article).toContainText('布局探针')

      // 流式中动作闸门关着（锁定）→ message-meta 走 h-0：真 Chromium 的 computed height 必须是 0
      await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: 30_000 })
      const busy = await article.evaluate((element) => {
        const meta = element.querySelector('[data-testid="message-meta"]')
        const sentAt = element.querySelector('[data-testid="message-sent-at"]')
        return {
          metaHeight: meta instanceof HTMLElement ? meta.getBoundingClientRect().height : -1,
          sentAtHeight: sentAt instanceof HTMLElement ? sentAt.getBoundingClientRect().height : -1
        }
      })
      expect(busy.metaHeight).toBe(0)
      expect(busy.sentAtHeight).toBeGreaterThan(0)

      provider.releaseFinal()
      await waitForIdle(page)
      // 空闲后动作行出现，这一行才占正常高度（32 热区）
      const idle = await article.evaluate((element) => {
        const meta = element.querySelector('[data-testid="message-meta"]')
        return meta instanceof HTMLElement ? meta.getBoundingClientRect().height : -1
      })
      expect(idle).toBeGreaterThan(0)
    } finally {
      await closeApp(launched)
      await provider.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('014：多工具 SSE deliver 不是最后调用 → 卡在最终回复后且一次；轮次边界 / 历史回读', async () => {
    const provider = await startProbeProvider('deliver')
    const { launched, workspace } = await launchProbe(provider)
    const { page } = launched
    try {
      await waitForChat(page)
      await sendMessage(page, '请交付 delivered.md，读一下，再告诉我结果。')

      // 流式中：最终正文被 provider 按住，交付卡已经出现在最终位（不在过程块里）
      const card = page.getByTestId('deliverable-card')
      await expect(card).toHaveCount(1, { timeout: 60_000 })
      await expect(card.first()).toBeVisible()
      expect(await card.first().getAttribute('data-path')).toBe('delivered.md')
      expect(
        await card
          .first()
          .evaluate((element) => element.closest('[data-testid="trace-block"]') === null)
      ).toBe(true)

      // 过程块只数 write + read（deliver 已从过程流里摘掉；按块求和，避免流式空正文把块切开）
      const firstArticle = page.locator('[data-role="assistant"]').last()
      await expect
        .poll(async () => {
          // 此刻只有第一轮：所有助手消息里的过程块都算（即便实现把一步拆成一条消息也不误判）
          const titles = await page
            .locator('[data-role="assistant"] [data-testid="trace-toggle"]')
            .allTextContents()
          return titles.reduce(
            (sum, title) => sum + Number(/使用 (\d+) 个工具/.exec(title)?.[1] ?? 0),
            0
          )
        })
        .toBe(2)

      // 放行最终正文：卡仍在最终正文之后、仍只有一张
      provider.releaseFinal()
      await expect(firstArticle.getByTestId('message-text').last()).toContainText(
        '第一轮最终说明：文件已经交付。',
        { timeout: 60_000 }
      )
      await waitForIdle(page)
      await expect(card).toHaveCount(1)
      expect(await deliverablePlacement(page)).toMatchObject({
        afterText: true,
        inTrace: false,
        afterFirstUser: true,
        beforeSecondUser: false
      })

      // 第二个用户回合：卡留在第一轮，不复制到第二轮
      await sendMessage(page, '再补一句。')
      const secondArticle = page.locator('[data-role="assistant"]').last()
      await expect(secondArticle.getByTestId('message-text').last()).toContainText(
        '第二轮补充完成。',
        { timeout: 60_000 }
      )
      await waitForIdle(page)
      await expect(card).toHaveCount(1)
      await expect(secondArticle.getByTestId('deliverable-card')).toHaveCount(0)
      expect(await deliverablePlacement(page)).toMatchObject({
        afterText: true,
        inTrace: false,
        afterFirstUser: true,
        beforeSecondUser: true
      })

      // 历史回读：刷新渲染端，走 message-map + 同一套整轮聚合
      // （轮末落库是异步的：给一拍再刷新，避免把"UI 已收尾、存储还没落"当成回读缺失）
      await page.waitForTimeout(1_000)
      await page.reload()
      await waitForChat(page)
      await expect(page.locator('[data-testid="message-text"]').last()).toContainText(
        '第二轮补充完成。',
        { timeout: 60_000 }
      )
      await expect(card).toHaveCount(1)
      expect(await deliverablePlacement(page)).toMatchObject({
        afterText: true,
        inTrace: false,
        afterFirstUser: true,
        beforeSecondUser: true
      })
    } finally {
      await closeApp(launched)
      await provider.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
