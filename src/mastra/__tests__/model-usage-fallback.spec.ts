// @vitest-environment node
/**
 * PB-027 方案 A 的降级路径：`withUsageFallbackFetch`（model.ts）。
 *
 * 三条路径（任务验收 ③）：
 *   1. 端点认 `stream_options.include_usage` → 一次请求，原样返回；
 *   2. 端点 400 且报「未知字段 stream_options」→ **丢掉该字段重试一次**（对话不挂）；
 *   3. 端点 400 是别的原因（不是 usage 开关）→ **不重试**，原样交给上层（真错误不吞）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withUsageFallbackFetch } from '../model'

interface Attempt {
  url: unknown
  body: string
}

function stubFetch(script: Array<{ status: number; body: string }>): Attempt[] {
  const attempts: Attempt[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      attempts.push({ url: input, body: String(init?.body ?? '') })
      const next = script.shift()
      if (next === undefined) throw new Error('fetch 调用次数超出预期')
      return new Response(next.body, { status: next.status })
    })
  )
  return attempts
}

const streamRequest = (): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen3',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'hi' }]
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withUsageFallbackFetch（PB-027 方案 A 的 400 降级）', () => {
  it('端点接受 include_usage → 只请求一次，body 原样', async () => {
    const attempts = stubFetch([{ status: 200, body: '{}' }])
    const response = await withUsageFallbackFetch('ok-provider')('https://gw/chat', streamRequest())
    expect(response.status).toBe(200)
    expect(attempts).toHaveLength(1)
    expect(JSON.parse(attempts[0].body)).toMatchObject({
      stream_options: { include_usage: true }
    })
  })

  it('400「unknown stream_options」→ 丢掉字段重试一次，最终 200，对话不挂', async () => {
    const attempts = stubFetch([
      {
        status: 400,
        body: JSON.stringify({
          error: { message: 'Unrecognized request argument: stream_options', type: 'invalid_request_error' }
        })
      },
      { status: 200, body: '{}' }
    ])
    const response = await withUsageFallbackFetch('fallback-provider')(
      'https://gw/chat',
      streamRequest()
    )
    expect(response.status).toBe(200)
    expect(attempts).toHaveLength(2)
    expect(JSON.parse(attempts[0].body)).toHaveProperty('stream_options')
    expect(JSON.parse(attempts[1].body)).not.toHaveProperty('stream_options')
    // 其它字段一个都不能少（只是去掉 usage 开关）
    expect(JSON.parse(attempts[1].body)).toMatchObject({ model: 'qwen3', stream: true })
  })

  it('400 别的原因（模型不存在）→ 不重试，原样返回', async () => {
    const attempts = stubFetch([
      { status: 400, body: JSON.stringify({ error: { message: 'model not found' } }) }
    ])
    const response = await withUsageFallbackFetch('strict-provider')(
      'https://gw/chat',
      streamRequest()
    )
    expect(response.status).toBe(400)
    expect(attempts).toHaveLength(1)
    expect(JSON.parse(attempts[0].body)).toHaveProperty('stream_options')
  })
})
