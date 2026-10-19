import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelAskUser, fetchPendingAskUser } from '../ask-user-api'
import { transportFor } from '../agent'

vi.mock('../agent', async (original) => ({
  ...(await original<typeof import('../agent')>()),
  resolveAgentEndpoint: async () => ({ baseUrl: 'http://localhost:1234', token: 'test-token' })
}))
afterEach(() => vi.unstubAllGlobals())
describe('AskUser API and transport', () => {
  it('pending 编码会话，Bearer 认证，不把 token 放 URL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pending: [] })))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchPendingAskUser('a/b')).toEqual([])
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:1234/ask-user/pending?threadId=a%2Fb')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token')
  })
  it('拒绝格式错误和 HTTP 错误，取消发送明确目标', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{}', { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'cancelled', runIds: ['run'] })))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchPendingAskUser('thread')).rejects.toThrow('回包格式不对')
    await expect(cancelAskUser('thread')).rejects.toThrow('409')
    expect(await cancelAskUser('thread', 'run')).toEqual(['run'])
    expect(fetch.mock.calls[2][0]).toBe('http://localhost:1234/ask-user/cancel')
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ threadId: 'thread', runId: 'run' })
  })
  it('resume 使用 SDK transport 路由和 SSE 解码，request 不夹带消息或内部标记', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('data: {"type":"finish"}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      })
    )
    vi.stubGlobal('fetch', fetch)
    const body = {
      threadId: 'thread',
      runId: 'run',
      toolCallId: 'tool',
      resumeData: { status: 'answered', answers: [] }
    }
    const transport = transportFor({ baseUrl: 'http://localhost:1234', token: 'test-token' })
    const stream = await transport.sendMessages({
      chatId: 'thread',
      messageId: undefined,
      abortSignal: undefined,
      messages: [],
      trigger: 'submit-message',
      body: { askUserResume: body }
    })
    const reader = stream.getReader()
    expect((await reader.read()).value).toMatchObject({ type: 'finish' })
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:1234/ask-user/resume')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body)
  })
})
