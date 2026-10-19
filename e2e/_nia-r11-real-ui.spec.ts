import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * R11（真内核 UI 版，gated）：**失败轮 → reload → 画面**。
 *
 * Lead 2026-10-19 口径：截图里必须同时有
 *   ① 失败轮正文（用户那轮的输入，PB-034 从 `agent/inbox/spliced` 投影回来）
 *   ② 一张 `turn-failure-card`（PB-037：消息卡优先）
 *   ③ 页脚 dock **不重复**出现错误卡（有消息卡时 dock 不显示同轮错误卡）
 * 并断言 `GET /api/threads/:id/messages`：messages=1、首条 user、`turnFailure.kind='error'`。
 *
 * 默认 skip：`KYCLAW_R11_UI_E2E=1` 才跑。需要 `pnpm build` + `resources/kernel`（真内核 rc.2）。
 * 本地 provider：标题请求正常回标题；聊天请求回 HTTP 500 → 内核本轮失败（turn/end error）。
 *
 * ⚠️ 已知现状（2026-10-19 实测，留作回归资产而不是"已绿"）：
 *   provider 失败/取消的 turn 里存在**可见 user/message**，PB-034 的投影规则只对"没有可见
 *   user/message 的失败轮"补 `content.metadata.turnFailure`，所以真内核这条路径当前**不会**出现
 *   `turn-failure-card`（只有 dock 级 ErrorCard）。stub 内核的 error 场景（没有 user/message、只有
 *   `agent/inbox/spliced`）能出现卡片，见 `_nia-r11-failure-keep.spec.ts` 的 UI 断言与
 *   `nia/r11-stub-ui-after-reload.png`。本 spec 的断言保持 Lead 口径不改；若产品决定把 turnFailure
 *   也附到可见 user/message 上，这条会自动转绿。
 */
const ENABLED = process.env.KYCLAW_R11_UI_E2E === '1'
const OUT = '.superpowers/dev-verify/20261019-0.2.0/nia'

function startFailingProvider(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      if (request.method !== 'POST' || !/\/v1\/messages/.test(request.url ?? '')) {
        response.writeHead(404).end('not found')
        return
      }
      let tools: unknown[] = []
      try {
        tools =
          (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: unknown[] }).tools ?? []
      } catch {
        // ignore
      }
      const isTitle = !Array.isArray(tools) || tools.length === 0
      if (isTitle) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store'
        })
        const send = (event: string, data: unknown): void => {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        send('message_start', {
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
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '标题' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 }
        })
        send('message_stop', { type: 'message_stop' })
        response.end()
        return
      }
      // 聊天请求：直接失败（内核会走 turn/end reason=error；PB-034 从 inbox 投影用户正文）
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { type: 'server_error', message: 'R11 UI probe: 模拟 provider 500' }
        })
      )
    })
  })
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('provider: no address')
      resolveListen({ server, baseUrl: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function threadIdOf(page: Page): Promise<string> {
  const row = page.locator('[data-testid^="session-item-"]').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  const testId = await row.getAttribute('data-testid')
  expect(testId, '会话行没有 data-testid').not.toBeNull()
  return String(testId).replace('session-item-', '')
}

async function fetchMessages(page: Page, threadId: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (id) => {
    const endpoint = await window.kyclaw.agent.endpoint()
    const response = await fetch(
      `${endpoint.baseUrl}/api/threads/${encodeURIComponent(id)}/messages`,
      {
        headers: { Authorization: `Bearer ${endpoint.token}` }
      }
    )
    if (!response.ok) throw new Error(`messages HTTP ${String(response.status)}`)
    const body = (await response.json()) as { messages?: unknown }
    return Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : []
  }, threadId)
}

function assertData(messages: readonly Record<string, unknown>[], stage: string): void {
  expect(messages.length, `R11 UI ${stage}：messages 应=1`).toBe(1)
  const first = messages[0] as Record<string, unknown>
  expect(first.role, `R11 UI ${stage}：首条应为 user`).toBe('user')
  const content = first.content as { metadata?: { turnFailure?: { kind?: unknown } } } | undefined
  expect(content?.metadata?.turnFailure?.kind, `R11 UI ${stage}：turnFailure.kind 应为 error`).toBe(
    'error'
  )
}

test.describe('R11 · 真内核 UI：失败轮 → reload', () => {
  test.skip(
    !ENABLED,
    'KYCLAW_R11_UI_E2E=1 时才跑（真内核 + 本地 provider；需 build 与 resources/kernel）'
  )

  test('画面同时有正文 + turn-failure-card，dock 不重复；数据侧同断言', async () => {
    test.setTimeout(240_000)
    const provider = await startFailingProvider()
    const launched = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: provider.baseUrl },
      keepUserData: true
    })
    const evidence: Record<string, unknown> = {}
    try {
      await waitForChat(launched.page)
      await sendMessage(launched.page, '先别急着答')
      // 失败轮：live 流里先出现 dock ErrorCard（PB-037 的 TurnFailureCard 走存储历史，reload 后才挂）
      await expect(launched.page.getByTestId('error-card')).toHaveCount(1, { timeout: 150_000 })
      const threadId = await threadIdOf(launched.page)
      const beforeReload = await fetchMessages(launched.page, threadId)
      assertData(beforeReload, 'before-reload')

      // 这次的关键画面：reload 后
      await launched.page.reload()
      await waitForChat(launched.page)
      // reload 后点回该会话（若未自动恢复）
      const row = launched.page.locator(`[data-testid="session-item-${threadId}"]`)
      if (await row.isVisible().catch(() => false)) await row.click()
      await expect(launched.page.getByTestId('message-text').first()).toContainText('先别急着答', {
        timeout: 30_000
      })
      await expect(launched.page.getByTestId('turn-failure-card')).toHaveCount(1, {
        timeout: 60_000
      })
      await expect(launched.page.getByTestId('error-card')).toHaveCount(0, { timeout: 15_000 })
      const bodyText = await launched.page.getByTestId('message-text').first().innerText()
      const dockErrorCards = await launched.page.getByTestId('error-card').count()
      expect(bodyText, 'reload 后正文丢失').toContain('先别急着答')
      expect(dockErrorCards, '有消息卡时 dock 不应再重复错误卡').toBe(0)
      await launched.page.screenshot({ path: resolve(OUT, 'r11-real-ui-after-reload.png') })

      const afterReload = await fetchMessages(launched.page, threadId)
      assertData(afterReload, 'after-reload')
      evidence.beforeReload = beforeReload
      evidence.afterReload = afterReload
      evidence.ui = {
        bodyText,
        turnFailureCards: await launched.page.getByTestId('turn-failure-card').count(),
        dockErrorCards
      }
      writeFileSync(
        resolve(OUT, 'r11-real-ui-messages.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      )
    } finally {
      await closeApp(launched)
      await closeServer(provider.server)
    }
  })
})
