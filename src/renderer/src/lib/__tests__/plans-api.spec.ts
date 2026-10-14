import { afterEach, expect, it, vi } from 'vitest'
import { createPlansApi, PlansApiError } from '../plans-api'
const state = {
  threadId: 't',
  version: 4,
  mode: 'awaiting_approval',
  planId: 'p',
  revision: 1,
  body: 'plan',
  feedback: null,
  approval: { runId: 'server-run', toolCallId: 'server-call' },
  updatedAt: new Date().toISOString()
}
afterEach(() => vi.unstubAllGlobals())
it('uses frozen /plans routes and returns new decision ref without caller run binding', async () => {
  const fetcher = vi.fn()
  fetcher.mockResolvedValue(Response.json({ state }))
  vi.stubGlobal('fetch', fetcher)
  const api = createPlansApi(async () => ({ baseUrl: 'http://localhost:3000', token: 'test' }))
  const result = await api.decision('t', { planId: 'p', revision: 1, version: 3 }, 'approve')
  expect(result.ref?.version).toBe(4)
  expect(fetcher.mock.calls[0]).toEqual([
    'http://localhost:3000/plans/decision',
    expect.objectContaining({
      body: JSON.stringify({
        threadId: 't',
        ref: { planId: 'p', revision: 1, version: 3 },
        decision: 'approve'
      })
    })
  ])
  const request = await api.resumeRequest('t', result.ref!)
  expect(request.url).toBe('http://localhost:3000/plans/resume')
  expect(JSON.parse(request.init.body)).toEqual({ threadId: 't', ref: result.ref })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('GET never enters/creates thread and rejects wrong-thread data and reports 409', async () => {
  const fetcher = vi.fn()
  fetcher.mockResolvedValue(Response.json({ state: { ...state, threadId: 'foreign' } }))
  vi.stubGlobal('fetch', fetcher)
  const api = createPlansApi(async () => ({ baseUrl: 'http://localhost:3000', token: 'test' }))
  await expect(api.get('t')).rejects.toThrow('会话不一致')
  expect(fetcher.mock.calls[0][0]).toBe('http://localhost:3000/plans/state?threadId=t')
  fetcher.mockImplementation(async () => Response.json({ error: 'stale' }, { status: 409 }))
  await expect(api.cancel('t', 4)).rejects.toBeInstanceOf(PlansApiError)
})
