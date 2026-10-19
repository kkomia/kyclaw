// @vitest-environment node
/**
 * B3.1b：chat 路由内核分支的**纯函数/处理器**测试（不需要真内核）。
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createKernelChatHandler, lastUserText } from '../kernel-chat'
import type { KernelAdapter } from '../kernel-adapter'
import type { RendererSseFrame } from '../sse-map'

function fakeAdapter(
  frames: RendererSseFrame[],
  options: { fail?: Error } = {}
): { adapter: KernelAdapter; seen: string[] } {
  const seen: string[] = []
  const adapter: KernelAdapter = {
    sessionId: 'session-test',
    pid: 1,
    port: 1,
    async startTurn(text, startOptions = {}) {
      seen.push(text)
      if (options.fail !== undefined) throw options.fail
      for (const frame of frames) startOptions.onFrame?.(frame)
      return {
        frames,
        sse: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
        text: frames.flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : [])).join('')
      }
    },
    async cancelTurn() {
      await Promise.resolve()
    },
    async stop() {
      await Promise.resolve()
    }
  }
  return { adapter, seen }
}

describe('kernel-chat：真实 HTTP 形状', () => {
  it('lastUserText：取最后一条 user 的文本 parts（忽略 assistant）', () => {
    expect(
      lastUserText({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: '第一句' }] },
          { role: 'assistant', parts: [{ type: 'text', text: '回答' }] },
          { role: 'user', parts: [{ type: 'text', text: '第二句' }] }
        ]
      })
    ).toBe('第二句')
    expect(lastUserText({ messages: [] })).toBeNull()
    expect(
      lastUserText({ messages: [{ role: 'user', parts: [{ type: 'text', text: ' ' }] }] })
    ).toBeNull()
  })

  it('POST /chat 返回 text/event-stream；帧原样（data: 前缀）', async () => {
    const { adapter, seen } = fakeAdapter([
      { type: 'start', messageId: 'kernel-x' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: '你好' },
      { type: 'text-end', id: 'text-0' },
      { type: 'finish', finishReason: 'stop' }
    ])
    const app = new Hono()
    app.post('/chat/kyclaw', createKernelChatHandler(adapter))

    const response = await app.request('/chat/kyclaw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: '嗨' }] }]
      })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('data: {"type":"text-delta","id":"text-0","delta":"你好"}')
    expect(seen).toEqual(['嗨'])
  })

  it('adapter 失败 → 200 + SSE error 帧（renderer 仍能按流读）', async () => {
    const { adapter } = fakeAdapter([], { fail: new Error('boom') })
    const app = new Hono()
    app.post('/chat/kyclaw', createKernelChatHandler(adapter))
    const response = await app.request('/chat/kyclaw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: '嗨' }] }] })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"error"')
  })
})
