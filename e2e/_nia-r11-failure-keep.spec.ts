import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * R11（0.2.0 内核路径）· 失败轮数据保留链：**造一次失败轮 → 刷新 / 重开 → 数据仍在**。
 *
 * 口径（Lead 2026-10-19 定，PB-034 修后）：
 *   - **数据侧为准**：`GET /api/threads/:id/messages` → `messages.length > 0`、首条 `role=user`、
 *     正文 = 失败那轮的输入；`content.metadata.turnFailure.kind === 'error'`；
 *   - reload / 同 userData 重开后，数据断言必须仍然成立；
 *   - **UI 错误卡不在本 spec 的通过条件里**（已独立成 PB-037 派 Cyrus）；只把 UI 观测写进证据。
 *
 * 默认 skip（gated）：`KYCLAW_R11_E2E=1` 才跑。跑法：
 *   $env:KYCLAW_R11_E2E='1'; pnpm exec playwright test e2e/_nia-r11-failure-keep.spec.ts
 */
const ENABLED = process.env.KYCLAW_R11_E2E === '1'
const EVIDENCE = resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-failure-keep.json')

/** 取最近一个会话行 id（带 session-item- 前缀）→ 内核 threadId */
async function currentThreadId(page: Page): Promise<string | null> {
  const rows = page.locator('[data-testid^="session-item-"]')
  const count = await rows.count()
  if (count === 0) return null
  const testId = await rows.nth(count - 1).getAttribute('data-testid')
  return testId === null ? null : testId.replace('session-item-', '')
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

function userTextOf(message: Record<string, unknown>): string {
  const content = message.content as { parts?: unknown } | unknown[] | undefined
  const parts = Array.isArray(content) ? content : ((content as { parts?: unknown[] })?.parts ?? [])
  return (parts as Array<{ type?: string; text?: string }>)
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function failureKindOf(message: Record<string, unknown>): string | null {
  const content = message.content as { metadata?: { turnFailure?: { kind?: unknown } } } | undefined
  const kind = content?.metadata?.turnFailure?.kind
  return typeof kind === 'string' ? kind : null
}

test.describe('R11 · 失败轮数据保留（kernel stub error 场景）', () => {
  test.skip(!ENABLED, 'KYCLAW_R11_E2E=1 时才跑（R11 真机证据，需 pnpm build 的 out/ 产物）')

  test('失败轮数据 → reload / 重开 → 仍在（数据侧）；UI 错误卡只记录', async () => {
    test.setTimeout(180_000)
    const first = await launchApp({
      stub: { scenario: 'error', chunks: ['旧内容A'], chunkDelayMs: 50 },
      keepUserData: true
    })
    const evidence: Record<string, unknown> = {}
    const userDataDir = first.userDataDir
    let threadId: string | null = null
    try {
      await waitForChat(first.page)
      await sendMessage(first.page, '先别急着答')
      await expect(first.page.getByTestId('message-text').last()).toContainText('旧内容A', {
        timeout: 30_000
      })
      // UI 观测（只记录，不作通过条件；错误卡缺口见 PB-037）
      evidence.uiTurn = {
        messageCount: await first.page.getByTestId('message-text').count(),
        errorCards: await first.page.getByTestId('error-card').count()
      }
      await first.page.screenshot({
        path: resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-turn.png')
      })
      threadId = await currentThreadId(first.page)
      expect(threadId, 'R11 前置：找不到 materialize 后的会话行').not.toBeNull()
      const before = await fetchMessages(first.page, threadId as string)
      evidence.before = before

      // 链路 1：页面刷新（renderer 重挂）
      await first.page.reload()
      await waitForChat(first.page)
      await first.page.waitForTimeout(3_000)
      const afterReload = await fetchMessages(first.page, threadId as string)
      evidence.afterReload = afterReload
      evidence.afterReloadUi = {
        messageCount: await first.page.getByTestId('message-text').count(),
        errorCards: await first.page.getByTestId('error-card').count()
      }
      await first.page.screenshot({
        path: resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-after-reload.png')
      })

      // 数据侧断言（reload 后）
      assertFailureTurn(afterReload, 'reload')

      // PB-037 UI：历史失败轮渲染（正文 + 消息卡；有消息卡时 dock 不再重复错误卡）
      await expect(first.page.getByTestId('turn-failure-card')).toHaveCount(1, { timeout: 30_000 })
      await expect(first.page.getByTestId('message-bubble').first()).toContainText('先别急着答')
      await expect(first.page.getByTestId('error-card')).toHaveCount(0, { timeout: 10_000 })
      await first.page.screenshot({
        path: resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-stub-ui-after-reload.png')
      })
    } finally {
      await closeApp(first)
    }

    // 链路 2：关掉应用 → 同一个 userData 重开
    const second = await launchApp({ userDataDir, keepUserData: true })
    try {
      await waitForChat(second.page)
      await second.page.waitForTimeout(3_000)
      const afterReopen = await fetchMessages(second.page, threadId as string)
      evidence.afterReopen = afterReopen
      evidence.afterReopenUi = {
        messageCount: await second.page.getByTestId('message-text').count(),
        errorCards: await second.page.getByTestId('error-card').count()
      }
      await second.page.screenshot({
        path: resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-after-reopen.png')
      })
      assertFailureTurn(afterReopen, 'reopen')
    } finally {
      await closeApp(second)
    }

    writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  })
})

function assertFailureTurn(messages: readonly Record<string, unknown>[], stage: string): void {
  expect(messages.length, `R11 ${stage}：messages 为空（失败轮数据未投影）`).toBeGreaterThan(0)
  const firstUser = messages.find((message) => message.role === 'user')
  expect(firstUser, `R11 ${stage}：没有 user 消息`).toBeDefined()
  expect(userTextOf(firstUser as Record<string, unknown>)).toContain('先别急着答')
  const failure = messages.find((message) => failureKindOf(message) !== null)
  expect(failure, `R11 ${stage}：没有 content.metadata.turnFailure 的失败轮`).toBeDefined()
  expect(
    failureKindOf(failure as Record<string, unknown>),
    `R11 ${stage}：turnFailure.kind 不是 error`
  ).toBe('error')
}
