// @vitest-environment node
/**
 * 0.2.2 模型桥（真内核，**默认跳过**）：不设任何 `DEEPSEEK_API_KEY` 环境变量，
 * 走「kyclaw 设置 providers + 密钥 → `syncKernelModel` → 内核 settings/credentials」这条桥，
 * 再起一轮真对话，验证内核确实用桥过去的**路由 + 密钥 + 模型**发请求（这是 0.2.1
 * 「测试连接成功、发消息却报模型密钥缺失」的回归面）。
 *
 * 两个场景：
 *   1. 自定义 openai-compatible 端点 → pi-ai 路由（kyclaw-<id>）：stub 收 `/v1/chat/completions`；
 *   2. DeepSeek 官方端点 → 内核自带 deepseek-official 路由：先断言桥写入的 baseURL 是
 *      `https://api.deepseek.com/anthropic`，再把 baseURL 改到本地 Messages stub 真跑一轮
 *      （不拿真 key 打真接口）；stub 收 `/v1/messages`，并带 `x-api-key`。
 *
 * 开启（本机已验证）：先跑 `pnpm fetch:kernel`（resources/kernel/rc.2 就绪），然后：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='F:\\deepseekharness\\DeepSeek Harness.exe'
 *   $env:KYCLAW_KERNEL_ASAR='E:\\gitlab\\kyclaw\\resources\\kernel\\rc.2'
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startAgentServer } from '../../agent/service'
import { startKernelAdapter } from '../kernel-adapter'
import { syncKernelModel, KERNEL_DEEPSEEK_KEY_REF } from '../kernel-model-bridge'
import { readSettings, settingsPath, writeSettings } from '../../settings'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { KYCLAW_AGENT_ID } from '../../../shared/agent-id'
import type { ProviderConfig } from '../../../shared/providers'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'E:\\gitlab\\kyclaw\\resources\\kernel\\rc.2'

/** OpenAI Chat Completions 的 SSE stub：pi-ai 的 openai-completions 路由打 `/chat/completions` */
function startCompletionsStub(reply: string): Promise<{
  server: Server
  baseUrl: string
  requests: Array<{ url: string | undefined; model: string | undefined; auth: string | undefined }>
}> {
  const requests: Array<{
    url: string | undefined
    model: string | undefined
    auth: string | undefined
  }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method !== 'POST' || !/\/chat\/completions$/u.test(url)) {
        res.writeHead(404).end('not found')
        return
      }
      let model: string | undefined
      try {
        const parsed = JSON.parse(body) as { model?: unknown }
        model = typeof parsed.model === 'string' ? parsed.model : undefined
      } catch {
        model = undefined
      }
      requests.push({ url, model, auth: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (data: unknown): void => {
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null): void => {
        send({
          id: 'chatcmpl-kyclaw-bridge',
          object: 'chat.completion.chunk',
          created: 1,
          model: model ?? 'gpt-x',
          choices: [{ index: 0, delta, finish_reason: finish }]
        })
      }
      chunk({ role: 'assistant', content: reply }, null)
      chunk({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        requests
      })
    })
  })
}

/** Anthropic Messages 的 SSE stub（内核 deepseek-official 路由打 `<base>/v1/messages`） */
function startMessagesStub(reply: string): Promise<{
  server: Server
  baseUrl: string
  requests: Array<{ url: string | undefined; apiKey: string | undefined }>
}> {
  const requests: Array<{ url: string | undefined; apiKey: string | undefined }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    req.on('end', () => {
      void body
      if (req.method !== 'POST' || !/\/v1\/messages/u.test(req.url ?? '')) {
        res.writeHead(404).end('not found')
        return
      }
      requests.push({
        url: req.url,
        apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined
      })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_kyclaw_bridge',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 }
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
        delta: { type: 'text_delta', text: reply }
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 6 }
      })
      send('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({ server, baseUrl: `http://127.0.0.1:${String(address.port)}`, requests })
    })
  })
}

function textOf(result: { frames: ReadonlyArray<{ type: string; delta?: string }> }): string {
  return result.frames
    .flatMap((frame) =>
      frame.type === 'text-delta' && frame.delta !== undefined ? [frame.delta] : []
    )
    .join('')
}

describe.runIf(ENABLED)('0.2.2 模型桥 → 真内核一轮对话', () => {
  it(
    '自定义 openai-compatible 端点：pi-ai 路由带密钥/模型真发请求，回复回传',
    { timeout: 180_000 },
    async () => {
      const reply = 'BRIDGE-PI-AI-OK'
      const stub = await startCompletionsStub(reply)
      const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-bridge-pi-'))
      const savedKey = process.env.DEEPSEEK_API_KEY
      // 证明不走环境变量兜底：桥必须自己把 key 写进内核 credential store
      delete process.env.DEEPSEEK_API_KEY
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        readyTimeoutMs: 60_000,
        turnTimeoutMs: 60_000
      })
      try {
        const provider: ProviderConfig = {
          id: 'custom-1',
          type: 'openai-compatible',
          baseUrl: `${stub.baseUrl}/v1`,
          model: 'gpt-x',
          models: ['gpt-x'],
          isDefault: true
        }
        const synced = await syncKernelModel((method, args) => adapter.rpcCall(method, args), {
          providers: [provider],
          readKey: () => 'sk-bridge-pi',
          probedModels: { 'custom-1:gpt-x': { contextWindow: 200_000, maxOutputTokens: 8_000 } }
        })
        expect(synced).toMatchObject({
          applied: true,
          mode: 'pi-ai',
          route: 'kyclaw-custom-1',
          model: 'gpt-x'
        })

        const result = await adapter.startTurn('say hi')
        expect(textOf(result)).toContain(reply)
        expect(stub.requests.length).toBeGreaterThan(0)
        const chat = stub.requests[0]
        expect(chat?.model).toBe('gpt-x')
        expect(chat?.auth).toBe('Bearer sk-bridge-pi')
      } finally {
        await adapter.stop()
        stub.server.close()
        rmSync(appDataDir, { recursive: true, force: true })
        if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
      }
    }
  )

  it(
    'DeepSeek 官方端点：桥写 kernel 官方路由（/anthropic + DEEPSEEK_API_KEY），换成 Messages stub 真跑一轮',
    { timeout: 180_000 },
    async () => {
      const reply = 'BRIDGE-DEEPSEEK-OFFICIAL-OK'
      const stub = await startMessagesStub(reply)
      const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-bridge-ds-'))
      const savedKey = process.env.DEEPSEEK_API_KEY
      delete process.env.DEEPSEEK_API_KEY
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        readyTimeoutMs: 60_000,
        turnTimeoutMs: 60_000
      })
      try {
        const provider: ProviderConfig = {
          id: 'deepseek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          isDefault: true
        }
        const synced = await syncKernelModel((method, args) => adapter.rpcCall(method, args), {
          providers: [provider],
          readKey: () => 'sk-bridge-official',
          probedModels: {}
        })
        expect(synced).toMatchObject({ applied: true, mode: 'deepseek-official' })

        // 桥写进内核的是「官方 OpenAI 兼容地址 → Messages 端点」，不是原始 api.deepseek.com
        const described = (await adapter.rpcCall('settings/describe', {})) as {
          namespaces?: Array<{ ns?: string; user?: { baseURL?: string; apiKeyEnv?: string } }>
        }
        const llm = described.namespaces?.find((entry) => entry.ns === 'llm-deepseek')
        expect(llm?.user?.baseURL).toBe('https://api.deepseek.com/anthropic')
        expect(llm?.user?.apiKeyEnv).toBe(KERNEL_DEEPSEEK_KEY_REF)
        const defaultNs = described.namespaces?.find(
          (entry) => entry.ns === 'agent-default-model'
        ) as { value?: { provider?: string; model?: string } } | undefined
        // 已经就是内核缺省值（deepseek-official/deepseek-flash）时 mutate 是空操作、user 层为空，
        // 所以看 resolved value（同一件事：内核选中的默认模型就是用户设置的那个）
        expect(defaultNs?.value).toMatchObject({
          provider: 'deepseek-official',
          model: 'deepseek-flash'
        })

        // 不拿真 key 打真接口：把 baseURL 改到本地 Messages stub，验证内核带着桥过来的凭证真发请求
        await adapter.rpcCall('settings/mutate', {
          ns: 'llm-deepseek',
          ops: [{ op: 'set', path: ['baseURL'], value: stub.baseUrl }]
        })
        const result = await adapter.startTurn('say hi')
        expect(textOf(result)).toContain(reply)
        expect(stub.requests.length).toBeGreaterThan(0)
        expect(stub.requests[0]?.apiKey).toBe('sk-bridge-official')
      } finally {
        await adapter.stop()
        stub.server.close()
        rmSync(appDataDir, { recursive: true, force: true })
        if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
      }
    }
  )

  it(
    '生产装配：settings.json 的 providers + 主进程密钥 → startAgentServer 启动即桥，走真 HTTP chat 完成一轮',
    { timeout: 180_000 },
    async () => {
      const reply = 'BRIDGE-WIRING-OK'
      const stub = await startCompletionsStub(reply)
      const dataDir = mkdtempSync(join(tmpdir(), 'kyclaw-bridge-wiring-'))
      const savedKey = process.env.DEEPSEEK_API_KEY
      // 生产代码从不在内核 env 里放密钥（只有测试做过），这里也彻底拿掉：桥必须自己写 credential store
      delete process.env.DEEPSEEK_API_KEY
      const provider: ProviderConfig = {
        id: 'custom-1',
        type: 'openai-compatible',
        baseUrl: `${stub.baseUrl}/v1`,
        model: 'gpt-x',
        models: ['gpt-x'],
        isDefault: true
      }
      writeSettings(settingsPath(dataDir), { ...DEFAULT_SETTINGS, providers: [provider] })
      let server: Awaited<ReturnType<typeof startAgentServer>> | undefined
      try {
        server = await startAgentServer({
          dataDir,
          kernel: { electronExecutable: ELECTRON, asarPath: ASAR },
          // 生产 = main/index.ts 注入：providers 现读 settings.json、密钥由 main 读 safeStorage
          model: {
            providers: () => readSettings(settingsPath(dataDir)).providers,
            probedModels: () => readSettings(settingsPath(dataDir)).probedModels,
            readKey: () => 'sk-bridge-wiring'
          }
        })
        const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${server.token}`
          },
          body: JSON.stringify({
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'say hi' }] }]
          })
        })
        expect(response.status).toBe(200)
        const sse = await response.text()
        expect(sse).toContain(reply)
        expect(sse).not.toContain('"type":"error"')
        expect(stub.requests[0]?.auth).toBe('Bearer sk-bridge-wiring')
        expect(stub.requests[0]?.model).toBe('gpt-x')
      } finally {
        await server?.stop()
        stub.server.close()
        rmSync(dataDir, { recursive: true, force: true })
        if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
      }
    }
  )
})
