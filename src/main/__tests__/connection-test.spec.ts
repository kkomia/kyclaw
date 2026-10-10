// @vitest-environment node
/**
 * "测试连接"（main/connection-test.ts）：主进程发一条最小请求，把结果翻译成 延迟 / 一句人话。
 *
 * 用例全部打本地假供应商（127.0.0.1 随机端口），零外部网络：
 * 这里验的是"真的发出了请求、错误真的能翻译对、文案里真的没有密钥"，
 * 而不是再对 AI SDK 做一遍重复测试。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderConfig } from '../../shared/providers'
import { testConnection } from '../connection-test'

const KEY = 'sk-conn-4c8e0a6f-SECRET'

const CHAT_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
}

type RequestLog = { url?: string; authorization?: string }

const openServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close()
})

async function fakeProvider(
  onRequest: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ log: RequestLog[]; config: ProviderConfig }> {
  const log: RequestLog[] = []
  const server = createServer((request, response) => {
    log.push({ url: request.url, authorization: request.headers.authorization })
    onRequest(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  openServers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  })
  return {
    log,
    config: {
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      isDefault: true
    }
  }
}

describe('testConnection', () => {
  it('通的：回 ok + 延迟；请求带 Bearer 密钥、打到 /v1/chat/completions', async () => {
    const provider = await fakeProvider((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(CHAT_COMPLETION))
    })

    const result = await testConnection(provider.config, KEY)

    expect(result.ok).toBe(true)
    expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(provider.log).toHaveLength(1)
    expect(provider.log[0].url).toBe('/v1/chat/completions')
    expect(provider.log[0].authorization).toBe(`Bearer ${KEY}`)
  }, 30_000)

  it('认证失败（401）：翻成"认证失败"，且供应商回显的密钥被抹掉', async () => {
    const provider = await fakeProvider((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `Invalid API key: ${KEY}` } }))
    })

    const result = await testConnection(provider.config, KEY)

    expect(result).toEqual({ ok: false, message: expect.stringContaining('认证失败（401）') })
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('连不上：网络错误 + 端点（不把 SDK 的原始堆栈甩给用户）', async () => {
    // 127.0.0.1:1 上没有服务（Windows/Linux 都是立即拒绝，不会挂住）
    const config: ProviderConfig = {
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test-model',
      isDefault: true
    }

    const result = await testConnection(config, KEY)

    expect(result).toEqual({ ok: false, message: expect.stringContaining('网络错误') })
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('掐住不响应：超时（按 timeoutMs）而不是干等', async () => {
    const provider = await fakeProvider(() => {
      /* 永不响应 */
    })

    const result = await testConnection(provider.config, KEY, { timeoutMs: 300 })

    expect(result).toEqual({ ok: false, message: expect.stringContaining('连接超时') })
  }, 30_000)

  it('注入的 generate 抛一般错误 → "连接失败：<原因>"，密钥同样被抹掉', async () => {
    const config: ProviderConfig = {
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'test-model',
      isDefault: true
    }

    const result = await testConnection(config, KEY, {
      generate: async () => {
        throw new Error(`proxy rejected key ${KEY}`)
      }
    })

    expect(result).toEqual({ ok: false, message: expect.stringContaining('连接失败') })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('注入的 generate 正常 → ok + 延迟（成功路径不依赖网络）', async () => {
    const config: ProviderConfig = {
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'test-model',
      isDefault: true
    }

    const result = await testConnection(config, KEY, { generate: async () => ({}) })

    expect(result.ok).toBe(true)
  })
})
