import { createServer, type Server } from 'node:http'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * S11 / PB-047 回归资产（gated：`KYCLAW_RESTART_E2E=1`）：**跨进程重启**（closeApp → 同 userData 重开）。
 *
 * 与同进程 `page.reload` 分开验（reload 不能替代重启；PB-047 就是被 reload 绿骗过去的）。
 *   A) 成功轮：messages 与重开前一致、UI 正文 hydrate；
 *      写路径：重开后第一条消息不新造 thread session；
 *   B) 失败轮：messages=1/user + `turnFailure.kind=error` + 正文 + **一张**失败提示（不重复）——
 *      同时是 PB-037 的条件项。
 * 目录口径（Lead 2026-10-19 定）：
 *   - thread 自己的 session 目录必须还在（名字=threadId）；
 *   - 每次**启动**允许新增 1 个空白 default `session-*`（`kernel-adapter.ts:597` 的预期行为，≤1KB），
 *     复验里单独记录其名字+大小；**其余新增一律失败**；
 *   - 写路径（重开后第一条消息）不得再新增任何目录。
 */
const ENABLED = process.env.KYCLAW_RESTART_E2E === '1'
const OUT = '.superpowers/dev-verify/20261019-0.2.0/nia'

/** fail=false：标题+正文正常；fail=true：聊天请求 500（失败轮）。 */
function providerFor(fail: boolean): Promise<{ server: Server; baseUrl: string }> {
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
      if (fail && !isTitle) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { type: 'server_error', message: 'R11 reopen verify: provider 500' }
          })
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg',
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
        delta: { type: 'text_delta', text: isTitle ? '标题' : '成功回答。' }
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 }
      })
      send('message_stop', { type: 'message_stop' })
      response.end()
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

async function threadIdOf(page: Page): Promise<string> {
  const row = page.locator('[data-testid^="session-item-"]').first()
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  return String(await row.getAttribute('data-testid')).replace('session-item-', '')
}

/** 数 `dsh-home/sessions/**` 里真正落盘的会话目录（含 session.v4.jsonl.zstd 的目录）。 */
function sessionDirNames(userDataDir: string): string[] {
  return sessionDirInfo(userDataDir).map((item) => item.name)
}

interface SessionDirInfo {
  name: string
  size: number
}

/** 会话目录 + 日志大小（用于区分 thread session 和启动时那个空白 default session）。 */
function sessionDirInfo(userDataDir: string): SessionDirInfo[] {
  const root = join(userDataDir, 'dsh-home', 'sessions')
  const infos: SessionDirInfo[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('session.v4.jsonl.zstd')) {
      try {
        infos.push({
          name: dir.split(/[\\/]/).pop() ?? dir,
          size: statSync(join(dir, 'session.v4.jsonl.zstd')).size
        })
      } catch {
        // ignore
      }
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      try {
        if (statSync(full).isDirectory()) walk(full)
      } catch {
        // ignore
      }
    }
  }
  walk(root)
  return infos.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 每次**启动**允许新增 1 个空白 default session（`session-*`、≤1KB，`kernel-adapter.ts:597` 预期行为）。
 * 返回 { allowed, extra }；extra 非空 = 失败（除 thread 目录外的其它新增）。
 */
function classifyNewSessionDirs(
  before: readonly SessionDirInfo[],
  after: readonly SessionDirInfo[],
  threadId: string
): { blankDefault: SessionDirInfo | null; extra: SessionDirInfo[] } {
  const beforeNames = new Set(before.map((item) => item.name))
  const added = after.filter((item) => !beforeNames.has(item.name) && item.name !== threadId)
  const blank = added.find((item) => item.name.startsWith('session-') && item.size <= 1024) ?? null
  const extra = added.filter((item) => item !== blank)
  return { blankDefault: blank, extra }
}

function countSessionDirs(userDataDir: string): number {
  return sessionDirNames(userDataDir).length
}

/** 重开后 UI 历史是异步 hydrate 的：等气泡/正文出现再采样，避免"截图有、locator 还没有"的竞态。 */
async function waitForHistoryUi(page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bubbles = await page.locator('[data-testid="message-bubble"]').count()
    const texts = await page.locator('[data-testid="message-text"]').count()
    if (bubbles > 0 || texts > 0) return
    await page.waitForTimeout(300)
  }
}

async function getJson(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (target) => {
    const endpoint = await window.kyclaw.agent.endpoint()
    const response = await fetch(`${endpoint.baseUrl}${target}`, {
      headers: { Authorization: `Bearer ${endpoint.token}` }
    })
    return { status: response.status, body: await response.json() }
  }, path)
}

async function uiState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => ({
    bubbles: [...document.querySelectorAll('[data-testid="message-bubble"]')].map(
      (node) => (node as HTMLElement).innerText
    ),
    texts: [...document.querySelectorAll('[data-testid="message-text"]')].map(
      (node) => (node as HTMLElement).innerText
    ),
    turnFailureCards: document.querySelectorAll('[data-testid="turn-failure-card"]').length,
    errorCards: document.querySelectorAll('[data-testid="error-card"]').length
  }))
}

test.describe('S11 跨进程重启（成功/失败/写路径；PB-047）', () => {
  test.skip(
    !ENABLED,
    'KYCLAW_RESTART_E2E=1 时才跑（真内核 + 本地 provider；需 build 与 resources/kernel）'
  )

  test('A 成功轮 → 关窗重开 → messages/正文仍在', async () => {
    test.setTimeout(240_000)
    const provider = await providerFor(false)
    const first = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: provider.baseUrl },
      keepUserData: true
    })
    const userDataDir = first.userDataDir
    let threadId = ''
    const before: Record<string, unknown> = {}
    try {
      await waitForChat(first.page)
      await sendMessage(first.page, '成功对话')
      await expect(first.page.getByTestId('message-text').last()).toContainText('成功回答', {
        timeout: 60_000
      })
      threadId = await threadIdOf(first.page)
      before.messages = await getJson(
        first.page,
        `/api/threads/${encodeURIComponent(threadId)}/messages`
      )
      before.ui = await uiState(first.page)
      // 标题会话等首启副作用可能在发消息后几秒才落盘：等 2s 再取快照，避免把首启的创建误算到 reopen 头上
      await first.page.waitForTimeout(2_000)
      before.sessionDirs = countSessionDirs(userDataDir)
      before.sessionDirNames = sessionDirNames(userDataDir)
      before.sessionDirInfo = sessionDirInfo(userDataDir)
      before.threads = await getJson(first.page, '/api/threads')
    } finally {
      await closeApp(first)
    }
    const second = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: provider.baseUrl },
      userDataDir,
      keepUserData: true
    })
    const after: Record<string, unknown> = {}
    try {
      await waitForChat(second.page)
      const row = second.page.locator(`[data-testid="session-item-${threadId}"]`)
      if (await row.isVisible().catch(() => false)) await row.click()
      await waitForHistoryUi(second.page)
      after.messages = await getJson(
        second.page,
        `/api/threads/${encodeURIComponent(threadId)}/messages`
      )
      after.ui = await uiState(second.page)
      after.sessionDirs = countSessionDirs(userDataDir)
      after.sessionDirNames = sessionDirNames(userDataDir)
      after.sessionDirInfo = sessionDirInfo(userDataDir)
      after.threads = await getJson(second.page, '/api/threads')
      after.row = {
        expected: `session-item-${threadId}`,
        testIds: await second.page
          .locator('[data-testid^="session-item-"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
      }
      await second.page.screenshot({ path: resolve(OUT, 'r11-verify-success-after.png') })
      writeFileSync(
        resolve(OUT, 'r11-reopen-verify-success.json'),
        `${JSON.stringify({ before, after }, null, 2)}\n`,
        'utf8'
      )
      const count = ((after.messages as { body?: { messages?: unknown[] } }).body?.messages ?? [])
        .length
      expect(count, 'PB-047：成功轮重开后 messages 为空（历史读不回）').toBeGreaterThan(1)
      expect(String((after.ui as { texts?: string[] }).texts?.join('\n') ?? '')).toContain(
        '成功回答'
      )
      const classified = classifyNewSessionDirs(
        before.sessionDirInfo as SessionDirInfo[],
        after.sessionDirInfo as SessionDirInfo[],
        threadId
      )
      // 每次启动允许新增 1 个空白 default session（session-*、≤1KB）；其余新增一律失败。
      expect(after.sessionDirNames, 'PB-047：thread 的 session 目录在重启后消失').toContain(
        threadId
      )
      expect(
        classified.extra,
        `PB-047：重启后新造了非 default 会话目录：${classified.extra.map((item) => item.name).join(',')}`
      ).toEqual([])
      after.blankDefaultOnReopen = classified.blankDefault

      // 写路径：重开后第一次发消息，确认不会新造会话（目录名集合不再变化）
      await sendMessage(second.page, '重开后第一条')
      await expect(second.page.getByTestId('message-text').last()).toContainText('成功回答', {
        timeout: 60_000
      })
      await second.page.waitForTimeout(1_500)
      after.afterWriteSessionDirs = countSessionDirs(userDataDir)
      after.afterWriteSessionDirNames = sessionDirNames(userDataDir)
      after.afterWriteThreads = await getJson(second.page, '/api/threads')
      expect(
        (after.afterWriteSessionDirNames as string[]).filter(
          (name) => !(after.sessionDirNames as string[]).includes(name)
        ),
        'PB-047：重开后写消息新造了会话目录'
      ).toEqual([])
    } finally {
      await closeApp(second)
      await new Promise<void>((done) => provider.server.close(() => done()))
    }
    writeFileSync(
      resolve(OUT, 'r11-reopen-verify-success.json'),
      `${JSON.stringify({ before, after }, null, 2)}\n`,
      'utf8'
    )
  })

  test('B 失败轮 → 关窗重开 → 正文 + turnFailure + 一张提示（PB-037 条件项）', async () => {
    test.setTimeout(240_000)
    const provider = await providerFor(true)
    const first = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: provider.baseUrl },
      keepUserData: true
    })
    const userDataDir = first.userDataDir
    let threadId = ''
    const before: Record<string, unknown> = {}
    try {
      await waitForChat(first.page)
      await sendMessage(first.page, '先别急着答')
      await expect(first.page.getByTestId('error-card')).toHaveCount(1, { timeout: 150_000 })
      threadId = await threadIdOf(first.page)
      before.messages = await getJson(
        first.page,
        `/api/threads/${encodeURIComponent(threadId)}/messages`
      )
      before.ui = await uiState(first.page)
      await first.page.waitForTimeout(2_000)
      before.sessionDirs = countSessionDirs(userDataDir)
      before.sessionDirNames = sessionDirNames(userDataDir)
      before.sessionDirInfo = sessionDirInfo(userDataDir)
      before.threads = await getJson(first.page, '/api/threads')
    } finally {
      await closeApp(first)
    }
    const second = await launchApp({
      kernel: 'real',
      env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: provider.baseUrl },
      userDataDir,
      keepUserData: true
    })
    const after: Record<string, unknown> = {}
    try {
      await waitForChat(second.page)
      const row = second.page.locator(`[data-testid="session-item-${threadId}"]`)
      if (await row.isVisible().catch(() => false)) await row.click()
      await waitForHistoryUi(second.page)
      after.messages = await getJson(
        second.page,
        `/api/threads/${encodeURIComponent(threadId)}/messages`
      )
      after.ui = await uiState(second.page)
      after.sessionDirs = countSessionDirs(userDataDir)
      after.sessionDirNames = sessionDirNames(userDataDir)
      after.sessionDirInfo = sessionDirInfo(userDataDir)
      after.threads = await getJson(second.page, '/api/threads')
      await second.page.screenshot({ path: resolve(OUT, 'r11-verify-failure-after.png') })
      writeFileSync(
        resolve(OUT, 'r11-reopen-verify-failure.json'),
        `${JSON.stringify({ before, after }, null, 2)}\n`,
        'utf8'
      )

      const messages =
        (after.messages as { body?: { messages?: Array<Record<string, unknown>> } }).body
          ?.messages ?? []
      expect(messages.length, 'PB-047：失败轮重开后 messages 为空').toBe(1)
      expect(messages[0]?.role, 'PB-047：首条应为 user').toBe('user')
      expect(after.sessionDirNames, 'PB-047：thread 的 session 目录在重启后消失').toContain(
        threadId
      )
      const classified = classifyNewSessionDirs(
        before.sessionDirInfo as SessionDirInfo[],
        after.sessionDirInfo as SessionDirInfo[],
        threadId
      )
      expect(
        classified.extra,
        `PB-047：重启后新造了非 default 会话目录：${classified.extra.map((item) => item.name).join(',')}`
      ).toEqual([])
      after.blankDefaultOnReopen = classified.blankDefault
      const content = messages[0]?.content as
        { metadata?: { turnFailure?: { kind?: unknown } } } | undefined
      expect(content?.metadata?.turnFailure?.kind, 'PB-037：失败轮 turnFailure 未投影').toBe(
        'error'
      )

      const ui = after.ui as { bubbles?: string[]; turnFailureCards?: number; errorCards?: number }
      expect(String(ui.bubbles?.join('\n') ?? ''), '失败轮正文丢失').toContain('先别急着答')
      const prompts = Number(ui.turnFailureCards ?? 0) + Number(ui.errorCards ?? 0)
      expect(prompts, '失败提示应恰好 1 张（turn-failure-card 或 dock 卡，不重复）').toBe(1)
    } finally {
      await closeApp(second)
      await new Promise<void>((done) => provider.server.close(() => done()))
    }
    writeFileSync(
      resolve(OUT, 'r11-reopen-verify-failure.json'),
      `${JSON.stringify({ before, after }, null, 2)}\n`,
      'utf8'
    )
  })
})
