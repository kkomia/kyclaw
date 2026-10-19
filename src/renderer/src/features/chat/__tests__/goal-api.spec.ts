import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchGoal, postGoalWithRetry } from '../goal-api'

/**
 * PB-039 goal API 客户端：409 `GOAL_STALE_REVISION` → 重新 GET → 用最新 revision 重发一次。
 * 契约见 `.superpowers/dev-verify/20261019-0.1.6/b1/goal-api-contract.md`。
 */
const state = (revision: number): Record<string, unknown> => ({
  goal: {
    id: 'g1',
    revision,
    objective: '完成迁移',
    phase: 'active',
    roundsStarted: 1,
    maxGoalRounds: 256,
    createdAt: 1,
    updatedAt: 2
  },
  activation: 'disarmed'
})

beforeEach(() => {
  vi.stubGlobal('window', {
    ...window,
    kyclaw: { agent: { endpoint: async () => ({ baseUrl: 'http://goal.local', token: 'tok' }) } }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('goal-api', () => {
  it('GET 解析回包', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(state(3)), { status: 200 }))
    )
    const result = await fetchGoal('t1')
    expect(result.goal?.revision).toBe(3)
  })

  it('409 stale → 重 GET → 用最新 revision 重发一次', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'GOAL_STALE_REVISION', message: '旧 revision' }), {
          status: 409
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(state(5)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(state(6)), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await postGoalWithRetry(
      { threadId: 't1', action: 'pause', ref: { id: 'g1', revision: 2 } },
      't1'
    )

    expect(result.goal?.revision).toBe(6)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const second = JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string)
    expect(second.ref).toEqual({ id: 'g1', revision: 5 })
  })

  it('非 stale 错误直接抛出（不重发）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'GOAL_INVALID_TRANSITION', message: '不能暂停' }), {
            status: 409
          })
      )
    )
    await expect(
      postGoalWithRetry({ threadId: 't1', action: 'pause', ref: { id: 'g1', revision: 2 } }, 't1')
    ).rejects.toThrow('不能暂停')
  })
})
