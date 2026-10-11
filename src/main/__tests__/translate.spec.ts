// @vitest-environment node
/**
 * 主进程翻译（main/translate.ts，round 32）：一条 OpenAI 兼容的 `/chat/completions`。
 *
 * 用例全部打本地假翻译服务（127.0.0.1 随机端口）或注入假 fetch，零外部网络：
 * 验的是"请求真的发对了（端点/模型/提示词/Bearer）、四种失败真的翻成人话、回包不含密钥"，
 * 不是再对 fetch 做一遍测试。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { translatePrompt } from '../../shared/translate'
import { TRANSLATE_TIMEOUT_MS, translateText } from '../translate'

const KEY = 'sk-translate-7f3a-SECRET'

/** 假翻译服务的回包（llama.cpp 的形状：choices[0].message.content） */
function chatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'Index-Translate-2B',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 18, total_tokens: 68 }
  }
}

type RequestLog = { url?: string; authorization?: string; body: string }

const openServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close()
})

async function fakeService(
  onRequest: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ log: RequestLog[]; baseUrl: string }> {
  const log: RequestLog[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      log.push({ url: request.url, authorization: request.headers.authorization, body })
      onRequest(request, response)
    })
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
  return { log, baseUrl: `http://127.0.0.1:${port}/v1` }
}

const input = (baseUrl: string): Parameters<typeof translateText>[0] => ({
  text: 'Let me read the config first.',
  targetLanguage: '简体中文',
  baseUrl,
  model: 'Index-Translate-2B',
  apiKey: null
})

describe('translateText', () => {
  it('通的：打到 /v1/chat/completions，带上模型与那一条提示词，回译文', async () => {
    const service = await fakeService((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(chatCompletion('我先读一下配置。')))
    })

    const result = await translateText(input(service.baseUrl))

    expect(result).toEqual({ ok: true, text: '我先读一下配置。' })
    expect(service.log).toHaveLength(1)
    expect(service.log[0].url).toBe('/v1/chat/completions')
    // 本 LAN 服务不需要 key：没配就不带 Authorization 头
    expect(service.log[0].authorization).toBeUndefined()
    const body = JSON.parse(service.log[0].body) as {
      model: string
      temperature: number
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe('Index-Translate-2B')
    expect(body.temperature).toBe(0)
    expect(body.messages).toEqual([
      { role: 'user', content: translatePrompt('Let me read the config first.', '简体中文') }
    ])
  }, 30_000)

  it('配了 key 就带 Bearer；回包与错误文案都不含密钥', async () => {
    const service = await fakeService((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(chatCompletion('译文')))
    })

    const result = await translateText({ ...input(service.baseUrl), apiKey: KEY })

    expect(result.ok).toBe(true)
    expect(service.log[0].authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('非 2xx：翻成"翻译服务返回错误（HTTP 500）"，供应商回显的密钥不进文案', async () => {
    const service = await fakeService((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `boom with ${KEY}` } }))
    })

    const result = await translateText({ ...input(service.baseUrl), apiKey: KEY })

    expect(result).toEqual({ ok: false, message: '翻译服务返回错误（HTTP 500）' })
    expect(JSON.stringify(result)).not.toContain(KEY)
  }, 30_000)

  it('连不上：翻成"连不上翻译服务（端点）"，不带堆栈', async () => {
    // 127.0.0.1:1 上没有服务（立即拒绝，不挂住）
    const result = await translateText(input('http://127.0.0.1:1/v1'))

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('连不上翻译服务')
    expect(result.ok ? '' : result.message).toContain('http://127.0.0.1:1/v1/chat/completions')
  }, 30_000)

  it('掐住不响应：按 timeoutMs 超时（默认 60 秒）', async () => {
    const service = await fakeService(() => {
      /* 永不响应 */
    })

    const result = await translateText({ ...input(service.baseUrl), timeoutMs: 300 })

    expect(result).toEqual({ ok: false, message: '翻译服务响应超时（0 秒）' })
    expect(TRANSLATE_TIMEOUT_MS).toBe(60_000)
  }, 30_000)

  it('空响应：content 是空串 / 空白 → "没有返回内容"（不把半截响应当译文）', async () => {
    const service = await fakeService((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(chatCompletion('   ')))
    })

    expect(await translateText(input(service.baseUrl))).toEqual({
      ok: false,
      message: '翻译服务没有返回内容'
    })
  }, 30_000)

  it('回包不是 JSON / 结构不对（没有 choices）→ 各自一句人话', async () => {
    const notJson = await fakeService((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>hello</html>')
    })
    expect(await translateText(input(notJson.baseUrl))).toEqual({
      ok: false,
      message: '翻译服务的响应不是 JSON：这个地址不是 OpenAI 兼容接口？'
    })

    const noChoices = await fakeService((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'chat.completion', choices: [] }))
    })
    expect(await translateText(input(noChoices.baseUrl))).toEqual({
      ok: false,
      message: '翻译服务没有返回内容'
    })
  }, 30_000)

  it('content 是 parts 数组 / 只有 choices[0].text 也能取到译文（防御解析）', async () => {
    const parts = await fakeService((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: '译文' }] } }]
        })
      )
    })
    expect(await translateText(input(parts.baseUrl))).toEqual({ ok: true, text: '译文' })

    const legacy = await fakeService((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ text: ' 旧格式译文 ' }] }))
    })
    expect(await translateText(input(legacy.baseUrl))).toEqual({ ok: true, text: '旧格式译文' })
  }, 30_000)
})
