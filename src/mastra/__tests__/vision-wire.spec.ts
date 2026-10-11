// @vitest-environment node
/**
 * 视觉路径的 **wire 级拆雷**（任务书模块 2 第 0 步）。
 *
 * 为什么必须有这一条：round 7 实测过"AI SDK file part 走真服务，服务端 200 但 provider 看不到内容"，
 * 于是当年附件退回"文本内联"。那一轮的 provider 是否支持视觉**没被测过**，所以"图片能不能真的
 * 到模型请求体"必须先证伪/证实 —— 不然就是做一个"能上传但模型看不见"的假链路。
 *
 * 这一条不碰真模型：假 OpenAI 兼容端点收下请求体原样记下来，真 server + 真 Chat 客户端发图片，
 * 断言**假端点收到的请求体里真有 image_url**。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'

/** 1x1 红点 PNG（真字节，不是占位串） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

/** 假端点收下的请求体（每次 POST /v1/chat/completions 追加一条） */
const requests: Array<Record<string, unknown>> = []

function sseBody(text: string): string {
  const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
  return (
    chunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'vision-probe',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
    }) +
    chunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'vision-probe',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }) +
    'data: [DONE]\n\n'
  )
}

let dir: string
let server: AgentServerHandle
let stub: Server
let stubPort = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-vision-wire-'))

  // 假 OpenAI 兼容端点：记下请求体，回一段合法 SSE（端点只要能收，回什么不重要）
  stub = createServer((request, response) => {
    if (request.method !== 'POST' || !(request.url ?? '').startsWith('/v1/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"not found"}}')
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>)
      } catch {
        requests.push({ raw: body })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sseBody('我看到了这张图。'))
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const address = stub.address()
  if (address === null || typeof address === 'string') throw new Error('假端点监听失败')
  stubPort = address.port

  // 真 provider（openai 兼容层），指向假端点
  const model = createOpenAICompatible({
    name: 'kyclaw-openai-compatible',
    baseURL: `http://127.0.0.1:${stubPort}/v1`,
    apiKey: 'stub-key'
  }).chatModel('vision-probe')

  server = await startAgentServer({ dataDir: dir, model, workspaces: () => [], projects: () => [] })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => stub?.close(() => resolve()))
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('视觉路径 wire（真 server + 真 Chat + 假端点）', () => {
  it('图片 file part 真的进到 provider 请求体（image_url）', async () => {
    requests.length = 0
    const chat = new Chat({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { Authorization: `Bearer ${server.token}` }
      })
    })

    await chat.sendMessage(
      {
        text: '这张图里是什么？',
        files: [{ type: 'file', mediaType: 'image/png', url: PNG_DATA_URL }]
      },
      { body: threadMemoryBody('thread-vision-wire') }
    )

    // 等这一轮收尾
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 30_000
      const tick = (): void => {
        if (chat.status === 'ready') return resolve()
        if (chat.status === 'error') return reject(chat.error ?? new Error('chat error'))
        if (Date.now() > deadline) return reject(new Error('等待收尾超时'))
        setTimeout(tick, 50)
      }
      tick()
    })

    expect(requests.length).toBeGreaterThan(0)
    const body = JSON.stringify(requests)
    // 请求体里必须真带图片内容
    expect(body).toContain('image_url')
    expect(body).toContain(PNG_BASE64)
    expect(body).toContain('这张图里是什么？')
  }, 60_000)
})
