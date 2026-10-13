// @vitest-environment node
/**
 * R68 探针 C：render_ppt 的页图**真的进到 provider 请求体**吗（真 agent 装配 + 真渲染 + 假端点）。
 *
 * 为什么必须有这一条：单测只能证明我们交出了 AI SDK 认的 `file` 形状；**证不了**它穿过 Mastra 的
 * 工具循环与 openai 兼容层之后还是图。实测踩过的雷（`.superpowers/sdd/.../_r68-probe/tool-image-shapes.mjs`）：
 *   - `{type:'image-url'}` 这个形状在 AI SDK 7 上会抛 `Invalid URL`（它已被废弃）；
 *   - 正确的形状是 `{type:'file', mediaType:'image/png', data:{type:'url', url:'data:image/png;base64,…'}}`
 *     —— AI SDK 把它翻成 tool 消息 content 数组里的 `image_url`。
 * 这一条把"正确形状 + 真 Mastra 装配"钉在一起：假端点收到的**第二次**请求里必须真有 `image_url`
 * 与 PNG 的 base64 头。
 *
 * 依赖真渲染器（随包 LibreOffice 优先，其次 PowerPoint COM）：两条都没有就**跳过**（不是失败）
 * ——退化路径由 `render-ppt.spec.ts` 钉。
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { startAgentServer, type AgentServerHandle } from '../../agent/service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { detectRenderer } from '../../../mastra/tools/render-ppt'
import { renderPptx } from '../../../mastra/tools/ppt'
import { threadMemoryBody } from '../../../shared/threads'

/** 假端点收下的请求体 */
const requests: Array<Record<string, unknown>> = []

/** 1x1 PNG 的 base64 头（断言"图真在里面"用的特征串） */
const PNG_HEAD = 'iVBORw0KGgo'

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 第一轮：让模型去调 render_ppt；之后：正常收尾 */
function sseBody(round: number): string {
  if (round === 1) {
    return (
      sseChunk({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'vision-probe',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-render',
                  type: 'function',
                  function: { name: 'render_ppt', arguments: '{"path":"日报.pptx"}' }
                }
              ]
            },
            finish_reason: null
          }
        ]
      }) +
      sseChunk({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'vision-probe',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }) +
      'data: [DONE]\n\n'
    )
  }
  return (
    sseChunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'vision-probe',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '我看过这份 PPT 了。' },
          finish_reason: null
        }
      ]
    }) +
    sseChunk({
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

const renderer = detectRenderer()
/** 有渲染器（随包 LibreOffice 或 PowerPoint COM）才跑主用例；探测说 `'none'` 就跳过 */
const hasRenderer = renderer !== 'none'

let dir: string
let ws: string
let server: AgentServerHandle
let stub: Server
let rounds = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-r68-vision-tool-'))
  ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })

  // 真 pptx（用产出物自己的渲染器造）：PowerPoint 要能打开它，所以不能是手搓的假 zip
  const deck = await renderPptx({
    title: '今日新闻日报',
    slides: [
      { title: '国内要闻', bullets: ['PSL 利率下调 0.25 个百分点'] },
      { title: '关键指标', stats: [{ value: '182.3 万辆', label: '9 月新能源车销量' }] }
    ]
  })
  writeFileSync(join(ws, '日报.pptx'), deck.data)

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
      rounds += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sseBody(rounds))
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const address = stub.address()
  if (address === null || typeof address === 'string') throw new Error('假端点监听失败')

  // **必须是生产那条 provider 路径**：`https://api.deepseek.com` 在 buildLanguageModel 里走
  // `@ai-sdk/deepseek`（不是通用兼容层）。这条差别是实测踩出来的 —— 通用兼容层
  // （@ai-sdk/openai-compatible）默认 `supportsMultiPartToolContent: false`，tool 结果里的图会被
  // `JSON.stringify` 成字符串（模型只看到一串 base64 文本）；deepseek 官方包内建支持多段 tool 内容。
  const model = createDeepSeek({
    apiKey: 'stub-key',
    baseURL: `http://127.0.0.1:${address.port}/v1`
  }).chat('deepseek-flash')

  server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => [{ path: ws, mode: 'full' }],
    projects: () => []
  })
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => stub?.close(() => resolve()))
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] r68 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
  }
})

describe('render_ppt 的页图进 provider（真 agent + 真渲染 + 假端点）', () => {
  it.skipIf(!hasRenderer)(
    '第二次请求的 tool 消息里真有 image_url 与 PNG base64',
    async () => {
      const chat = new Chat({
        transport: new DefaultChatTransport({
          api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
          headers: { Authorization: `Bearer ${server.token}` }
        })
      })

      await chat.sendMessage(
        { text: '看看你刚做的 PPT 好不好。' },
        { body: threadMemoryBody('thread-r68-vision-tool') }
      )

      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 150_000
        const tick = (): void => {
          if (chat.status === 'ready') return resolve()
          if (chat.status === 'error') return reject(chat.error ?? new Error('chat error'))
          if (Date.now() > deadline) return reject(new Error('等待收尾超时'))
          setTimeout(tick, 50)
        }
        tick()
      })

      // 第一轮是"模型要调 render_ppt"，第二轮才是我们真正要看的请求
      expect(requests.length).toBeGreaterThanOrEqual(2)

      const toolMessages = requests
        .flatMap((request) => (request.messages ?? []) as Array<Record<string, unknown>>)
        .filter((message) => message.role === 'tool')
      expect(toolMessages.length).toBeGreaterThan(0)

      // 工具结果里带图 —— 这是整件事的前提：模型**拿到了**渲染出来的页图
      const withImages = toolMessages.filter(
        (message) =>
          Array.isArray(message.content) &&
          JSON.stringify(message.content).includes('"type":"image_url"')
      )
      expect(withImages.length).toBeGreaterThan(0)
      expect(JSON.stringify(withImages[0].content)).toContain(PNG_HEAD)
    },
    180_000
  )

  it.skipIf(hasRenderer)('本机没有渲染器时这一条会被跳过（本机实测结论见报告）', () => {
    expect(renderer).toBe('none')
  })
})
