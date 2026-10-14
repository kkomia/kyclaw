import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTaskHistory } from '../tasks-api'
vi.mock('../agent', () => ({
  resolveAgentEndpoint: async () => ({ baseUrl: 'http://localhost:1234', token: 'test-token' })
}))
afterEach(() => vi.unstubAllGlobals())
describe('Task history API', () => {
  it('使用冻结 GET 路径和 Bearer，解析真实 revisions', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revisions: [] })))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchTaskHistory('a/b')).toEqual({ revisions: [] })
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:1234/api/tasks/a%2Fb/history')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token')
  })
  it('坏回包不当成空历史', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await expect(fetchTaskHistory('thread')).rejects.toThrow('历史回包格式不对')
  })
})
