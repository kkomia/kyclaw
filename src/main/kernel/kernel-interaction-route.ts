/**
 * PB-004/PB-025：交互中枢的 **HTTP 面**（main 侧 service 挂载）。
 *
 * 为什么要有这个文件（P0 复盘）：renderer 挂载即 `GET /ask-user/pending`，而旧路由只存在于
 * `src/mastra/routes/ask-user.ts`（旧 Mastra 服务）。内核路径（B3.1b 起的 `src/main/agent/service.ts`）
 * 没挂过这三条 → **404** → renderer 的 `ask-user-store` 进 error、`waitingInteraction` 恒真 →
 * composer 永久 disabled（Nia 的 e2e 全部卡死）。这里把 hub 真正接到 HTTP 面。
 *
 * 三条路：
 * - `GET /ask-user/pending?threadId=`：**旧回包形状**（renderer 现在就在读），只暴露能干净映射的提问
 *   （旧 schema 要求 header + 2..4 个选项；映射不了的不进这条，去新快照路由看，不伪造选项）；
 * - `POST /ask-user/cancel`：旧回包 `{status:'cancelled', runIds}`。本地摘挂起（内核侧提问没有 cancel
 *   **接口**，只能等超时/放弃——这一点在报告里注明，不假装取消了内核请求）；
 * - `GET /kernel/interactions?threadId=`：hub 快照（审批 pending/results + 提问 + continued 投影），
 *   给 PB-027 / Cyrus 的 renderer 接线用；**不下发内核 token/cookie**。
 *
 * ⚠️ **`/ask-user/resume` 已不再提供**（不是漏实现，别去补）：旧实现在 Mastra 服务里
 * （把回答塞回 Mastra run），内核路径没有该语义。替代通道是 `$events/result`（阻塞式提问，见
 * `kernel-adapter.respondInteraction`）与 `userQuestions/answer`（continued 补答，见
 * `answerContinuedQuestion`）；renderer 侧的提交换通道归 PB-027/Cyrus。
 *
 * ⚠️ PB-030：本路由的**读**路径（pending / 快照）只读 hub，对未知/占位 threadId 返回空态，
 * **不得触发内核 `session/create`**——否则会堆出幽灵会话（侧栏多一行、`/api/threads` 也带出来）。
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { InteractionResponse } from './kernel-interactions'
import type { InteractionHub, PendingQuestion } from './interaction-hub'

/** 旧 `/ask-user/pending` 的回包项（`src/renderer/src/lib/ask-user-api.ts:5-10`） */
export interface LegacyPendingQuestion {
  runId: string
  toolCallId: string
  input: {
    questions: Array<{
      id: string
      header: string
      question: string
      options: Array<{ id: string; label: string; description?: string }>
      multiSelect?: boolean
    }>
  }
  suspendedAt: string
}

/**
 * 内核提问 → 旧回包项。**映射不了就返回 null**（不伪造 header/选项）：
 * 旧 schema 要求每题 2..4 个选项、header 非空；内核提问这两项都可能缺。
 */
export function toLegacyPendingQuestion(question: PendingQuestion): LegacyPendingQuestion | null {
  const questions = question.questions.flatMap((item) => {
    const options = (item.options ?? []).slice(0, 4).map((option, index) => ({
      id: `opt-${String(index)}`,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description })
    }))
    if (options.length < 2) return []
    return [
      {
        id: item.id,
        header: item.header ?? '请选择',
        question: item.question,
        options,
        ...(item.multiSelect === true ? { multiSelect: true } : {})
      }
    ]
  })
  if (questions.length === 0) return null
  return {
    runId: `kernel-${question.eventId}`,
    toolCallId: question.eventId,
    input: { questions },
    suspendedAt: question.suspendedAt
  }
}

function readThreadId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 写面需要的应答能力（由 service 传入真 adapter；测试可注入 fake） */
export interface KernelInteractionResponder {
  respondInteraction: (response: InteractionResponse) => Promise<void>
}

export interface KernelInteractionRouterOptions {
  hub: InteractionHub
  /** 缺省（flag 关 / 内核没起）→ 写面回 503，不静默成功 */
  responder?: KernelInteractionResponder
}

/** 审批写面只接受用户能做的两个决定（其它两态是内核/系统侧的结果，不是用户动作） */
const USER_APPROVAL_DECISIONS = ['allowed-once', 'rejected'] as const

function parseRespondBody(
  body: unknown
):
  | { ok: true; response: InteractionResponse }
  | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body-not-object' }
  const record = body as { kind?: unknown; outcome?: unknown; answers?: unknown }
  if (record.kind === 'approval') {
    if (typeof record.outcome !== 'string') return { ok: false, error: 'outcome-missing' }
    if (!(USER_APPROVAL_DECISIONS as readonly string[]).includes(record.outcome))
      return { ok: false, error: 'outcome-not-a-user-decision' }
    return {
      ok: true,
      response: {
        eventId: '',
        kind: 'approval',
        outcome: record.outcome as (typeof USER_APPROVAL_DECISIONS)[number]
      }
    }
  }
  if (record.kind === 'question') {
    if (!Array.isArray(record.answers) || record.answers.length === 0)
      return { ok: false, error: 'answers-missing' }
    const answers = record.answers.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const entry = item as { id?: unknown; selected?: unknown; custom?: unknown }
      if (typeof entry.id !== 'string' || entry.id === '') return []
      if (!Array.isArray(entry.selected)) return []
      const selected = entry.selected.filter((value): value is string => typeof value === 'string')
      if (selected.length !== entry.selected.length) return []
      return [
        {
          id: entry.id,
          selected,
          ...(typeof entry.custom === 'string' ? { custom: entry.custom } : {})
        }
      ]
    })
    if (answers.length !== record.answers.length) return { ok: false, error: 'answers-invalid' }
    return { ok: true, response: { eventId: '', kind: 'question', answer: { answers } } }
  }
  return { ok: false, error: 'kind-invalid' }
}

export function createKernelInteractionRouter(options: KernelInteractionRouterOptions): Hono {
  const app = new Hono()
  const { hub, responder } = options

  app.get('/ask-user/pending', (context) => {
    const threadId = readThreadId(context.req.query('threadId'))
    if (threadId === '') return context.json({ pending: [] })
    const pending = hub
      .snapshot(threadId)
      .questions.pending.flatMap((question) => {
        const mapped = toLegacyPendingQuestion(question)
        return mapped === null ? [] : [mapped]
      })
    return context.json({ pending })
  })

  app.post('/ask-user/cancel', async (context) => {
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: 'invalid-json' }, 400)
    }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const threadId = readThreadId(record.threadId)
    const runId = typeof record.runId === 'string' ? record.runId : undefined
    if (threadId === '') return context.json({ status: 'cancelled', runIds: [] })
    const pending = hub.snapshot(threadId).questions.pending
    const targets =
      runId === undefined
        ? pending
        : pending.filter((question) => `kernel-${question.eventId}` === runId || question.eventId === runId)
    for (const question of targets) hub.dismissQuestion(threadId, question.eventId)
    return context.json({ status: 'cancelled', runIds: targets.map((q) => `kernel-${q.eventId}`) })
  })

  app.get('/kernel/interactions', (context) => {
    const threadId = readThreadId(context.req.query('threadId'))
    if (threadId === '') return context.json({ error: 'missing-threadId' }, 400)
    return context.json(hub.snapshot(threadId))
  })

  // PB-026 写面：审批「允许/拒绝」与提问「提交回答」。
  // 契约（同时注册 `/api/kernel/...` 规范路径与不带 `/api` 的兼容别名）：
  //   POST {base}/api/kernel/interactions/:eventId/respond
  //   body: {kind:'approval', outcome:'allowed-once'|'rejected'}
  //       | {kind:'question', answers:[{id, selected[], custom?}]}
  //   200 {status:'responded', eventId, kind, threadId}
  //   400 {error}（body 不合法）｜404 {error:'unknown-event'}（eventId 从没挂过）
  //   409 {error:'already-settled'}（重复提交/已结算）｜503（内核 $events 未就绪）
  //   502 {error:'respond-failed'}（内核侧应答失败）
  const respond = async (context: Context): Promise<Response> => {
    const eventId = (context.req.param('eventId') ?? '').trim()
    if (eventId === '') return context.json({ error: 'missing-eventId' }, 400)
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: 'invalid-json' }, 400)
    }
    const parsed = parseRespondBody(body)
    if (!parsed.ok) return context.json({ error: parsed.error }, 400)
    if (responder === undefined)
      return context.json({ error: 'interactions-unavailable' }, 503)
    const pending = hub.findPendingByEventId(eventId)
    if (pending === null)
      return hub.isSettledEvent(eventId)
        ? context.json({ error: 'already-settled', eventId }, 409)
        : context.json({ error: 'unknown-event', eventId }, 404)
    const response: InteractionResponse = { ...parsed.response, eventId }
    try {
      await responder.respondInteraction(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = /尚未就绪/u.test(message) ? 503 : 502
      return context.json({ error: 'respond-failed', message }, status)
    }
    // 先应答内核、成功后才摘本地挂起（失败时挂起留着可重试）
    if (response.kind === 'approval') hub.dismissPending(pending.threadId, eventId)
    else hub.dismissQuestion(pending.threadId, eventId)
    return context.json({
      status: 'responded',
      eventId,
      kind: response.kind,
      threadId: pending.threadId
    })
  }
  app.post('/api/kernel/interactions/:eventId/respond', respond)
  app.post('/kernel/interactions/:eventId/respond', respond)

  // 快照也加 `/api/kernel` 规范路径（与 kernel-ui-route 的前缀一致），旧路径保留兼容
  app.get('/api/kernel/interactions', (context) => {
    const threadId = readThreadId(context.req.query('threadId'))
    if (threadId === '') return context.json({ error: 'missing-threadId' }, 400)
    return context.json(hub.snapshot(threadId))
  })

  return app
}
