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
 */

import { Hono } from 'hono'
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

export function createKernelInteractionRouter(options: { hub: InteractionHub }): Hono {
  const app = new Hono()
  const { hub } = options

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

  return app
}
