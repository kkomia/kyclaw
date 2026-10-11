// @vitest-environment node
/**
 * 极小 MCP 客户端（round 45）的单测：**stub HTTP 注入，不真连网**。
 * 盯的点就是任务书列的那几条：SSE 与纯 JSON 两种响应都认、会话复用、
 * 会话失效（404）自动重建一次、超时、失败重试一次、错误一律中性人话。
 */
import { describe, expect, it } from 'vitest'
import {
  createMcpClient,
  mcpResultIsError,
  mcpResultText,
  readJsonRpcMessage,
  SearchTransportError,
  type McpToolRequest
} from '../mcp-client'

const ENDPOINT = 'https://mcp.example.test/mcp'

interface StubRequest {
  method: string
  session: string | undefined
  accept: string | undefined
  authorization: string | undefined
  body: Record<string, unknown>
  signal: AbortSignal | null | undefined
}

/** 注入式 fetch：每条请求交给用例自己的 handler，并把调用序列记下来 */
function stubFetch(handler: (request: StubRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: StubRequest[]
} {
  const calls: StubRequest[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const request: StubRequest = {
      method: typeof body.method === 'string' ? body.method : '',
      session: headers['mcp-session-id'],
      accept: headers.accept,
      authorization: headers.authorization,
      body,
      signal: init?.signal
    }
    void input
    calls.push(request)
    return await handler(request)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** 一次标准 initialize 回包（带 session 头） */
function initResponse(session = 'session-1'): Response {
  return new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2024-11-05', serverInfo: { name: 'stub' } }
    })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': session } }
  )
}

/** tools/call 的 SSE 回包（内容 = 一段工具文本） */
function toolResponse(text: string, status = 200): Response {
  return new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text }] }
    })}\n\n`,
    { status, headers: { 'content-type': 'text/event-stream' } }
  )
}

const request: McpToolRequest = {
  endpoint: ENDPOINT,
  tool: 'web_search_exa',
  args: { query: 'x', numResults: 3 }
}

const deps = { retryDelayMs: 0 }

describe('createMcpClient：协议与解析', () => {
  it('SSE：initialize → notifications/initialized → tools/call 三步走通；Accept 两档都要', async () => {
    const { fetchImpl, calls } = stubFetch((received) => {
      if (received.method === 'initialize') return initResponse()
      if (received.method === 'notifications/initialized') return new Response('', { status: 202 })
      return toolResponse('Title: A\nURL: https://a.test\nHighlights:\n正文')
    })
    const client = createMcpClient({ fetchImpl, ...deps })

    const result = await client.callTool(request)

    expect(mcpResultText(result)).toContain('Title: A')
    expect(calls.map((call) => call.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call'
    ])
    // 会话头只在 initialize 之后带上（initialize 自己不带）
    expect(calls[0].session).toBeUndefined()
    expect(calls[2].session).toBe('session-1')
    expect(calls[0].accept).toContain('application/json')
    expect(calls[0].accept).toContain('text/event-stream')
    expect((calls[2].body.params as { name: string }).name).toBe('web_search_exa')
  })

  it('纯 JSON 响应同样认（自建 MCP server 常见）', async () => {
    const { fetchImpl } = stubFetch((received) => {
      if (received.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 's-json' }
        })
      }
      if (received.method === 'notifications/initialized')
        return new Response(null, { status: 202 })
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: 'json-body' }] }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const client = createMcpClient({ fetchImpl, ...deps })

    expect(mcpResultText(await client.callTool(request))).toBe('json-body')
  })

  it('会话复用：第二次调用不再 initialize', async () => {
    const { fetchImpl, calls } = stubFetch((received) => {
      if (received.method === 'initialize') return initResponse('session-keep')
      if (received.method === 'notifications/initialized')
        return new Response(null, { status: 202 })
      return toolResponse('ok')
    })
    const client = createMcpClient({ fetchImpl, ...deps })

    await client.callTool(request)
    await client.callTool(request)

    expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(1)
    expect(client.sessionCount()).toBe(1)
  })

  it('会话失效（tools/call 回 404）：丢掉缓存重建一次，第二次成功', async () => {
    let toolCalls = 0
    const { fetchImpl, calls } = stubFetch((received) => {
      if (received.method === 'initialize') return initResponse(`session-${calls.length}`)
      if (received.method === 'notifications/initialized')
        return new Response(null, { status: 202 })
      toolCalls += 1
      return toolCalls === 1 ? new Response('gone', { status: 404 }) : toolResponse('回来了')
    })
    const client = createMcpClient({ fetchImpl, ...deps })

    const result = await client.callTool(request)
    expect(mcpResultText(result)).toBe('回来了')
    expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(2)
    expect(calls.filter((call) => call.method === 'tools/call')).toHaveLength(2)
  })

  it('5xx 重试一次（退避后重建会话）', async () => {
    let toolCalls = 0
    const { fetchImpl, calls } = stubFetch((received) => {
      if (received.method === 'initialize') return initResponse()
      if (received.method === 'notifications/initialized')
        return new Response(null, { status: 202 })
      toolCalls += 1
      return toolCalls === 1 ? new Response('boom', { status: 503 }) : toolResponse('好了')
    })
    const client = createMcpClient({ fetchImpl, ...deps })

    expect(mcpResultText(await client.callTool(request))).toBe('好了')
    expect(calls.filter((call) => call.method === 'tools/call')).toHaveLength(2)
  })
})

describe('createMcpClient：错误人话与重试边界', () => {
  it('超时：中性人话（带秒数），且只重试一次后抛出', async () => {
    let attempts = 0
    const { fetchImpl } = stubFetch((received) => {
      if (received.method !== 'initialize') return new Response(null, { status: 202 })
      attempts += 1
      return new Promise<Response>((_resolve, reject) => {
        received.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
        })
      })
    })
    const client = createMcpClient({ fetchImpl, connectTimeoutMs: 20, totalTimeoutMs: 20, ...deps })

    await expect(client.callTool(request)).rejects.toThrow(/搜索服务响应超时/)
    expect(attempts).toBe(2)
  })

  it('429：限流人话（不可重试，只打一次）', async () => {
    let calls = 0
    const { fetchImpl } = stubFetch(() => {
      calls += 1
      return new Response('slow down', { status: 429 })
    })
    const client = createMcpClient({ fetchImpl, ...deps })

    const error = await client.callTool(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SearchTransportError)
    expect((error as SearchTransportError).message).toBe('搜索服务限流了（免费档有速率限制）')
    expect((error as SearchTransportError).retryable).toBe(false)
    expect(calls).toBe(1)
  })

  it('401：Key 有问题的人话（不可重试）', async () => {
    const { fetchImpl } = stubFetch(() => new Response('no', { status: 401 }))
    const client = createMcpClient({ fetchImpl, ...deps })

    await expect(client.callTool(request)).rejects.toThrow(/拒绝了这把 Key/)
  })

  it('网络层错误：人话 + 重试一次', async () => {
    let calls = 0
    const { fetchImpl } = stubFetch(() => {
      calls += 1
      throw new TypeError('fetch failed')
    })
    const client = createMcpClient({ fetchImpl, ...deps })

    await expect(client.callTool(request)).rejects.toThrow(/连不上搜索服务/)
    expect(calls).toBe(2)
  })

  it('JSON-RPC error（会话类）→ 可重试；非会话类 → 不可重试且是人话', async () => {
    let toolCalls = 0
    const sessionish = stubFetch((received) => {
      if (received.method === 'initialize') return initResponse()
      if (received.method === 'notifications/initialized')
        return new Response(null, { status: 202 })
      toolCalls += 1
      if (toolCalls === 1) {
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'Session not found' } })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      }
      return toolResponse('重建好了')
    })
    const client = createMcpClient({ fetchImpl: sessionish.fetchImpl, ...deps })
    expect(mcpResultText(await client.callTool(request))).toBe('重建好了')

    const broken = stubFetch((received) => {
      if (received.method === 'initialize') return initResponse()
      if (received.method === 'notifications/initialized')
        return new Response(null, { status: 202 })
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad params' } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const client2 = createMcpClient({ fetchImpl: broken.fetchImpl, ...deps })
    await expect(client2.callTool(request)).rejects.toThrow('搜索服务返回了错误')
    expect(broken.calls.filter((call) => call.method === 'tools/call')).toHaveLength(1)
  })
})

describe('readJsonRpcMessage / 结果助手', () => {
  it('多事件取最后一条带 result / error 的；坏数据块跳过', async () => {
    const response = new Response(
      `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n` +
        `data: {坏}\n\n` +
        `data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
    const message = await readJsonRpcMessage(response)
    expect(message.id).toBe(2)
  })

  it('mcpResultText 拼多个 text 块；mcpResultIsError 认 isError', () => {
    const result = {
      content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]
    }
    expect(mcpResultText(result)).toBe('a\nb')
    expect(mcpResultIsError(result)).toBe(false)
    expect(mcpResultIsError({ isError: true, content: [] })).toBe(true)
    expect(mcpResultText(undefined)).toBe('')
  })
})
