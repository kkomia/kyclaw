import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ServerResponse } from 'node:http'
import type { UIMessage, UIMessageChunk } from 'ai'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import {
  askUserAcceptedMetadata,
  getTransport,
  resolveAgentEndpoint,
  threadRequestOptions,
  transportFor
} from '@renderer/lib/agent'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'

/**
 * getTransport（T7 传输裁决）：先经 IPC 等 agent 端点（baseUrl + token），再用 Bearer 头
 * POST 到 chat 路由。这里用假 fetch 模拟 chatRoute 的 SSE 响应——不碰网络，但走的是
 * DefaultChatTransport 的真解析路径（URL / 头 / body / SSE 解帧）。
 */
const SSE_BODY = [
  'data: {"type":"text-start","id":"t1"}',
  '',
  'data: {"type":"text-delta","id":"t1","delta":"你好"}',
  '',
  'data: [DONE]',
  '',
  ''
].join('\n')

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return chunks
}

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('getTransport', () => {
  it('取端点在先：每次调用都等 endpoint() 的结果，再拼出 chat 路由', async () => {
    installKyclawBridge()
    const endpoint = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:39001', token: 'tok-1' }))
    window.kyclaw.agent.endpoint = endpoint
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
    )

    await getTransport()

    expect(endpoint).toHaveBeenCalledTimes(1)
  })

  it('桥不在（主进程没起 / 没装 kyclaw）时是**异步**失败：同步抛会从 effect 里炸出去把整页带崩', async () => {
    // 这条钉的是形状而不是内容：`resolveAgentEndpoint` 必须是 async ——
    // `window.kyclaw` 不存在时那一下要变成 rejected promise（交给 ChatPage 的 .catch 落错误卡），
    // 不能同步抛（同步抛会从 effect 里穿出去，App 直接白页；routes.spec / app.spec 就是这么钉的）。
    clearKyclawBridge()

    let promise: Promise<unknown> | null = null
    expect(() => {
      promise = resolveAgentEndpoint()
    }).not.toThrow()
    await expect(promise).rejects.toThrow()
  })

  it('带 Bearer token POST 到 /chat/kyclaw-agent，并把 SSE 解成 chunk', async () => {
    installKyclawBridge()
    window.kyclaw.agent.endpoint = async () => ({
      baseUrl: 'http://127.0.0.1:39002',
      token: 'tok-2'
    })
    const fetchMock = vi.fn(
      async () =>
        new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const transport = await getTransport()
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '你好' }] }
    ]
    const stream = await transport.sendMessages({
      chatId: 'chat-1',
      messages,
      abortSignal: undefined,
      trigger: 'submit-message',
      messageId: undefined
    })

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('http://127.0.0.1:39002/chat/kyclaw-agent')
    expect(call[1].method).toBe('POST')
    expect(new Headers(call[1].headers).get('authorization')).toBe('Bearer tok-2')
    expect(JSON.parse(String(call[1].body))).toMatchObject({
      id: 'chat-1',
      trigger: 'submit-message',
      messages
    })

    const chunks = await drain(stream)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 't1', delta: '你好' }
    ])
  })
})

describe('transportFor：提问续跑请求的「服务端已接收」边界（0.1.2 / 001）', () => {
  /**
   * 受控 HTTP 服务（真 TCP + 真 fetch，不是 stub）：请求体收齐后交给用例，**响应头由用例决定
   * 什么时候写、body 什么时候交付** —— 钉的就是这两个时刻之间的区别：
   * "服务端收下了这次恢复请求"（响应到手）与"这一轮跑完了"（body 读完）。
   */
  async function serve(
    respond: (res: ServerResponse, request: { url: string; body: string }) => void
  ): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const server = createServer((request, res) => {
      let body = ''
      request.on('data', (piece: Buffer) => {
        body += piece.toString('utf8')
      })
      request.on('end', () => respond(res, { url: request.url ?? '', body }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  const resumeBody = { threadId: 't', runId: 'r', toolCallId: 'c' }

  it('响应到手就回调「已接收」：body 一个字节都还没写，更没等流结束', async () => {
    const accepted: string[] = []
    const seen: Array<{ url: string; body: string }> = []
    let sent = false
    let deliver!: () => void
    const server = await serve((res, request) => {
      seen.push(request)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 头立刻出去、body 挂着：真链路里 fetch 就是在这一刻 resolve 的
      res.flushHeaders()
      deliver = () => {
        sent = true
        res.end(
          [
            'data: {"type":"text-start","id":"t1"}',
            '',
            'data: {"type":"text-delta","id":"t1","delta":"好"}',
            '',
            'data: [DONE]',
            '',
            ''
          ].join('\n')
        )
      }
    })
    try {
      const transport = transportFor({ baseUrl: server.baseUrl, token: 'tok-3' })
      const stream = await transport.sendMessages({
        chatId: 'chat-1',
        messages: [],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
        body: { askUserResume: resumeBody },
        metadata: askUserAcceptedMetadata(() => accepted.push('accepted'))
      })

      // 一：回调已经响过，而服务端连一个 body 字节都还没交出来
      expect(accepted).toEqual(['accepted'])
      expect(sent).toBe(false)

      // 二：路由与请求体仍是既有协议 —— resume 那一路打到 /ask-user/resume，body 整份就是它，
      // metadata（回执通道）不上线
      expect(seen).toHaveLength(1)
      expect(seen[0].url).toBe('/ask-user/resume')
      expect(JSON.parse(seen[0].body)).toEqual(resumeBody)

      // 三：流还没被消费 —— 现在交付 body，照常解出 chunk（没有 tee / 没有丢帧）
      deliver()
      const chunks = await drain(stream)
      expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
        { type: 'text-delta', id: 't1', delta: '好' }
      ])
      // 四：一次请求只响一次（流结束不会再补响一遍）
      expect(accepted).toEqual(['accepted'])
    } finally {
      await server.close()
    }
  })

  it('非 2xx（409 stale-run）不回调：rejection 如实上抛，不拿"点击即成功"糊过去', async () => {
    const accepted: string[] = []
    const server = await serve((res) => {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: '409 stale-run' }))
    })
    try {
      const transport = transportFor({ baseUrl: server.baseUrl, token: 'tok-4' })
      const failure = await transport
        .sendMessages({
          chatId: 'chat-1',
          messages: [],
          abortSignal: undefined,
          trigger: 'submit-message',
          messageId: undefined,
          body: { askUserResume: resumeBody },
          metadata: askUserAcceptedMetadata(() => accepted.push('accepted'))
        })
        .then(
          () => null,
          (error: unknown) => error as { statusCode?: number; message?: string }
        )

      expect(failure?.statusCode).toBe(409)
      expect(failure?.message).toContain('409 stale-run')
      expect(accepted).toEqual([])
    } finally {
      await server.close()
    }
  })
})

describe('threadRequestOptions（round 18：思考挡位真透传进请求体）', () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('选了挡位（DeepSeek 官方端点）→ body.providerOptions.deepseek.reasoningEffort', () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        providers: [
          {
            id: 'ds',
            type: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-v4-pro',
            isDefault: true
          }
        ],
        modelPrefs: { 'ds/deepseek-v4-pro': { thinkingEffort: 'high' } }
      },
      loaded: true
    })

    expect(threadRequestOptions('t1')).toEqual({
      body: {
        memory: { thread: 't1', resource: expect.any(String) },
        providerOptions: { deepseek: { reasoningEffort: 'high' } }
      }
    })
  })

  it('默认挡 / 没配 provider → 不带 providerOptions（不假装生效）', () => {
    useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
    expect(threadRequestOptions('t1')).toEqual({
      body: { memory: { thread: 't1', resource: expect.any(String) } }
    })
  })

  it('round 22：没显式选过挡位时用 probed 的 default_level（deepseek-flash 实测 = high）', () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        providers: [
          {
            id: 'ds',
            type: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            isDefault: true
          }
        ],
        probedModels: {
          'ds:deepseek-flash': {
            contextWindow: 1_048_576,
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
            fetchedAt: '2026-10-11T00:00:00.000Z'
          }
        }
      },
      loaded: true
    })

    expect(threadRequestOptions('t1')).toEqual({
      body: {
        memory: { thread: 't1', resource: expect.any(String) },
        providerOptions: { deepseek: { reasoningEffort: 'high' } }
      }
    })
  })

  it('round 22：显式选的挡位优先于 probed 默认档（probed.defaultEffort 只当初始档）', () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        providers: [
          {
            id: 'ds',
            type: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            isDefault: true
          }
        ],
        modelPrefs: { 'ds/deepseek-flash': { thinkingEffort: 'max' } },
        probedModels: {
          'ds:deepseek-flash': {
            contextWindow: 1_048_576,
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
            fetchedAt: '2026-10-11T00:00:00.000Z'
          }
        }
      },
      loaded: true
    })

    expect(threadRequestOptions('t1')).toEqual({
      body: {
        memory: { thread: 't1', resource: expect.any(String) },
        providerOptions: { deepseek: { reasoningEffort: 'max' } }
      }
    })
  })
})
