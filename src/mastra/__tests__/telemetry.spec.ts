// @vitest-environment node
/**
 * Langfuse 接线（T17）：判定口径（纯函数）+ 一条真链路。
 *
 * 真链路怎么测：起一个**假的 OTLP 端点**（本机 http，收 POST /api/public/otel/v1/traces），
 * 配置指向它 → 用 mock 模型跑一轮真对话 → 收尾（server.stop → mastra.shutdown → observability
 * shutdown）把批量里的 span flush 出去 → 断言"导出确实发生了"：
 *   - 请求打到 OTLP 路径、带 Basic(publicKey:secretKey) 认证（Langfuse 的认证口径）；
 *   - protobuf 载荷里能找到服务名（字符串字段在 protobuf 里是可读的明文）。
 * 默认关那一路断言"一个请求都没有"。
 *
 * 边界（报告里也写明）：真是 Langfuse 后端（云账号 / docker 自托管）**没有**接，
 * 所以"trace 在 Langfuse 界面里可见"这一步未验证——这里验证的是 exporter 真把数据发出去了。
 */
import {
  createServer,
  request as request_,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import {
  langfuseConfigOf,
  normalizeLangfuseEndpoint,
  normalizeProxyUrl,
  resolveProxyUrl
} from '../telemetry'
import { stopLangfuseRelays } from '../langfuse-relay'
import { settingsPath, writeSettings } from '../../main/settings'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const PUBLIC_KEY = 'pk-lf-test-0001'
const SECRET_KEY = 'sk-lf-test-0002-SECRET'
const AGENT_ID = 'kyclaw-agent'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
}

interface CapturedRequest {
  method: string | undefined
  url: string | undefined
  headers: IncomingMessage['headers']
  body: string
}

/** 假 OTLP 端点：收请求、记下来、回一个空的 ExportTraceServiceResponse（200 + 空体） */
async function startCollector(): Promise<{
  url: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}> {
  const requests: CapturedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('latin1')
      })
      response.writeHead(200, { 'content-type': 'application/x-protobuf' })
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/**
 * 假 HTTP 代理（round 67）：把收到的请求行原样记下来，再按**绝对 URI** 转发到真正的目标。
 * "请求行是绝对形式"正是走 HTTP 正向代理的标志（直连时只会是 `/api/public/otel/v1/traces`），
 * 所以 seen 里有这一条 = 代理真被用上了。
 */
async function startFakeProxy(): Promise<{
  url: string
  seen: string[]
  close: () => Promise<void>
}> {
  const seen: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push(`${request.method} ${request.url}`)
    let target: URL
    try {
      target = new URL(request.url ?? '')
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    const upstream = request_(
      {
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: { ...request.headers, host: target.host }
      },
      (up: IncomingMessage) => {
        response.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(response)
      }
    )
    upstream.on('error', () => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

function mockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'kyclaw-test-mock',
    modelId: 'kyclaw-test-mock',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: '追踪冒烟' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: USAGE }
        ],
        initialDelayInMs: 0,
        chunkDelayInMs: 1
      })
    })
  })
}

/** 跑一轮真对话（走服务端的 chat 路由），把响应读完让 run 收尾 */
async function chatOnce(server: AgentServerHandle): Promise<void> {
  const response = await fetch(`${server.baseUrl}/chat/${AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '在吗？' }] }]
    })
  })
  expect(response.status).toBe(200)
  await response.text()
}

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-langfuse-'))
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放）：', dir)
  }
})

const stopped: AgentServerHandle[] = []

afterEach(async () => {
  for (const handle of stopped.splice(0)) await handle.stop()
})

describe('Langfuse 判定口径', () => {
  it('地址归一：去空白、去结尾斜杠', () => {
    expect(normalizeLangfuseEndpoint('  https://cloud.langfuse.com/// ')).toBe(
      'https://cloud.langfuse.com'
    )
    expect(normalizeLangfuseEndpoint('')).toBe('')
  })

  it('代理地址归一：去空白；没写协议补 http://（否则 URL 会把 IP 当协议）', () => {
    expect(normalizeProxyUrl('  127.0.0.1:7890 ')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('http://proxy.lan:8080/')).toBe('http://proxy.lan:8080/')
    expect(normalizeProxyUrl('socks5://p:1080')).toBe('socks5://p:1080')
    expect(normalizeProxyUrl('   ')).toBe('')
  })

  it('代理来源：设置项优先；没填才看环境变量（大小写都认，最后 ALL_PROXY）', () => {
    expect(resolveProxyUrl('http://setting:1', { HTTPS_PROXY: 'http://env:2' })).toBe(
      'http://setting:1'
    )
    expect(resolveProxyUrl('', { LANGFUSE_PROXY_URL: 'http://lf:3' })).toBe('http://lf:3')
    expect(resolveProxyUrl('', { HTTPS_PROXY: 'http://env:2' })).toBe('http://env:2')
    expect(resolveProxyUrl('', { http_proxy: 'http://env:4' })).toBe('http://env:4')
    expect(resolveProxyUrl('', { ALL_PROXY: 'http://env:5' })).toBe('http://env:5')
    expect(resolveProxyUrl(null, {})).toBe('')
  })

  it('三项齐才算开启；缺任何一项都是 null（默认关就是地址为空这一路）', () => {
    expect(
      langfuseConfigOf({ endpoint: 'https://cloud.langfuse.com', publicKey: 'pk', secretKey: 'sk' })
    ).toEqual({ endpoint: 'https://cloud.langfuse.com', publicKey: 'pk', secretKey: 'sk' })

    for (const bad of [
      { endpoint: '', publicKey: 'pk', secretKey: 'sk' },
      { endpoint: '   ', publicKey: 'pk', secretKey: 'sk' },
      { endpoint: 'https://cloud.langfuse.com', publicKey: null, secretKey: 'sk' },
      { endpoint: 'https://cloud.langfuse.com', publicKey: 'pk', secretKey: null },
      { endpoint: 'https://cloud.langfuse.com', publicKey: '', secretKey: 'sk' }
    ]) {
      expect(langfuseConfigOf(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('代理是纯加法：没填就不带这个字段（老配置的形状一个字不变）', () => {
    expect(
      langfuseConfigOf({
        endpoint: 'http://100.66.1.1:3000',
        publicKey: 'pk',
        secretKey: 'sk',
        proxyUrl: '   '
      })
    ).toEqual({ endpoint: 'http://100.66.1.1:3000', publicKey: 'pk', secretKey: 'sk' })
    expect(
      langfuseConfigOf({
        endpoint: 'http://100.66.1.1:3000',
        publicKey: 'pk',
        secretKey: 'sk',
        proxyUrl: ' 127.0.0.1:7890 '
      })
    ).toEqual({
      endpoint: 'http://100.66.1.1:3000',
      publicKey: 'pk',
      secretKey: 'sk',
      proxyUrl: 'http://127.0.0.1:7890'
    })
  })
})

describe('Langfuse 真链路（假 OTLP 端点 + 假代理）', () => {
  it('配了代理：span 先打到本机中转 → 再由代理转发到端点（代理请求行是绝对 URI）', async () => {
    const collector = await startCollector()
    const proxy = await startFakeProxy()
    try {
      const server = await startAgentServer({
        dataDir: dir,
        model: mockModel(),
        langfuse: () =>
          langfuseConfigOf({
            endpoint: collector.url,
            proxyUrl: proxy.url,
            publicKey: PUBLIC_KEY,
            secretKey: SECRET_KEY
          })
      })
      stopped.push(server)
      expect(server.telemetry).toEqual({ langfuse: true })

      await chatOnce(server)
      await server.stop()
      stopped.length = 0

      // 数据经代理到了端点：认证头、路径、服务名一个不少
      expect(collector.requests.length).toBeGreaterThan(0)
      expect(collector.requests[0].url).toBe('/api/public/otel/v1/traces')
      expect(collector.requests[0].headers.authorization).toBe(
        `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')}`
      )
      expect(collector.requests[0].body).toContain('kyclaw')
      // 代理真被用上了：请求行是绝对形式（`POST http://host:port/...`）——直连不会长这样
      expect(proxy.seen).toContain(`POST ${collector.url}/api/public/otel/v1/traces`)
    } finally {
      await proxy.close()
      await collector.close()
    }
  }, 30_000)

  it('没配代理：不吃代理（一个请求都不进假代理，链路照常）', async () => {
    const collector = await startCollector()
    const proxy = await startFakeProxy()
    try {
      const server = await startAgentServer({
        dataDir: dir,
        model: mockModel(),
        langfuse: () =>
          langfuseConfigOf({
            endpoint: collector.url,
            publicKey: PUBLIC_KEY,
            secretKey: SECRET_KEY
          })
      })
      stopped.push(server)

      await chatOnce(server)
      await server.stop()
      stopped.length = 0

      expect(collector.requests.length).toBeGreaterThan(0)
      expect(proxy.seen).toEqual([])
    } finally {
      await proxy.close()
      await collector.close()
    }
  }, 30_000)

  it('配齐后：一轮对话的 span 会发到 OTLP 端点，带 Basic 认证与服务名', async () => {
    const collector = await startCollector()
    try {
      const server = await startAgentServer({
        dataDir: dir,
        model: mockModel(),
        langfuse: () =>
          langfuseConfigOf({
            endpoint: collector.url,
            publicKey: PUBLIC_KEY,
            secretKey: SECRET_KEY
          })
      })
      stopped.push(server)
      // 装配期就挂上了（设置页拿它说"已开启"）
      expect(server.telemetry).toEqual({ langfuse: true })

      await chatOnce(server)
      // 收尾把批量里的 span flush 出去（mastra.shutdown → observability.shutdown）
      await server.stop()
      stopped.length = 0

      expect(collector.requests.length).toBeGreaterThan(0)
      const request = collector.requests[0]
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/api/public/otel/v1/traces')
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')}`
      )
      expect(request.headers['content-type']).toContain('json')
      // OTLP/JSON 载荷：服务名在 resource attributes 上（Langfuse 的 service 维度）
      const payload = JSON.parse(request.body) as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
          scopeSpans: Array<{ spans: Array<{ name: string }> }>
        }>
      }
      const attributes = payload.resourceSpans[0]?.resource.attributes ?? []
      const serviceName = attributes.find((attribute) => attribute.key === 'service.name')?.value
        .stringValue
      expect(serviceName).toBe('kyclaw')
      const spanNames = payload.resourceSpans.flatMap((entry) =>
        entry.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name))
      )
      // 一轮对话的 span 真在里面（模型调用 + agent 上的 chat span）
      expect(spanNames.some((name) => name.startsWith('chat'))).toBe(true)
      expect(spanNames.some((name) => name.startsWith('model_chunk'))).toBe(true)
    } finally {
      await collector.close()
    }
    // 真链路（真起 agent 服务 + 真跑一轮 + shutdown flush）：满载全跑下 5s 默认超时会顶穿
    // （单跑约 2s；round 59 全量门禁首跑实测），补 30s——与 workbench 办公档同型的加固
  }, 30_000)

  it('默认关（没配）：不建 observability、一个请求都不发', async () => {
    const collector = await startCollector()
    try {
      // 落盘设置里也没有 langfuse（就是全新安装的样子）
      writeSettings(settingsPath(dir), DEFAULT_SETTINGS)
      const server = await startAgentServer({
        dataDir: dir,
        model: mockModel(),
        langfuse: () => null
      })
      stopped.push(server)
      expect(server.telemetry).toEqual({ langfuse: false })

      await chatOnce(server)
      await server.stop()
      stopped.length = 0

      expect(collector.requests).toEqual([])
    } finally {
      await collector.close()
    }
    // 同上一例：真起服务 + 真跑一轮，满载下 5s 会顶穿
  }, 30_000)
})

afterAll(async () => {
  // 中转是进程级登记表（server.unref 过，不会钉住进程）；测试收尾一并收干净
  await stopLangfuseRelays()
})
