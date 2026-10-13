import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { fetchSessionPptTemplates, putSessionPptTemplate } from '@renderer/lib/session-ppt-api'

/**
 * 会话↔PPT 模板映射客户端（round 66）：**端点复用**这一条口径。
 *
 * 背景（本轮修的）：对话页拼 chat 传输时已经解析过一份端点，预取再自己 `agent.endpoint()`
 * 一次就是白多一次 IPC —— 那一次多余的往返把 error-card 那条"端点恰好被解析 2 次"的用例
 * 顶穿了。所以 `fetchSessionPptTemplates(endpoint)` 收一份现成的端点。
 *
 * 这里钉两件事：
 *   1. 给了端点 → 一次 IPC 都不发，请求打在**给的那一份** baseUrl 上；
 *   2. 不给端点 → 自己解析（本模块单独用也成立，不改旧行为）。
 */
function installBridgeWithEndpoint(): { endpoint: ReturnType<typeof vi.fn> } {
  installKyclawBridge()
  const endpoint = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:39001', token: 'tok-1' }))
  window.kyclaw.agent.endpoint = endpoint
  return { endpoint }
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('fetchSessionPptTemplates 的端点来源', () => {
  it('调用方给了端点：复用它，主进程一次都不问', async () => {
    const { endpoint } = installBridgeWithEndpoint()
    const fetchMock = stubFetch()

    const given = { baseUrl: 'http://127.0.0.1:9', token: 'tok-reused' }
    await fetchSessionPptTemplates(given)

    expect(endpoint).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:9/api/ppt/templates')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-reused')
  })

  it('没给端点：自己解析（单独用这个模块时的老行为不变）', async () => {
    const { endpoint } = installBridgeWithEndpoint()
    const fetchMock = stubFetch()

    await fetchSessionPptTemplates()

    expect(endpoint).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://127.0.0.1:39001/api/ppt/templates'
    )
  })

  it('端点拿不到时如实抛（不静默发一个没有 baseUrl 的请求）', async () => {
    installKyclawBridge()
    window.kyclaw.agent.endpoint = async () => {
      throw new Error('agent 服务尚未启动')
    }
    const fetchMock = stubFetch()

    await expect(fetchSessionPptTemplates()).rejects.toThrow('agent 服务尚未启动')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('写入那条路照旧自己解析端点（本轮没给它加复用口子）', async () => {
    const { endpoint } = installBridgeWithEndpoint()
    const fetchMock = stubFetch()

    await putSessionPptTemplate('t1', '酒红')

    expect(endpoint).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:39001/api/ppt/templates')
    expect(init.method).toBe('PUT')
  })
})
