/**
 * 嵌入网关（模块 3B）：本机嵌入引擎对外的**唯一入口**（`http://127.0.0.1:<port>/v1`）。
 *
 * 为什么中间要有一层自己的 HTTP 服务，而不是让 Memory 直接连 `llama-server` 的端口：
 *   1. **空闲回收要能观察**：请求都从这里过，才谈得上"5 分钟没人用就把引擎杀掉"；
 *      直连的话主进程根本看不见请求，只能靠轮询 `/metrics` 猜。
 *   2. **回收之后能自动重启**：引擎进程随空闲回收消失、端口也换了，而挂给 Memory 的 embedder
 *      只认一个固定 baseURL。网关端口固定，引擎在它后面随起随落 —— 下一轮召回会**自动**重新拉起引擎，
 *      而不是永远失败到应用重启为止。
 *   3. **token 闸门**：与内嵌 agent 服务同一套纪律（127.0.0.1 + Bearer）。llama-server 那份
 *      API Key 只有网关知道，本机别的进程既进不来网关，也连不了引擎。
 *
 * 只代理，不改语义：请求体原样转发，响应体原样回（**不做二次归一化** —— 归一化口径由引擎定，
 * 见 engine.ts 头注与测试里的 L2 断言）。纯 Node，可单测（真起服务、假引擎）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LlamaEngine } from './engine'

export interface EmbeddingGatewayOptions {
  engine: LlamaEngine
  /** 入站 Bearer 校验与转发用的同一把密钥（引擎的 API Key） */
  apiKey: string
  host?: string
  /** 缺省 0（随机空闲端口） */
  port?: number
  /** 请求体上限（嵌入请求都是小 JSON；挡住本机别的进程的意外大包，缺省 8MB） */
  maxBodyBytes?: number
  log?: (message: string, error?: unknown) => void
}

export interface EmbeddingGateway {
  /** 起监听；回实际 baseURL（给 embedder 用） */
  start(): Promise<{ baseUrl: string; port: number }>
  baseUrl(): string | null
  close(): Promise<void>
}

function defaultLog(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message)
  else console.warn(message, error)
}

/** OpenAI 兼容形状的错误体（AI SDK 会把 message 带出来，所以这里必须是人话） */
function errorBody(message: string, type = 'engine_unavailable'): string {
  return JSON.stringify({ error: { message, type, code: null, param: null } })
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) return false
  return header.slice(prefix.length) === token
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

export function createEmbeddingGateway(options: EmbeddingGatewayOptions): EmbeddingGateway {
  const log = options.log ?? defaultLog
  const host = options.host ?? '127.0.0.1'
  const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024
  let server: Server | undefined
  let url: string | null = null

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 网关自己的健康端点：不转发、不鉴权（只回自己的状态，不含任何上游信息）
    if (request.method === 'GET' && request.url === '/health') {
      const engine = options.engine.status()
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'ok', engine: engine.phase }))
      return
    }

    if (!bearerMatches(request.headers.authorization, options.apiKey)) {
      response
        .writeHead(401, { 'content-type': 'application/json' })
        .end(errorBody('unauthorized', 'unauthorized'))
      return
    }

    const end = options.engine.begin()
    try {
      const body =
        request.method === 'POST' || request.method === 'PUT'
          ? await readBody(request, maxBodyBytes)
          : undefined
      const target = await options.engine.ensureStarted()
      const upstream = await fetch(`http://127.0.0.1:${target.port}${request.url ?? '/'}`, {
        method: request.method,
        headers: {
          'content-type': request.headers['content-type'] ?? 'application/json',
          accept: request.headers.accept ?? 'application/json',
          // 引擎的 key 只在这一跳上用（渲染端/embedder 见到的永远只是网关那把）
          authorization: `Bearer ${options.apiKey}`
        },
        ...(body === undefined ? {} : { body: body as unknown as RequestInit['body'] })
        // 模型加载 + 前向计算都在这条路上；不设超时：宁可慢慢等，也别把一次召回掐成半截
      })
      const payload = Buffer.from(await upstream.arrayBuffer())
      const headers: Record<string, string> = {
        'content-type': upstream.headers.get('content-type') ?? 'application/json'
      }
      response.writeHead(upstream.status, headers)
      response.end(payload)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log('[kyclaw] 本机嵌入引擎请求失败（本轮召回跳过，对话不受影响）', error)
      response
        .writeHead(503, { 'content-type': 'application/json' })
        .end(errorBody(`本机嵌入引擎不可用：${detail}`))
    } finally {
      end()
    }
  }

  return {
    start: async () => {
      if (server !== undefined && url !== null)
        return { baseUrl: url, port: (server.address() as AddressInfo).port }
      const created = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          log('[kyclaw] 嵌入网关处理请求出错', error)
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
          response.end(errorBody('嵌入网关内部错误'))
        })
      })
      // 长连接：embedder 会复用连接，别让 keepalive 超时把下一轮拖慢
      created.keepAliveTimeout = 30_000
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject)
        created.listen(options.port ?? 0, host, () => resolve())
      })
      const address = created.address() as AddressInfo
      server = created
      url = `http://${host}:${address.port}/v1`
      log(`[kyclaw] 本机嵌入网关已启动：${url}`)
      return { baseUrl: url, port: address.port }
    },
    baseUrl: () => url,
    close: async () => {
      const current = server
      server = undefined
      url = null
      if (current === undefined) return
      await new Promise<void>((resolve) => {
        current.closeAllConnections?.()
        current.close(() => resolve())
      })
    }
  }
}
