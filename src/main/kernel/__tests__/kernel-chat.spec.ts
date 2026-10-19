// @vitest-environment node
/**
 * B3.1b：chat 路由内核分支的**纯函数/处理器**测试（不需要真内核）。
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createKernelChatHandler, lastUserText, threadIdFromBody } from '../kernel-chat'
import type { KernelAdapter, KernelTurnResult } from '../kernel-adapter'
import type { RendererSseFrame } from '../sse-map'

function fakeAdapter(
  frames: RendererSseFrame[],
  options: { fail?: Error; hang?: boolean } = {}
): {
  adapter: KernelAdapter
  seen: string[]
  threadIds: Array<string | undefined>
  cancels: Array<string | undefined>
} {
  const seen: string[] = []
  const threadIds: Array<string | undefined> = []
  const cancels: Array<string | undefined> = []
  const adapter: KernelAdapter = {
    sessionId: 'session-test',
    defaultSessionId: 'session-test',
    pid: 1,
    port: 1,
    async startTurn(text, startOptions = {}) {
      seen.push(text)
      threadIds.push(startOptions.threadId)
      if (options.fail !== undefined) throw options.fail
      for (const frame of frames) startOptions.onFrame?.(frame)
      if (options.hang === true) {
        // 一轮还没收口：让「下游断开」的取消路径可测
        return new Promise<KernelTurnResult>(() => {})
      }
      return {
        frames,
        sse: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
        text: frames.flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : [])).join('')
      }
    },
    async listCommands() {
      return [{ name: 'goal' }]
    },
    async executeCommand() {
      return { ok: true }
    },
    async readGoalState() {
      return null
    },
    async readPlanState() {
      return null
    },
    async listKernelSessions() {
      return []
    },
    async reattach() {
      return {}
    },
    async rpcCall<T = unknown>(): Promise<T> {
      return {} as T
    },
    async respondInteraction() {
      await Promise.resolve()
    },
    async answerContinuedQuestion() {
      return false
    },
    async cancelTurn(threadId) {
      cancels.push(threadId)
      await Promise.resolve()
    },
    async stop() {
      await Promise.resolve()
    }
  }
  return { adapter, seen, threadIds, cancels }
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

describe('kernel-chat：B3.4 threadId 透传（body.memory.thread = 内核 sessionId）', () => {
  it('threadIdFromBody：只取非空字符串，其它形状一律 null', () => {
    expect(threadIdFromBody({ memory: { thread: 'thread-1' } })).toBe('thread-1')
    expect(threadIdFromBody({ memory: { thread: '   ' } })).toBeNull()
    expect(threadIdFromBody({ memory: { thread: 42 } })).toBeNull()
    expect(threadIdFromBody({ memory: {} })).toBeNull()
    expect(threadIdFromBody({})).toBeNull()
    expect(threadIdFromBody(null)).toBeNull()
  })

  it('startTurn 带上 body.memory.thread 的 threadId', async () => {
    const { adapter, threadIds } = fakeAdapter([
      { type: 'text-delta', id: 'text-0', delta: '好' }
    ])
    const app = new Hono()
    app.post('/chat/kyclaw', createKernelChatHandler(adapter))
    const response = await app.request('/chat/kyclaw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memory: { thread: 'thread-abc' },
        messages: [{ role: 'user', parts: [{ type: 'text', text: '嗨' }] }]
      })
    })
    expect(await response.text()).toContain('"delta":"好"')
    expect(threadIds).toEqual(['thread-abc'])
  })

  it('没有 memory.thread 时不传 threadId（走 adapter 默认会话）', async () => {
    const { adapter, threadIds } = fakeAdapter([])
    const app = new Hono()
    app.post('/chat/kyclaw', createKernelChatHandler(adapter))
    await app.request('/chat/kyclaw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: '嗨' }] }] })
    })
    expect(threadIds).toEqual([undefined])
  })

  it('客户端断开（reader cancel）→ cancelTurn 带同一个 threadId，不误取消别的会话', async () => {
    const { adapter, cancels } = fakeAdapter(
      [{ type: 'text-delta', id: 'text-0', delta: '半截' }],
      { hang: true }
    )
    const app = new Hono()
    app.post('/chat/kyclaw', createKernelChatHandler(adapter))
    const response = await app.request('/chat/kyclaw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memory: { thread: 'thread-abc' },
        messages: [{ role: 'user', parts: [{ type: 'text', text: '嗨' }] }]
      })
    })
    // 读一帧就取消：cancel() 是「下游 reader 断开」的收尾路径
    const reader = response.body?.getReader()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toContain('半截')
    await reader?.cancel()
    expect(cancels).toContain('thread-abc')
    expect(cancels.every((threadId) => threadId === 'thread-abc')).toBe(true)
  })
})
