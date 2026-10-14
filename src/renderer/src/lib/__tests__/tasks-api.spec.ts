import { afterEach, describe, expect, it, vi } from 'vitest'
import { installKyclawBridge, clearKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { fetchTasks, writeTasks } from '../tasks-api'

const snapshot = { revision: 3, items: [], updatedAt: null }
const endpoint = { baseUrl: 'http://127.0.0.1:39001', token: 'test-token' }
const input = { action: 'replace' as const, expectedRevision: 2, items: [] }
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}
afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('任务 API', () => {
  it('现取 endpoint，编码线程路径，token 只在 bearer 头', async () => {
    installKyclawBridge()
    const getEndpoint = vi.fn().mockResolvedValue(endpoint)
    window.kyclaw.agent.endpoint = getEndpoint
    const fetchMock = vi.fn().mockResolvedValue(response(snapshot))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchTasks('a/b')).toEqual(snapshot)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}/api/tasks/a%2Fb`)
    expect(url).not.toContain(endpoint.token)
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${endpoint.token}`)
    expect(init.method).toBe('GET')
    expect(getEndpoint).toHaveBeenCalledTimes(1)
  })
  it('PUT 携带 expectedRevision，409 返回快照不重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ error: 'revision-conflict', snapshot }, 409))
    vi.stubGlobal('fetch', fetchMock)
    expect(await writeTasks('t1', input, endpoint)).toEqual({ status: 'conflict', snapshot })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual(input)
  })
  it('成功 PUT 解析完整快照，异常 HTTP 和坏快照明确失败', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response({ error: 'secret should not be echoed' }, 404))
      .mockResolvedValueOnce(response({ revision: 3 }))
      .mockResolvedValueOnce(response({ error: 'other', snapshot }, 409))
    vi.stubGlobal('fetch', fetchMock)
    expect(await writeTasks('t1', input, endpoint)).toEqual({ status: 'ok', snapshot })
    await expect(fetchTasks('t1', endpoint)).rejects.toThrow('不存在或不可访问')
    await expect(fetchTasks('t1', endpoint)).rejects.toThrow('回包格式')
    await expect(writeTasks('t1', input, endpoint)).rejects.toThrow('冲突回包格式')
  })
})
