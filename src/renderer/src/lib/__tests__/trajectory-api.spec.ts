import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import {
  fetchRequestDetail,
  fetchThreadRequestSummaries,
  fetchThreadUsageRuns
} from '../trajectory-api'

/**
 * 轨迹取数（渲染端）：两条软腿的 HTTP 客户端。
 *
 * 重点是**失败回包里那句人话**（round 87 / 用户反馈 017）：以前非 2xx 一律
 * 只有"用量服务返回 500"，服务端写在 `{ error }` 里的人话被丢掉，轨迹页那行提示也就
 * 说不出原因。现在照 usage-api 的口径把它带出来（`invalid-input:` 前缀去掉）。
 */
const endpoint = { baseUrl: 'http://127.0.0.1:39001', token: 'test-token' }

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function stub(handler: (url: string) => Response): ReturnType<typeof vi.fn> {
  installKyclawBridge()
  window.kyclaw.agent.endpoint = vi.fn().mockResolvedValue(endpoint)
  const fetchMock = vi.fn(async (url: string) => handler(url))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('轨迹取数 · 用量腿', () => {
  it('200：解析逐轮用量行；请求带 threadId、token 走 bearer 头', async () => {
    const runs = [
      {
        id: 'r1',
        runId: null,
        model: 'deepseek-flash',
        provider: null,
        input: 1,
        output: 2,
        total: 3,
        cachedInput: null,
        contextInput: null,
        contextCachedInput: null,
        stepCount: null,
        createdAt: '2026-10-15T06:00:00.000Z'
      }
    ]
    const fetchMock = stub(() => response({ threadId: 'a/b', runs }))

    expect(await fetchThreadUsageRuns('a/b')).toEqual(runs)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}/api/usage/thread?threadId=a%2Fb`)
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${endpoint.token}`)
  })

  it('500：把服务端那句人话原样带出来（不再只说"用量服务返回 500"）', async () => {
    stub(() => response({ error: '读取失败：usage_runs 表锁住了' }, 500))

    await expect(fetchThreadUsageRuns('t1')).rejects.toThrow('读取失败：usage_runs 表锁住了')
  })

  it('400：去掉 invalid-input 前缀（那句话是给人看的）', async () => {
    stub(() => response({ error: 'invalid-input: threadId' }, 400))

    await expect(fetchThreadUsageRuns('t1')).rejects.toThrow('threadId')
    await expect(fetchThreadUsageRuns('t1')).rejects.not.toThrow('invalid-input')
  })

  it('回包里没有那句话（非 JSON / 不是字符串）→ 退回带状态码的兜底话', async () => {
    installKyclawBridge()
    window.kyclaw.agent.endpoint = vi.fn().mockResolvedValue(endpoint)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Internal Server Error', { status: 500 }))
    )
    await expect(fetchThreadUsageRuns('t1')).rejects.toThrow('用量服务返回 500')
  })

  it('坏回包：字段缺一个就明确报格式不对（不静默给空数组）', async () => {
    stub(() => response({ threadId: 't1', runs: [{ id: 'r1' }] }))

    await expect(fetchThreadUsageRuns('t1')).rejects.toThrow('回包格式不对')
  })
})

describe('轨迹取数 · 请求快照腿（round 87 / 用户反馈 015）', () => {
  const summary = {
    id: 's1',
    runId: 'run-1',
    step: 0,
    status: 'complete',
    error: null,
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    messageCount: 3,
    toolCount: 35,
    systemChars: 14000,
    toolsChars: 81000,
    truncated: false,
    createdAt: '2026-10-15T06:00:00.000Z'
  }

  it('200：解析逐次请求摘要（走 /api/trajectory，与用量分开）', async () => {
    const fetchMock = stub(() => response({ threadId: 't1', requests: [summary] }))

    expect(await fetchThreadRequestSummaries('t1')).toEqual([summary])
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}/api/trajectory/requests?threadId=t1`)
  })

  it('500：同样带出人话，且标签说的是"请求快照服务"（不把用量与它混成一句）', async () => {
    stub(() => response({ error: '读取失败：request_snapshots 表坏了' }, 500))

    await expect(fetchThreadRequestSummaries('t1')).rejects.toThrow(
      '读取失败：request_snapshots 表坏了'
    )
    // 没有 body 里的那句话时，兜底话带的是这条腿自己的名字
    installKyclawBridge()
    window.kyclaw.agent.endpoint = vi.fn().mockResolvedValue(endpoint)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    )
    await expect(fetchThreadRequestSummaries('t1')).rejects.toThrow('请求快照服务返回 500')
  })

  it('明细腿：按 id 取一次请求的正文（系统指令 / 工具表 / 消息清单）', async () => {
    const request = {
      ...summary,
      system: '你是 kyclaw。',
      tools: null,
      messages: [{ role: 'user', text: '你好', chars: 2, truncated: false }]
    }
    const fetchMock = stub(() => response({ request }))

    expect(await fetchRequestDetail('s1')).toEqual(request)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}/api/trajectory/requests/detail?id=s1`)
  })

  it('明细腿：404（没有这条记录）也把服务端人话带出来', async () => {
    stub(() => response({ error: '没有这条请求记录' }, 404))

    await expect(fetchRequestDetail('nope')).rejects.toThrow('没有这条请求记录')
  })
})
