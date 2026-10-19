// @vitest-environment node
/**
 * B3.2：两轮续接（同会话上下文）+ HTTP 断流取消。
 * 默认跳过（KYCLAW_KERNEL_E2E=1）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../agent/service'
import { KYCLAW_AGENT_ID } from '../../../shared/agent-id'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'

interface Stub {
  server: Server
  baseUrl: string
  bodies: string[]
  closedConnections: () => number
}

function startStub(options: { delayMs: number; texts: string[] }): Promise<Stub> {
  const bodies: string[] = []
  let closed = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url ?? '')) {
        res.writeHead(404).end('not found')
        return
      }
      bodies.push(body)
      const index = Math.min(bodies.length - 1, options.texts.length - 1)
      const text = options.texts[index] ?? ''
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        const send = (event: string, data: unknown): void => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_multi',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 }
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
          delta: { type: 'text_delta', text }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
        send('message_stop', { type: 'message_stop' })
        res.end()
      }, options.delayMs)
      res.on('close', () => {
        if (!res.writableEnded) {
          closed += 1
          clearTimeout(timer)
        }
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        bodies,
        closedConnections: () => closed
      })
    })
  })
}

async function startServer(stub: Stub): Promise<{ server: AgentServerHandle; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-b32-multi-'))
  const server = await startAgentServer({
    dataDir: dir,
    kernel: {
      electronExecutable: ELECTRON,
      asarPath: ASAR,
      extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl }
    }
  })
  return { server, dir }
}

async function chat(
  server: AgentServerHandle,
  text: string,
  signal?: AbortSignal
): Promise<{ status: number; frames: Record<string, unknown>[] }> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]
    }),
    ...(signal === undefined ? {} : { signal })
  })
  const frames: Record<string, unknown>[] = []
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const read = await reader?.read()
    if (read === undefined || read.done) break
    buffer += decoder.decode(read.value, { stream: true })
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          frames.push(JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>)
        } catch {
          // ignore
        }
      }
    }
  }
  return { status: response.status, frames }
}

describe.runIf(ENABLED)('B3.2 两轮续接 + 断流取消', () => {
  it('同一会话第二轮带上一轮上下文（stub 第二次请求包含第一轮回答）', async () => {
    const stub = await startStub({ delayMs: 0, texts: ['第一轮回答：记住 42。', '第二轮回答。'] })
    let started: { server: AgentServerHandle; dir: string } | undefined
    try {
      started = await startServer(stub)
      const first = await chat(started.server, '记住数字 42')
      expect(first.frames.some((frame) => frame.type === 'text-delta')).toBe(true)
      const second = await chat(started.server, '刚才的数字是多少？')
      expect(second.frames.some((frame) => frame.type === 'text-delta')).toBe(true)
      // 第二轮请求体里必须出现第一轮 assistant 文本（内核 session 上下文；中间可能夹标题生成请求）
      expect(stub.bodies.length).toBeGreaterThanOrEqual(2)
      expect(stub.bodies.slice(1).some((body) => body.includes('第一轮回答'))).toBe(true)
    } finally {
      await started?.server.stop()
      if (started)
        try {
          rmSync(started.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch {
          console.warn('[kyclaw] b3-2 temp cleanup deferred', started.dir)
        }
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
    }
  }, 180_000)

  it('客户端断流 → 内核取消（stub 看到连接被关），随后同服务还能跑下一轮', async () => {
    const stub = await startStub({ delayMs: 8_000, texts: ['慢回答（会被取消）', '取消后的回答'] })
    let started: { server: AgentServerHandle; dir: string } | undefined
    try {
      started = await startServer(stub)
      const controller = new AbortController()
      const pending = chat(started.server, '慢慢说', controller.signal).catch(() => null)
      await new Promise((resolve) => setTimeout(resolve, 500))
      controller.abort()
      await pending
      // 内核应把取消传给上游模型：stub 记录到连接关闭（而不是空等 8s）
      const deadline = Date.now() + 5_000
      while (stub.closedConnections() === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100))
      expect(stub.closedConnections()).toBeGreaterThan(0)
      // 取消结算后还能正常跑下一轮（没有卡死的 turn）
      const next = await chat(started.server, '继续')
      expect(next.frames.some((frame) => frame.type === 'text-delta')).toBe(true)
    } finally {
      await started?.server.stop()
      if (started)
        try {
          rmSync(started.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch {
          console.warn('[kyclaw] b3-2 temp cleanup deferred', started.dir)
        }
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
    }
  }, 180_000)
})
