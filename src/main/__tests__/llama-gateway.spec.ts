// @vitest-environment node
/**
 * 模块 3B：嵌入网关的测试（真起 HTTP 服务，上游是一个记账用的假引擎）。
 *
 * 网关的三件事：**只让带对 token 的人进来**、**原样转发**（含把引擎的 key 补上）、
 * **引擎没起来时把 503 说成人话**（Memory 那边失败只做加法，但原因要落到状态行上）。
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineStatus, LlamaEngine } from '../llama/engine'
import { createEmbeddingGateway, type EmbeddingGateway } from '../llama/gateway'

const KEY = 'gateway-test-key'

interface Upstream {
  port: number
  /** 收到的请求（method/url/authorization/body） */
  received: Array<{ method: string; url: string; authorization: string | undefined; body: string }>
  /** 让 ensureStarted 失败（模拟引擎起不来） */
  broken: boolean
  stop: () => Promise<void>
}

const open: Array<() => Promise<void>> = []

/** 一个"假引擎"的 HTTP 上游：回 OpenAI 兼容的嵌入回包（8 维，L2 归一） */
async function startUpstream(): Promise<Upstream> {
  const upstream: Upstream = { port: 0, received: [], broken: false, stop: async () => undefined }
  const server: HttpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      upstream.received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body
      })
      const parsed = JSON.parse(body || '{}') as { input?: unknown; model?: unknown }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          object: 'list',
          model: parsed.model ?? 'upstream',
          data: inputs.map((input, index) => ({
            object: 'embedding',
            index,
            embedding: Array.from({ length: 8 }, (_, position) =>
              Math.abs(Math.sin(String(input).length + position))
            )
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length }
        })
      )
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  upstream.port = (server.address() as AddressInfo).port
  upstream.stop = () =>
    new Promise<void>((resolveClose) => {
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    })
  open.push(upstream.stop)
  return upstream
}

/** 一本假引擎门面：`ensureStarted` 回上游端口（或按 broken 抛错），并记账"在飞请求" */
interface EngineSpy {
  engine: LlamaEngine
  /** 当前在飞的请求数（网关处理完必须回到 0，否则空闲回收永远等不到） */
  inFlight: () => number
}

function fakeEngine(upstream: Upstream): EngineSpy {
  let inFlight = 0
  return {
    inFlight: () => inFlight,
    engine: {
      ensureStarted: async () => {
        if (upstream.broken) throw new Error('引擎起不来（模拟）')
        return { port: upstream.port }
      },
      status: (): EngineStatus => ({ phase: 'running', modelId: 'stub', detail: null }),
      begin: () => {
        inFlight += 1
        return () => {
          inFlight -= 1
        }
      },
      lastUsedAt: () => Date.now(),
      stop: async () => undefined,
      dispose: async () => undefined
    }
  }
}

async function startGateway(
  upstream: Upstream
): Promise<{ gateway: EmbeddingGateway; baseUrl: string; spy: EngineSpy }> {
  const spy = fakeEngine(upstream)
  const gateway = createEmbeddingGateway({
    engine: spy.engine,
    apiKey: KEY,
    log: () => undefined
  })
  const { baseUrl } = await gateway.start()
  open.push(() => gateway.close())
  return { gateway, baseUrl, spy }
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.()
})

describe('嵌入网关', () => {
  it('没有 token / token 不对：401，且**不碰**上游', async () => {
    const upstream = await startUpstream()
    const { baseUrl } = await startGateway(upstream)

    const anonymous = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: ['x'] })
    })
    expect(anonymous.status).toBe(401)
    const wrong = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' },
      body: JSON.stringify({ model: 'm', input: ['x'] })
    })
    expect(wrong.status).toBe(401)
    expect(upstream.received).toHaveLength(0)
  })

  it('带着正确 token：原样转发（含把引擎的 key 补上），回包原样带回', async () => {
    const upstream = await startUpstream()
    const { baseUrl } = await startGateway(upstream)

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'bge-small-zh-v1.5-q8', input: ['你好', '世界'] })
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      object: string
      data: Array<{ index: number; embedding: number[] }>
      usage: { prompt_tokens: number }
    }
    expect(body.object).toBe('list')
    expect(body.data).toHaveLength(2)
    expect(body.usage.prompt_tokens).toBe(2)
    for (const item of body.data) {
      const norm = Math.sqrt(item.embedding.reduce((sum, value) => sum + value * value, 0))
      expect(norm).toBeGreaterThan(0)
    }

    expect(upstream.received).toHaveLength(1)
    expect(upstream.received[0]?.url).toBe('/v1/embeddings')
    expect(upstream.received[0]?.authorization).toBe(`Bearer ${KEY}`)
    expect(upstream.received[0]?.body).toContain('bge-small-zh-v1.5-q8')
  })

  it('引擎起不来：回 503 + 人话（这一轮召回跳过，但不把进程带崩），在飞计数归零', async () => {
    const upstream = await startUpstream()
    upstream.broken = true
    const { baseUrl, spy } = await startGateway(upstream)

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'm', input: ['x'] })
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('本机嵌入引擎不可用')
    expect(body.error.message).toContain('引擎起不来（模拟）')
    // 失败路径也把"在飞"还回去：否则空闲回收永远等不到那一刻
    expect(spy.inFlight()).toBe(0)

    // 引擎恢复之后同一把网关照样能用（空闲回收后自动重启就是靠这个形状）
    upstream.broken = false
    const retry = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'm', input: ['x'] })
    })
    expect(retry.status).toBe(200)
    expect(spy.inFlight()).toBe(0)
  })

  it('/health 不转发、不鉴权：只回网关自己的状态', async () => {
    const upstream = await startUpstream()
    const { baseUrl } = await startGateway(upstream)
    const response = await fetch(`${baseUrl.replace(/\/v1$/, '')}/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; engine: string }
    expect(body).toEqual({ status: 'ok', engine: 'running' })
    expect(upstream.received).toHaveLength(0)
  })

  it('请求体过大：拒绝（本机别的进程别拿网关当上传口）', async () => {
    const upstream = await startUpstream()
    const gateway = createEmbeddingGateway({
      engine: fakeEngine(upstream).engine,
      apiKey: KEY,
      maxBodyBytes: 1024,
      log: () => undefined
    })
    const { baseUrl } = await gateway.start()
    open.push(() => gateway.close())

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'm', input: ['x'.repeat(4096)] })
    }).catch(() => null)
    // 连接被 destroy 时 fetch 抛错；无论哪种，都不该有正常回包
    if (response !== null) expect(response.status).toBeGreaterThanOrEqual(500)
    expect(upstream.received).toHaveLength(0)
  })
})

// 保住一个 import 的使用（vitest 的 spy 清理口径与其他 spec 一致）
void vi
