/**
 * B2：`HostToolBridge` 骨架（D2）。
 *
 * 形状：**Electron main 内的回环 HTTP + 每次启动随机 token**。
 * 用途（C 阶段才会接上）：内核的插件/工具需要回调我们 main 侧的能力（读工作区、审批…），
 * 但**内核 token 不下发 renderer**（D1）；bridge 的 token 只存在 main 与内核对端的这一小段里。
 *
 * B2 只实现**传输与鉴权**（无业务 handler 接线、无进程启动）；测试用本地回环验证
 * 「无 token 401 / 有 token 200 / close 后不再监听」。
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface HostToolBridgeRequest {
  token: string
  /** 已解析的 JSON body（非法 JSON 为 null） */
  body: unknown
  method: string
  url: string
}

export interface HostToolBridge {
  /** 形如 `http://127.0.0.1:<port>`（只监听回环） */
  readonly url: string
  /** 本次启动随机生成的 bridge token（**只给 main/内核，不下发 renderer**） */
  readonly token: string
  close(): Promise<void>
}

export interface HostToolBridgeOptions {
  handler: (request: HostToolBridgeRequest) => Promise<unknown>
  host?: string
  /** 默认 0（OS 分配）；测试可指定 */
  port?: number
  /** 测试可注入固定 token；缺省随机 32 字节 base64url */
  token?: string
  /** body 上限，默认 1 MiB */
  maxBodyBytes?: number
}

const DEFAULT_MAX_BODY = 1024 * 1024

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`host tool bridge: body exceeds ${String(limit)} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString()
  })
  res.end(body)
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: 'unauthorized' })
}

export async function startHostToolBridge(options: HostToolBridgeOptions): Promise<HostToolBridge> {
  const token = options.token ?? randomBytes(32).toString('base64url')
  const host = options.host ?? '127.0.0.1'
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      const authorization = req.headers.authorization
      const presented =
        typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : req.headers['x-kyclaw-bridge-token']
      if (presented !== token) {
        unauthorized(res)
        return
      }
      let raw: string
      try {
        raw = await readBody(req, limit)
      } catch (error) {
        sendJson(res, 413, { error: error instanceof Error ? error.message : 'body-too-large' })
        return
      }
      let body: unknown = null
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { error: 'invalid-json' })
          return
        }
      }
      try {
        const result = await options.handler({
          token,
          body,
          method: req.method,
          url: req.url ?? '/'
        })
        sendJson(res, 200, { ok: true, result })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })().catch((error: unknown) => {
      // 兜底：handler/传输的意外错误不能把 main 弄挂
      try {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      } catch {
        // 响应已经发出去/连接已断，忽略
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo | null
  if (address === null) throw new Error('host tool bridge: no address after listen')

  let closed = false
  return {
    url: `http://${host}:${String(address.port)}`,
    token,
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }
}
