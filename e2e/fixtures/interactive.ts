import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { defaultSettings } from '../../src/shared/settings'
import type { KyclawApi } from '../../src/shared/ipc'

declare global {
  interface Window {
    kyclaw: KyclawApi
  }
}

export const INTERACTIVE_EVIDENCE = resolve('.superpowers/interactive-acceptance')
export interface ProviderRequest {
  messages: Array<{ role: string; content: unknown }>
  stream?: boolean
  tools?: Array<{ function: { name: string } }>
}
interface Reply {
  tool?: string
  input?: unknown
  text?: string
  /** 帧发完**不结束响应**（round 81 截图探针要截"运行中"那一档；正常用例不给这一位） */
  hang?: boolean
}

export async function startInteractiveProvider(): Promise<{
  url: string
  requests: ProviderRequest[]
  enqueue: (...replies: Reply[]) => void
  close: () => Promise<void>
}> {
  const requests: ProviderRequest[] = []
  const queue: Reply[] = []
  let sequence = 0
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
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest
      requests.push(body)
      // Provider probes and title generation must not consume the scripted chat steps.
      const reply = body.stream
        ? (queue.shift() ?? { text: 'INTERACTIVE_DONE' })
        : { text: '测试会话' }
      const input = typeof reply.input === 'function' ? await reply.input() : reply.input
      if (reply.tool && !body.tools?.some((tool) => tool.function.name === reply.tool)) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { message: `Expected production tool unavailable: ${reply.tool}` }
          })
        )
        return
      }
      const id = `interactive-${++sequence}`
      const toolCalls = reply.tool
        ? [
            {
              index: 0,
              id: `call-${sequence}`,
              type: 'function',
              function: { name: reply.tool, arguments: JSON.stringify(input) }
            }
          ]
        : undefined
      if (!body.stream) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 1,
            model: 'interactive-e2e',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: reply.text },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (delta: unknown, finish: string | null): void => {
        response.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'interactive-e2e', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      }
      frame(
        { role: 'assistant', ...(toolCalls ? { tool_calls: toolCalls } : { content: reply.text }) },
        null
      )
      frame({}, toolCalls ? 'tool_calls' : 'stop')
      // `hang`（round 81 截图探针）：帧发完**不结束响应** —— 渲染端停在"运行中"（流式），
      // 用来截运行态；不给这一位就照旧 [DONE] 收尾（既有用例逐字不变）。
      if (reply.hang !== true) response.end('data: [DONE]\n\n')
    } catch {
      response.writeHead(500).end('interactive provider failed')
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Provider did not bind TCP')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    enqueue: (...replies) => queue.push(...replies),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

export async function createInteractiveApp(baseUrl: string): Promise<{
  readonly page: Page
  /** 真 Electron 实例：窄窗用例要在 Electron 侧改窗口几何（`BrowserWindow.setBounds`） */
  readonly app: ElectronApplication
  workspace: string
  restart: () => Promise<void>
  close: () => Promise<void>
}> {
  const root = mkdtempSync(join(tmpdir(), 'kyclaw-interactive-'))
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
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings))
  const main = resolve('out/main/index.js')
  const bootstrap = join(root, 'bootstrap.cjs')
  writeFileSync(
    bootstrap,
    `const { app } = require('electron'); app.setPath('home', ${JSON.stringify(home)}); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(main)});`
  )
  const env: Record<string, string | undefined> = { ...process.env, KYCLAW_FORCE_MOCK: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  let page: Page
  const launch = async (): Promise<void> => {
    app = await electron.launch({
      args: [bootstrap, `--user-data-dir=${profile}`],
      cwd: resolve('.'),
      env: env as Record<string, string>
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!window.kyclaw?.settings)
    await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })
  }
  try {
    await launch()
    await page!.evaluate(async (url) => {
      if (!window.kyclaw) throw new Error('Missing production bridge')
      await window.kyclaw.settings.update({
        providers: [
          {
            id: 'interactive',
            type: 'openai-compatible',
            baseUrl: url,
            model: 'interactive-e2e',
            isDefault: true
          }
        ]
      })
      await window.kyclaw.settings.setProviderKey(
        'interactive',
        'sk-interactive-e2e-dummy-not-a-real-key'
      )
    }, baseUrl)
  } catch (error) {
    await app?.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  return {
    get page() {
      return page!
    },
    get app() {
      if (!app) throw new Error('Interactive app was not launched')
      return app
    },
    workspace,
    restart: async () => {
      await app?.close()
      await launch()
    },
    close: async () => {
      try {
        await app?.close()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}

export async function functionEvidence(page: Page, filename: string): Promise<void> {
  mkdirSync(INTERACTIVE_EVIDENCE, { recursive: true })
  await page.screenshot({ path: join(INTERACTIVE_EVIDENCE, filename), fullPage: true })
}
