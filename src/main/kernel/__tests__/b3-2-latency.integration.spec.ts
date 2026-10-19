// @vitest-environment node
/**
 * B3.2 · 首字延迟实测（**同一 HTTP stub、同一机器、各 3 次取中位**）。
 *
 * 旧路径 = 当前 Mastra chat（flag 关），模型指向 stub 的 OpenAI 兼容端点；
 * 新路径 = 内核 adapter（flag 开），同一 stub 的 Anthropic Messages 端点。
 * stub 收到请求后**统一延迟 300ms 再发第一个文本 token**，两条路的"模型首 token"条件一致；
 * 度量 = 从 fetch 开始到 SSE 里读到第一条 `text-delta` 的墙钟毫秒。
 *
 * 开启同其它内核集成 spec（KYCLAW_KERNEL_E2E=1 + electron/asar 路径）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../agent/service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'
const DELAY_MS = 300
const TEXT = '延迟测量回答。'

/** 同一条 stub：OpenAI chat-completions（旧路径） + Anthropic messages（新路径），首 token 都延迟 DELAY_MS */
function startStub(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    req.on('end', () => {
      void body
      const url = req.url ?? ''
      if (
        req.method !== 'POST' ||
        (!url.includes('/v1/messages') && !url.includes('/chat/completions'))
      ) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const write = (data: string): void => {
        res.write(data)
      }
      const anthropic = url.includes('/v1/messages')
      if (anthropic) {
        write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_latency',
              type: 'message',
              role: 'assistant',
              model: 'deepseek-flash',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 12, output_tokens: 1 }
            }
          })}\n\n`
        )
      } else {
        write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-latency',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'deepseek-flash',
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
          })}\n\n`
        )
      }
      setTimeout(() => {
        if (anthropic) {
          write(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' }
            })}\n\n`
          )
          write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: TEXT }
            })}\n\n`
          )
          write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
          write(
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 8 }
            })}\n\n`
          )
          write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          res.end()
          return
        }
        write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-latency',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'deepseek-flash',
            choices: [{ index: 0, delta: { content: TEXT }, finish_reason: null }]
          })}\n\n`
        )
        write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-latency',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'deepseek-flash',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`
        )
        write('data: [DONE]\n\n')
        res.end()
      }, DELAY_MS)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({ server, baseUrl: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

async function firstDeltaMs(baseUrl: string, token: string): Promise<number> {
  const started = performance.now()
  const response = await fetch(`${baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'say hi' }] }]
    })
  })
  if (response.status !== 200 || response.body === null)
    throw new Error(`chat HTTP ${String(response.status)}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:') && line.includes('"text-delta"')) {
        await reader.cancel()
        return Math.round(performance.now() - started)
      }
    }
  }
  throw new Error('no text-delta in stream; first bytes=' + buffer.slice(0, 800))
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
}

let stub: { server: Server; baseUrl: string }
const dirs: string[] = []

async function startOldServer(): Promise<AgentServerHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'kyclaw-lat-old-'))
  dirs.push(dataDir)
  return startAgentServer({
    dataDir,
    resolveModel: async () => {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
      return createOpenAICompatible({ name: 'latency-stub', baseURL: stub.baseUrl }).chatModel(
        'deepseek-flash'
      )
    }
  })
}

async function startNewServer(): Promise<AgentServerHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'kyclaw-lat-new-'))
  dirs.push(dataDir)
  const previous = process.env.KYCLAW_KERNEL_PORT
  process.env.KYCLAW_KERNEL_PORT = '1'
  try {
    return await startAgentServer({
      dataDir,
      kernel: {
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl }
      }
    })
  } finally {
    if (previous === undefined) delete process.env.KYCLAW_KERNEL_PORT
    else process.env.KYCLAW_KERNEL_PORT = previous
  }
}

describe.runIf(ENABLED)('B3.2 首字延迟（旧 vs 新，各 3 次中位）', () => {
  beforeAll(async () => {
    stub = await startStub()
  }, 30_000)

  afterAll(async () => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] latency temp cleanup deferred', dir)
      }
    }
    await new Promise<void>((resolve) => {
      stub.server.close(() => {
        resolve()
      })
    })
  })

  it('新路径首字延迟与旧路径同级（同 stub、300ms 注入延迟）', async () => {
    const oldServer = await startOldServer()
    let newServer: AgentServerHandle | undefined
    try {
      newServer = await startNewServer()
      const oldRuns: number[] = []
      const newRuns: number[] = []
      for (let round = 0; round < 3; round += 1) {
        // 预热一次，避免首请求连接池/进程冷启动混进测量
        if (round === 0) {
          await firstDeltaMs(oldServer.baseUrl, oldServer.token)
          await firstDeltaMs(newServer.baseUrl, newServer.token)
        }
        oldRuns.push(await firstDeltaMs(oldServer.baseUrl, oldServer.token))
        newRuns.push(await firstDeltaMs(newServer.baseUrl, newServer.token))
      }
      const oldMedian = median(oldRuns)
      const newMedian = median(newRuns)
      console.log(
        `\n[latency] stub delay=${String(DELAY_MS)}ms  old=${oldRuns.join(',')} median=${String(oldMedian)}ms` +
          `  new=${newRuns.join(',')} median=${String(newMedian)}ms`
      )
      expect(newMedian).toBeLessThanOrEqual(oldMedian + 200)
    } finally {
      await newServer?.stop()
      await oldServer.stop()
    }
  }, 300_000)
})
