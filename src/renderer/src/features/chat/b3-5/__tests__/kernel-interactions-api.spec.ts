import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KernelInteractionError,
  fetchKernelInteractions,
  isStaleInteractionError,
  respondKernelApproval,
  respondKernelQuestion
} from '../kernel-interactions-api'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'

/**
 * PB-026：内核交互 HTTP 客户端（GET 快照 / POST 应答）的契约与错误映射。
 * 错误码来自 Bao `kernel-interaction-route.ts`，UI 必须按码区分「已处理/可重试/不可用」。
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const SNAPSHOT = {
  threadId: 'thread-1',
  approvals: {
    pending: [{ threadId: 'thread-1', id: 'evt-a', source: 'waterfall', toolName: 'write' }],
    results: []
  },
  askUser: { active: [], settled: [], timed: false },
  questions: { pending: [] }
}

beforeEach(() => {
  installKyclawBridge()
  window.kyclaw.agent.endpoint = async () => ({ baseUrl: 'http://kernel.local', token: 'tok' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearKyclawBridge()
})

describe('PB-026 kernel-interactions-api：读快照', () => {
  it('GET /api/kernel/interactions?threadId=，回包数组字段原样收下', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input
      void _init
      return json(SNAPSHOT)
    })
    vi.stubGlobal('fetch', fetchMock)
    const snapshot = await fetchKernelInteractions('thread-1')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://kernel.local/api/kernel/interactions?threadId=thread-1'
    )
    expect(snapshot.approvals.pending).toHaveLength(1)
    expect(snapshot.questions.pending).toEqual([])
  })

  it('缺失数组/坏包 → 退回空集合（不把页面打崩）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ threadId: 't' }))
    )
    const snapshot = await fetchKernelInteractions('t')
    expect(snapshot.approvals.pending).toEqual([])
    expect(snapshot.askUser.active).toEqual([])
    expect(snapshot.questions.pending).toEqual([])
  })

  it('400 missing-threadId → KernelInteractionError(code,status)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'missing-threadId' }, 400))
    )
    await expect(fetchKernelInteractions('')).rejects.toMatchObject({
      code: 'missing-threadId',
      status: 400
    })
  })
})

describe('PB-026 kernel-interactions-api：写应答', () => {
  it('审批 body 只有 kind/outcome；200 返回 responded', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input
      void _init
      return json({ status: 'responded', eventId: 'evt-a', kind: 'approval', threadId: 'thread-1' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await respondKernelApproval('evt-a', 'allowed-once')
    expect(result.status).toBe('responded')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://kernel.local/api/kernel/interactions/evt-a/respond'
    )
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      kind: 'approval',
      outcome: 'allowed-once'
    })
  })

  it('提问 body answers 原样；400 answers-invalid 透出码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'answers-invalid' }, 400))
    )
    await expect(
      respondKernelQuestion('evt-q', [{ id: 'q1', selected: ['A'] }])
    ).rejects.toMatchObject({ code: 'answers-invalid', status: 400 })
  })

  it('409 already-settled / 404 unknown-event → isStaleInteractionError=true（UI 刷新不重试）', async () => {
    const settled = new KernelInteractionError('already-settled', 409, '已处理')
    const unknown = new KernelInteractionError('unknown-event', 404, '过期')
    expect(isStaleInteractionError(settled)).toBe(true)
    expect(isStaleInteractionError(unknown)).toBe(true)
    expect(isStaleInteractionError(new KernelInteractionError('respond-failed', 502, '失败'))).toBe(
      false
    )
  })

  it('409 already-settled 带终态 → error.result 可直接渲染结果行', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          {
            error: 'already-settled',
            eventId: 'evt-a',
            threadId: 'thread-1',
            kind: 'approval',
            at: 123,
            result: {
              threadId: 'thread-1',
              id: 'evt-a',
              matchedBy: 'id',
              toolName: 'write',
              outcome: 'rejected',
              copy: {
                title: '你拒绝了这次操作',
                detail: '模型会继续。',
                attribution: 'user',
                canRetry: true
              },
              systemInitiated: false,
              settledBy: 'user',
              at: 123
            }
          },
          409
        )
      )
    )
    await expect(respondKernelApproval('evt-a', 'allowed-once')).rejects.toMatchObject({
      code: 'already-settled',
      eventId: 'evt-a',
      result: { outcome: 'rejected', settledBy: 'user', at: 123 }
    })
  })

  it('503 interactions-unavailable / 502 respond-failed 保留可重试错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'interactions-unavailable' }, 503))
    )
    await expect(respondKernelApproval('evt-a', 'rejected')).rejects.toMatchObject({
      code: 'interactions-unavailable',
      status: 503
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'respond-failed', message: '内核侧失败' }, 502))
    )
    await expect(respondKernelApproval('evt-a', 'rejected')).rejects.toMatchObject({
      code: 'respond-failed',
      status: 502,
      message: '内核侧失败'
    })
  })
})
