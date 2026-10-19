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

describe('P0：/ask-user/pending 不再是 404', () => {
  it('空态 → 200 + {pending: []}（composer 得以解锁）', async () => {
    const response = await appWith(new InteractionHub()).request('/ask-user/pending?threadId=thread-A')
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
    expect(body.approvals.pending).toEqual([expect.objectContaining({ id: 'evt-a', source: 'waterfall' })])
    expect(body.questions.pending).toEqual([])
    // 缺 threadId → 400（不是静默空快照，避免调用方以为"没有交互"）
    expect((await appWith(hub).request('/kernel/interactions')).status).toBe(400)
  })
})
