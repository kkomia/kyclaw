/**
 * B3.1a：极简 WebSocket 客户端（RFC 6455），只服务内核 `/api/remote.mux`。
 *
 * 为什么不用现成库：项目没有 `ws` 生产依赖（不加依赖是硬边界），Node 全局 `WebSocket`
 * 又不支持自定义 `Cookie` 头；这里只需要 "带 Cookie 的文本帧 + ping/close"。
 *
 * 边界：只做 client 侧、只支持文本帧/continuation/ping/pong/close；不做压缩、不做二进制业务帧。
 */
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WebSocketClientOptions {
  url: string
  cookie?: string
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
}

export interface WebSocketClient {
  readonly url: string
  send(text: string): void
  close(): void
  onMessage(listener: (text: string) => void): void
  onClose(listener: (error?: Error) => void): void
}

function frame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

/** 最小客户端：握手 + 文本发送 + 服务端帧解析（分片/心跳/关闭） */
export async function connectWebSocket(options: WebSocketClientOptions): Promise<WebSocketClient> {
  const target = new URL(options.url)
  if (target.protocol !== 'ws:')
    throw new Error(`ws client: only ws:// is supported, got ${target.protocol}`)
  const key = randomBytes(16).toString('base64')
  const timeoutMs = options.timeoutMs ?? 10_000

  const { socket, response } = await new Promise<{ socket: Socket; response: IncomingMessage }>(
    (resolve, reject) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
          ...options.headers
        }
      })
      const timer = setTimeout(() => {
        request.destroy(new Error('ws client: handshake timeout'))
        reject(new Error('ws client: handshake timeout'))
      }, timeoutMs)
      request.on('upgrade', (incoming, upgradedSocket) => {
        clearTimeout(timer)
        const expected = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
        if (incoming.headers['sec-websocket-accept'] !== expected) {
          upgradedSocket.destroy()
          reject(new Error('ws client: invalid Sec-WebSocket-Accept'))
          return
        }
        resolve({ socket: upgradedSocket, response: incoming })
      })
      request.on('response', (incoming) => {
        clearTimeout(timer)
        incoming.resume()
        reject(new Error(`ws client: handshake rejected with HTTP ${String(incoming.statusCode)}`))
      })
      request.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      request.end()
    }
  )
  void response

  const messageListeners = new Set<(text: string) => void>()
  const closeListeners = new Set<(error?: Error) => void>()
  let buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentOpcode = 0
  let closed = false

  const notifyClose = (error?: Error): void => {
    if (closed) return
    closed = true
    for (const listener of closeListeners) listener(error)
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const first = buffer[0] ?? 0
      const second = buffer[1] ?? 0
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          socket.destroy(new Error('ws client: frame too large'))
          return
        }
        length = Number(big)
        offset = 10
      }
      let mask: Buffer | undefined
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      buffer = buffer.subarray(offset + length)
      if (mask !== undefined) {
        for (let index = 0; index < payload.length; index += 1)
          payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
      }

      if (opcode === 0x08) {
        try {
          socket.write(frame(0x08, Buffer.alloc(0)))
        } catch {
          // socket 可能已经关闭
        }
        socket.end()
        notifyClose()
        return
      }
      if (opcode === 0x09) {
        try {
          socket.write(frame(0x0a, payload))
        } catch {
          // ignore
        }
        continue
      }
      if (opcode === 0x0a) continue
      if (opcode === 0x00) {
        fragments.push(payload)
        if (!fin) continue
        const complete = Buffer.concat(fragments)
        fragments = []
        if (fragmentOpcode === 0x01) {
          const text = complete.toString('utf8')
          for (const listener of messageListeners) listener(text)
        }
        continue
      }
      if (opcode === 0x01) {
        if (!fin) {
          fragmentOpcode = opcode
          fragments = [payload]
          continue
        }
        const text = payload.toString('utf8')
        for (const listener of messageListeners) listener(text)
      }
    }
  })
  socket.on('close', () => notifyClose())
  socket.on('error', (error) => notifyClose(error))

  return {
    url: options.url,
    send(text) {
      if (closed) throw new Error('ws client: socket is closed')
      socket.write(frame(0x01, Buffer.from(text, 'utf8')))
    },
    close() {
      if (closed) return
      try {
        socket.write(frame(0x08, Buffer.alloc(0)))
      } catch {
        // ignore
      }
      socket.end()
      notifyClose()
    },
    onMessage(listener) {
      messageListeners.add(listener)
    },
    onClose(listener) {
      closeListeners.add(listener)
    }
  }
}
