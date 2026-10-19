/**
 * 010（附 009 一眼实测）真机探针：**真 Electron + 真 SSE 分帧**。
 *
 * ── 验的是什么 ────────────────────────────────────────────────────────────────
 *   · 运行指示：发出消息（还没吐第一帧的 submitted 档）侧栏就画**灰色圆环**；
 *     SSE 分帧推进（streaming）仍在；**切走到别的会话**后，后台会话那一行照旧在转；
 *   · 结束：分帧收尾（[DONE]）→ 灰圈消失，人不在那条会话上 → 转成**完成点**；
 *   · 停止：跑到一半点停止 → 灰圈消失；
 *   · 失败：端点不可用（每次尝试都 500，模型层的重试也被挡回）→ 灰圈消失（错误卡出来，不是静默）；
 *   · 项目分组：走侧栏真入口建项目、在项目里开会话并发消息 → **项目分组里**同样画灰圈；
 *   · 009：设置 → 模型 →「新增」弹窗的四个输入框不再带 placeholder 说明/示例（DOM 实测 + 截图）。
 *   · 截图落在 `.superpowers/thread-run-010/`（本地证据，不入库）。
 *
 * ── 为什么要有这个文件（而不是只跑单测）─────────────────────────────────────
 *   jsdom 里钉不到两件事：① 常驻 Chat 的 status 由**真 transport**（真 HTTP/SSE）驱动，
 *   submitted → streaming → ready/error 的跳变与"每 token 不刷侧栏"要靠真链路证；
 *   ② 灰圈的颜色/布局要看真渲染（computed color = --text-tertiary 的灰）。
 *
 * ── 跑法 ─────────────────────────────────────────────────────────────────────
 *   corepack pnpm exec electron-vite build
 *   corepack pnpm exec playwright test e2e/_r96-thread-run.spec.ts
 */
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createInteractiveApp, type ProviderRequest } from './fixtures/interactive'

const EVIDENCE_DIR = resolve('.superpowers', 'thread-run-010')

/** 一条被按住的聊天流：测试逐帧推、按需收尾/掐断（真 SSE 的分帧由这里掌握） */
interface StreamControl {
  /** 推一段正文增量 */
  push: (delta: string) => void
  /** 正常收尾（finish_reason: stop + [DONE]） */
  finish: () => void
  /** 半截流上断连接（模拟失败） */
  fail: () => void
}

interface ControllableProvider {
  url: string
  /** 等下一条**聊天流**请求（标题生成/探测那类非流式请求不会消耗它） */
  nextStream: (timeoutMs?: number) => Promise<StreamControl>
  requests: ProviderRequest[]
  /** 之后的每个聊天流请求都按"端点不可用"处理（HTTP 500；模型层会重试，重试也照样失败） */
  breakStreams: () => void
  /** 恢复：聊天流请求重新按 SSE 供给 */
  healStreams: () => void
  close: () => Promise<void>
}

/**
 * 可控制的 OpenAI 兼容 SSE provider（自包含，不动公共的 interactive 夹具）：
 * 流式请求按住不立即回帧，由 `nextStream()` 交给测试逐段推；非流式（标题生成 / 探测）
 * 直接回一条 JSON —— 不能挂住主流程。
 */
async function startControllableProvider(): Promise<ControllableProvider> {
  const requests: ProviderRequest[] = []
  const queued: StreamControl[] = []
  const waiting: { resolve: (control: StreamControl) => void; timer: NodeJS.Timeout }[] = []
  let sequence = 0
  let broken = false

  const deliver = (control: StreamControl): void => {
    const waiter = waiting.shift()
    if (waiter === undefined) {
      queued.push(control)
      return
    }
    clearTimeout(waiter.timer)
    waiter.resolve(control)
  }

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'interactive-e2e' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest
    requests.push(body)

    // 非流式（标题生成 / 探测）：立刻回一条完整 JSON，绝不挂住
    if (body.stream !== true) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: `probe-json-${++sequence}`,
          object: 'chat.completion',
          created: 1,
          model: 'interactive-e2e',
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

    // "端点不可用"档：每一次尝试（含模型层自己的重试）都回 500 —— 失败一定会浮到界面上
    if (broken) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'probe provider down' } }))
      return
    }

    const id = `probe-sse-${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const alive = (): boolean => !response.destroyed && !response.writableEnded
    const frame = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
      if (!alive()) return
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'interactive-e2e', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
      )
    }
    deliver({
      push: (delta) => frame({ content: delta }),
      finish: () => {
        frame({}, 'stop')
        if (alive()) response.end('data: [DONE]\n\n')
      },
      fail: () => {
        // 半截流上断 socket：上游调用出错，渲染端应看到错误态（而不是永远在跑）
        response.destroy()
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('probe provider 没有绑到 TCP')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    nextStream: (timeoutMs = 60_000) =>
      new Promise<StreamControl>((resolveNext, reject) => {
        const existing = queued.shift()
        if (existing !== undefined) {
          resolveNext(existing)
          return
        }
        const timer = setTimeout(() => {
          reject(new Error('等不到下一条聊天流请求'))
        }, timeoutMs)
        waiting.push({ resolve: resolveNext, timer })
      }),
    breakStreams: () => {
      broken = true
    },
    healStreams: () => {
      broken = false
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: join(EVIDENCE_DIR, name) })
}

/** 侧栏那一行上的运行灰圈（当前任何会话；这些场景同一时刻至多一条在跑） */
function runSpinner(page: Page): Locator {
  return page.locator('[data-testid^="session-running-"]').first()
}

test('010：真 SSE——运行（含切走）画灰色圆环；收尾转成完成点', async () => {
  // 旧 provider 测具（OpenAI /v1/chat/completions + settings.providers）待迁移到 kernel provider（PB-047/026）
  test.skip(process.env.KYCLAW_INTERACTIVE_E2E !== '1', '旧 provider 测具待迁移（PB-047/026）：KYCLAW_INTERACTIVE_E2E=1')
  test.setTimeout(300_000)
  const provider = await startControllableProvider()
  const launched = await createInteractiveApp(provider.url)
  const { page } = launched

  try {
    await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })

    // submitted 档：请求已发出、provider 一帧还没吐 —— 就该在跑
    const waiting = provider.nextStream()
    await page.getByTestId('composer-input').fill('第一条消息')
    await page.getByTestId('composer-send').click()
    const control = await waiting

    const spinner = runSpinner(page)
    await expect(spinner).toBeVisible({ timeout: 30_000 })
    // 灰色圆环：computed color = --text-tertiary（浅色主题 #0000008c）
    const color = await spinner.evaluate((node) => getComputedStyle(node).color)
    expect(color).toMatch(/^rgba\(0, 0, 0, 0\.5/)
    // 无障碍运行说明
    await expect(spinner).toHaveAttribute('role', 'status')
    await expect(spinner).toHaveAttribute('aria-label', '正在生成回复')
    await shot(page, '01-running-submitted.png')

    // streaming 档：分帧到位，仍在跑
    control.push('第一段')
    await expect(page.getByText('第一段')).toBeVisible({ timeout: 30_000 })
    await expect(spinner).toBeVisible()
    await shot(page, '02-running-streaming.png')

    // 切走：新建会话 —— 后台那条会话的灰圈照旧在
    await page.getByTestId('new-session').click()
    await expect(spinner).toBeVisible()
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await shot(page, '03-running-after-switch.png')

    // 收尾：灰圈消失，人不在那条会话上 → 完成点出现（未读语义）
    control.finish()
    await expect(spinner).toBeHidden({ timeout: 60_000 })
    await expect(page.locator('[data-testid^="session-done-"]').first()).toBeVisible({
      timeout: 60_000
    })
    await shot(page, '04-done-dot.png')
  } finally {
    await launched.close()
    await provider.close()
  }
})

test('010：真 SSE——停止 / 失败指示消失；项目分组同样画灰圈（附 009 弹窗实测）', async () => {
  // 旧 provider 测具待迁移 + 项目分组依赖已下架 projects（PB-047/026 + PB-041）
  test.skip(process.env.KYCLAW_INTERACTIVE_E2E !== '1', '旧 provider 测具待迁移（PB-047/026）：KYCLAW_INTERACTIVE_E2E=1')
  test.setTimeout(360_000)
  const provider = await startControllableProvider()
  const launched = await createInteractiveApp(provider.url)
  const { page } = launched

  try {
    await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })

    // 停止：跑到一半点停止 → 灰圈消失
    const stopping = provider.nextStream()
    await page.getByTestId('composer-input').fill('这条会被停下')
    await page.getByTestId('composer-send').click()
    const control1 = await stopping
    control1.push('半截回答')
    await expect(page.getByText('半截回答')).toBeVisible({ timeout: 30_000 })
    const spinner = runSpinner(page)
    await expect(spinner).toBeVisible()
    await page.getByTestId('composer-stop').click()
    await expect(spinner).toBeHidden({ timeout: 60_000 })
    await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 60_000 })
    await shot(page, '05-stopped.png')

    // 失败：端点不可用（每一次尝试都 500，模型层的重试也会失败）→ 灰圈消失 + 错误卡出现
    // （不是静默）。注：试过"半截流上断 socket"——那一次界面一直停在运行态（模型层的重试回到
    // 端点、没再见帧）；如实记录为观察，不在探针里钉这种语义。这里钉的是"失败一定浮到界面上、
    // 指示随之消失"。
    provider.breakStreams()
    await page.getByTestId('composer-input').fill('这条会失败')
    await page.getByTestId('composer-send').click()
    await expect(spinner).toBeHidden({ timeout: 90_000 })
    await expect(page.getByTestId('error-card')).toBeVisible({ timeout: 60_000 })
    // 证据：这一轮失败期间端点收到的尝试次数（>1 = 模型层真重试过，重试也被 500 挡回）
    console.log(`[r96] 失败轮里端点收到的流请求次数：${String(provider.requests.length)}`)
    await shot(page, '06-failed.png')
    provider.healStreams()

    // 项目分组：走侧栏真入口建项目（空白项目 → 默认工作区下的同名子目录），
    // 建完自动进入项目下的新会话；发消息 → 项目分组里的那一行画灰圈
    await page.getByTestId('project-add').click()
    await page.getByTestId('project-create-blank').click()
    await page.getByTestId('project-name-input').fill('探针项目')
    await page.getByTestId('project-create-save').click()
    const projectGroup = page.locator('[data-testid^="project-sessions-"]')
    await expect(projectGroup.locator('[data-testid^="session-row-"]')).toHaveCount(1, {
      timeout: 60_000
    })

    const projectRun = provider.nextStream()
    await page.getByTestId('composer-input').fill('项目里的消息')
    await page.getByTestId('composer-send').click()
    const control3 = await projectRun
    control3.push('项目里在跑')
    const projectSpinner = projectGroup.locator('[data-testid^="session-running-"]')
    await expect(projectSpinner).toBeVisible({ timeout: 30_000 })
    await shot(page, '07-project-running.png')

    // 收尾：项目分组里的灰圈也撤下
    control3.finish()
    await expect(projectSpinner).toBeHidden({ timeout: 60_000 })

    // 009 实测：设置 → 模型 →「新增」——四个输入框不再带占位说明/示例；截图实际看
    await page.evaluate(() => {
      window.location.hash = '#/settings/model'
    })
    await expect(page.getByTestId('model-settings')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('model-add').click()
    await page.getByTestId('model-add-channel').click()
    await page.getByTestId('model-add-channel-preset-deepseek').click()
    const fields = await page.evaluate(() =>
      ['model-add-model', 'model-add-base-url', 'model-add-name', 'model-add-key'].map((id) => [
        id,
        document.querySelector(`[data-testid="${id}"]`)?.getAttribute('placeholder') ?? null
      ])
    )
    expect(fields).toEqual([
      ['model-add-model', null],
      ['model-add-base-url', null],
      ['model-add-name', null],
      ['model-add-key', null]
    ])
    // 等弹窗的进场动效走完再截图（中途截会拍到半透明叠加，看不出真实观感）
    await page.waitForTimeout(600)
    await shot(page, '08-model-add-dialog.png')
  } finally {
    await launched.close()
    await provider.close()
  }
})
