import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { getTransport } from '@renderer/lib/agent'

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
