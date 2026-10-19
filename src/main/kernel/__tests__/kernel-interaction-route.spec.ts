// @vitest-environment node
/**
 * P0 回归：`/ask-user/pending` **不能再 404**（renderer 挂载即请求它，404 → composer 永久 disabled）。
 *
 * 这一条钉的是「路由存在 + 回包形状与 renderer 契约一致」，不是"看起来能跑"：
 * - 空态必须 200 + `{pending: []}`（不是 404、不是 500）；
 * - 内核提问 → 旧回包项（runId/toolCallId/suspendedAt 可解析，input 满足旧 schema：header + 2..4 选项）；
 * - 映射不了的提问**不进**旧路由（不伪造选项），但能在 `/kernel/interactions` 快照里看到；
 * - cancel 返回 `{status:'cancelled', runIds}` 并把本地挂起摘掉（内核侧无 cancel 接口，见文件头注释）。
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { InteractionHub, applyInteractionEvent } from '../interaction-hub'
import { createKernelInteractionRouter, toLegacyPendingQuestion } from '../kernel-interaction-route'
import { validateAskUserInput } from '../../../shared/ask-user'

function appWith(hub: InteractionHub): Hono {
  const app = new Hono()
  app.route('/', createKernelInteractionRouter({ hub }))
  return app
}

/** 带应答器的写面 app（fake responder 记录调用） */
function appWithResponder(
  hub: InteractionHub,
  respond: (response: unknown) => Promise<void>
): { app: Hono; calls: unknown[] } {
  const calls: unknown[] = []
  const app = new Hono()
  app.route(
    '/',
    createKernelInteractionRouter({
      hub,
      responder: {
        respondInteraction: (response) => {
          calls.push(response)
          return respond(response)
        }
      }
    })
  )
  return { app, calls }
}

function seededApproval(hub: InteractionHub): void {
  applyInteractionEvent(hub, {
    kind: 'approval',
    eventId: 'evt-a',
    threadId: 'thread-A',
    toolName: 'pwsh',
    callId: 'call-1'
  })
}

describe('PB-026 写面：POST /api/kernel/interactions/:eventId/respond', () => {
  it('审批允许 → 200 responded；应答 args 正确；挂起被摘、再提交是 409', async () => {
    const hub = new InteractionHub()
    seededApproval(hub)
    const { app, calls } = appWithResponder(hub, () => Promise.resolve())
    const response = await app.request('/api/kernel/interactions/evt-a/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'allowed-once' })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'responded',
      eventId: 'evt-a',
      kind: 'approval',
      threadId: 'thread-A'
    })
    expect(calls).toEqual([{ eventId: 'evt-a', kind: 'approval', outcome: 'allowed-once' }])
    expect(hub.snapshot('thread-A').approvals.pending).toHaveLength(0)

    // 重复提交：409（不是静默 200，也不是 404）
    const again = await app.request('/api/kernel/interactions/evt-a/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'rejected' })
    })
    expect(again.status).toBe(409)
    const conflict = (await again.json()) as Record<string, unknown>
    expect(conflict['error']).toBe('already-settled')
    expect(conflict['eventId']).toBe('evt-a')
    // PB-026 契约：409 带终态信息（UI 可直接渲结果行，不必再拉快照）
    expect(conflict['threadId']).toBe('thread-A')
    expect(conflict['kind']).toBe('approval')
    expect(typeof conflict['at']).toBe('number')
    // 此刻内核 decided 还没到 → 关联不到结果行，result 明确为 null（不是缺字段）
    expect(conflict['result']).toBeNull()
  })

  it('409 在 decided 已到达时带回终态（outcome/copy/settledBy）', async () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, {
      kind: 'approval',
      eventId: 'evt-b',
      threadId: 'thread-A',
      toolName: 'pwsh',
      callId: 'call-9',
      reason: '要写盘'
    })
    const { app } = appWithResponder(hub, () => Promise.resolve())
    const first = await app.request('/api/kernel/interactions/evt-b/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'rejected' })
    })
    expect(first.status).toBe(200)
    // 内核随后把 decided 事件投下来（同一 callId → 结果行被关联上）
    hub.applyApprovalDecided('thread-A', { id: 'ap-9', outcome: 'rejected' }, 7, 1_700_000_000_999)

    const again = await app.request('/api/kernel/interactions/evt-b/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'allowed-once' })
    })
    expect(again.status).toBe(409)
    const body = (await again.json()) as {
      result: {
        outcome: string
        settledBy: string
        at: number
        reason?: string
        copy: { title: string }
      } | null
    }
    expect(body.result?.outcome).toBe('rejected')
    expect(body.result?.settledBy).toBe('user')
    expect(body.result?.at).toBe(1_700_000_000_999)
    expect(body.result?.reason).toBe('要写盘')
    expect(body.result?.copy.title).toBe('你拒绝了这次操作')
  })

  it('未知 eventId → 404 unknown-event（与 409 区分开）', async () => {
    const hub = new InteractionHub()
    const { app, calls } = appWithResponder(hub, () => Promise.resolve())
    const response = await app.request('/api/kernel/interactions/evt-nope/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'rejected' })
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown-event', eventId: 'evt-nope' })
    expect(calls).toHaveLength(0)
  })

  it('提问回答 → 200 responded；answers 原样转给应答器；挂起摘除', async () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, {
      kind: 'question',
      eventId: 'evt-q',
      threadId: 'thread-A',
      questions: [
        { id: 'q1', header: '选择', question: '选？', options: [{ label: 'A' }, { label: 'B' }] }
      ]
    })
    const { app, calls } = appWithResponder(hub, () => Promise.resolve())
    const response = await app.request('/kernel/interactions/evt-q/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'question',
        answers: [{ id: 'q1', selected: ['A'], custom: '其它' }]
      })
    })
    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        eventId: 'evt-q',
        kind: 'question',
        answer: { answers: [{ id: 'q1', selected: ['A'], custom: '其它' }] }
      }
    ])
    expect(hub.snapshot('thread-A').questions.pending).toHaveLength(0)
  })

  it('body 不合法 → 400；审批只接受用户能做的两个决定', async () => {
    const hub = new InteractionHub()
    seededApproval(hub)
    const { app } = appWithResponder(hub, () => Promise.resolve())
    const badOutcome = await app.request('/api/kernel/interactions/evt-a/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'unavailable' })
    })
    expect(badOutcome.status).toBe(400)
    expect(await badOutcome.json()).toEqual({ error: 'outcome-not-a-user-decision' })

    const badKind = await app.request('/api/kernel/interactions/evt-a/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'nope' })
    })
    expect(badKind.status).toBe(400)
  })

  it('应答失败：$events 未就绪 → 503；其它 → 502；挂起必须留着可重试', async () => {
    const hub = new InteractionHub()
    seededApproval(hub)
    const notReady = appWithResponder(hub, () =>
      Promise.reject(new Error('kernel adapter: $events 流尚未就绪'))
    )
    const first = await notReady.app.request('/api/kernel/interactions/evt-a/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'rejected' })
    })
    expect(first.status).toBe(503)
    expect(hub.snapshot('thread-A').approvals.pending).toHaveLength(1)

    const boom = appWithResponder(hub, () => Promise.reject(new Error('gateway/internal: boom')))
    const second = await boom.app.request('/api/kernel/interactions/evt-a/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'rejected' })
    })
    expect(second.status).toBe(502)
    expect(hub.snapshot('thread-A').approvals.pending).toHaveLength(1)
  })

  it('没有应答器（flag 关/内核未起）→ 503，不静默成功', async () => {
    const hub = new InteractionHub()
    seededApproval(hub)
    const response = await appWith(hub).request('/api/kernel/interactions/evt-a/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'approval', outcome: 'allowed-once' })
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'interactions-unavailable' })
    expect(hub.snapshot('thread-A').approvals.pending).toHaveLength(1)
  })
})

describe('P0：/ask-user/pending 不再是 404', () => {
  it('空态 → 200 + {pending: []}（composer 得以解锁）', async () => {
    const response = await appWith(new InteractionHub()).request(
      '/ask-user/pending?threadId=thread-A'
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pending: [] })
  })

  it('缺 threadId → 仍 200 空数组（renderer 不会因参数缺失掉进 error）', async () => {
    const response = await appWith(new InteractionHub()).request('/ask-user/pending')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pending: [] })
  })

  it('内核提问 → 旧回包形状（renderer 的 validateAskUserInput 能过）', async () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, {
      kind: 'question',
      eventId: 'evt-1',
      threadId: 'thread-A',
      questions: [
        {
          id: 'q1',
          header: '选择',
          question: '选 A 还是 B？',
          options: [{ label: 'A' }, { label: 'B', description: '乙' }]
        }
      ]
    })
    const response = await appWith(hub).request('/ask-user/pending?threadId=thread-A')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      pending: Array<{ runId: string; toolCallId: string; suspendedAt: string; input: unknown }>
    }
    expect(body.pending).toHaveLength(1)
    const [item] = body.pending
    expect(item?.runId).toBe('kernel-evt-1')
    expect(item?.toolCallId).toBe('evt-1')
    expect(Number.isFinite(Date.parse(item?.suspendedAt ?? ''))).toBe(true)
    // 与 renderer 同一套校验：过不了就说明形状不对
    const input = validateAskUserInput(item?.input)
    expect(input.questions[0]?.options).toHaveLength(2)
    expect(input.questions[0]?.header).toBe('选择')
  })

  it('映射不了的提问（选项 <2）不进旧路由，但快照里仍可见（不伪造选项）', async () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, {
      kind: 'question',
      eventId: 'evt-2',
      threadId: 'thread-A',
      questions: [{ id: 'q1', question: '开放题（没有选项）' }]
    })
    expect(toLegacyPendingQuestion(hub.snapshot('thread-A').questions.pending[0]!)).toBeNull()
    const legacy = await appWith(hub).request('/ask-user/pending?threadId=thread-A')
    expect(await legacy.json()).toEqual({ pending: [] })
    const snapshot = await appWith(hub).request('/kernel/interactions?threadId=thread-A')
    const body = (await snapshot.json()) as { questions: { pending: unknown[] } }
    expect(body.questions.pending).toHaveLength(1)
  })

  it('cancel：摘本地挂起并回旧形状 {status, runIds}', async () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, {
      kind: 'question',
      eventId: 'evt-3',
      threadId: 'thread-A',
      questions: [
        { id: 'q1', header: '选择', question: '选？', options: [{ label: 'A' }, { label: 'B' }] }
      ]
    })
    const response = await appWith(hub).request('/ask-user/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-A' })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'cancelled', runIds: ['kernel-evt-3'] })
    expect(hub.snapshot('thread-A').questions.pending).toHaveLength(0)
  })

  it('hub 快照路由：审批/提问状态可读（给 renderer 新接线用）', async () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, {
      kind: 'approval',
      eventId: 'evt-a',
      threadId: 'thread-A',
      toolName: 'pwsh'
    })
    const response = await appWith(hub).request('/kernel/interactions?threadId=thread-A')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      approvals: { pending: Array<{ id: string; source: string }> }
      questions: { pending: unknown[] }
    }
    expect(body.approvals.pending).toEqual([
      expect.objectContaining({ id: 'evt-a', source: 'waterfall' })
    ])
    expect(body.questions.pending).toEqual([])
    // 缺 threadId → 400（不是静默空快照，避免调用方以为"没有交互"）
    expect((await appWith(hub).request('/kernel/interactions')).status).toBe(400)
  })
})
