/**
 * PB-025：内核 **Remote 事件流（`$events`）** 与**回执**的形状层（纯函数，不碰网络）。
 *
 * 取证依据（一手，见 `bao/pb025-wire-forensics.md` §7）：
 * - mux `open` 带 `endpoint: '$events'`、`payload` **必须恰好** `{args:{}}`（`dsh-api-gateway:1004-1006`）；
 * - 首帧 `{type:'ready', clientId, host}`（`:1017-1023`）；
 * - waterfall 帧 `{type:'waterfall', event, eventId, agentId, request}`（`:1150-1160`）；
 * - 回执 RPC `POST /api/$events/result`，args 形状 **`{clientId, eventId, outcome}`**（`:136-170`）。
 *
 * ⚠️ **踩坑写死在这里**：`$events/result` 的 RPC args 就是 `{clientId, eventId, outcome}` 本身，
 * **不要再包一层 `{args: …}`**——`KernelRpcClient` 已经把它放进 `payload.args` 了。
 * 包错时内核只会回一句 `(gateway/internal): api gateway: invalid Remote event result`，
 * 而且**任何 outcome 形状都是同一句**，极易误判成"outcome 写错了"。单测里钉住了这一点。
 *
 * 两个 waterfall 的 `outcome.value` 形状（同样一手取证）：
 * - `approval/request`：**裸四态字符串** `'allowed-once'|'rejected'|'cancelled'|'unavailable'`。
 *   内核 `ApprovalService.decide()` 用 `OUTCOMES.includes(outcome) ? outcome : 'unavailable'` 归一
 *   （`dsh-user-approval:172-192`）→ **形状写错只会变成 unavailable（fail-closed），绝不会误放行**。
 * - `user-questions/request`：`{ answers: [{ id, selected: string[], custom?: string }] }`
 *   （`AskUserQuestionAnswer`；活内核实测工具侧收到同形 JSON）。
 */

export const REMOTE_EVENTS_ENDPOINT = '$events'
export const REMOTE_EVENTS_RESULT_ENDPOINT = '$events/result'
export const APPROVAL_REQUEST_EVENT = 'approval/request'
export const USER_QUESTIONS_REQUEST_EVENT = 'user-questions/request'

/** `$events` 首帧：证明 Host 事件源就绪，并给出本次事件流的身份 */
export interface RemoteEventsReadyFrame {
  type: 'ready'
  clientId: string
  host?: unknown
}

/** 需要应答者决定/回答的 waterfall 帧 */
export interface RemoteWaterfallFrame {
  type: 'waterfall'
  event: string
  eventId: string
  agentId: string
  request: Record<string, unknown>
}

/** 只读广播帧（我们目前不消费，原样透传出去便于诊断） */
export interface RemoteEmitFrame {
  type: 'emit'
  event: string
  args: unknown
}

export type RemoteEventFrame = RemoteEventsReadyFrame | RemoteWaterfallFrame | RemoteEmitFrame

/** 收窄 mux `$events` 的 item value；不认识 / 形状不对返回 null（不猜） */
export function parseRemoteEventFrame(value: unknown): RemoteEventFrame | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as {
    type?: unknown
    clientId?: unknown
    host?: unknown
    event?: unknown
    eventId?: unknown
    agentId?: unknown
    request?: unknown
    args?: unknown
  }
  if (record.type === 'ready') {
    if (typeof record.clientId !== 'string' || record.clientId === '') return null
    return {
      type: 'ready',
      clientId: record.clientId,
      ...(record.host === undefined ? {} : { host: record.host })
    }
  }
  if (record.type === 'waterfall') {
    if (
      typeof record.event !== 'string' ||
      typeof record.eventId !== 'string' ||
      typeof record.agentId !== 'string' ||
      typeof record.request !== 'object' ||
      record.request === null
    )
      return null
    return {
      type: 'waterfall',
      event: record.event,
      eventId: record.eventId,
      agentId: record.agentId,
      request: record.request as Record<string, unknown>
    }
  }
  if (record.type === 'emit') {
    if (typeof record.event !== 'string') return null
    return { type: 'emit', event: record.event, args: record.args }
  }
  return null
}

/** 审批 waterfall → 我方挂起项（`eventId` 就是回执用的因果 id） */
export interface ApprovalRequestEvent {
  kind: 'approval'
  eventId: string
  /** 内核 `threadId`（= sessionId；B3.4 口径） */
  threadId: string
  toolName: string
  callId?: string
  reason?: string
}

/** 提问 waterfall → 我方挂起项 */
export interface QuestionRequestItem {
  id: string
  question: string
  header?: string
  /** PB-044：`exit_plan_mode` 的完整 plan Markdown（内核问题 `detail`） */
  detail?: string
  options?: ReadonlyArray<{ label: string; description?: string }>
  multiSelect?: boolean
  /** PB-044：plan review 意图（`kind:'plan-review'` + approve label + callId）；其他问题没有 */
  intent?: { kind?: string; approve?: string; callId?: string }
}

export interface QuestionRequestEvent {
  kind: 'question'
  eventId: string
  threadId: string
  questions: ReadonlyArray<QuestionRequestItem>
}

export type KernelInteractionEvent = ApprovalRequestEvent | QuestionRequestEvent

/** 把 waterfall 帧转成我方可消费的事件；不是这两类 / 字段不全 → null（不猜） */
export function interactionFromFrame(frame: RemoteEventFrame): KernelInteractionEvent | null {
  if (frame.type !== 'waterfall') return null
  if (frame.event === APPROVAL_REQUEST_EVENT) {
    const request = frame.request
    const toolName =
      typeof request.toolName === 'string'
        ? request.toolName
        : typeof request.tool === 'string'
          ? request.tool
          : undefined
    if (toolName === undefined) return null
    return {
      kind: 'approval',
      eventId: frame.eventId,
      threadId: frame.agentId,
      toolName,
      ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
      ...(typeof request.reason === 'string' ? { reason: request.reason } : {})
    }
  }
  if (frame.event === USER_QUESTIONS_REQUEST_EVENT) {
    const raw = frame.request.questions
    if (!Array.isArray(raw) || raw.length === 0) return null
    const questions = raw.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const question = item as {
        id?: unknown
        question?: unknown
        header?: unknown
        detail?: unknown
        options?: unknown
        multiSelect?: unknown
        intent?: unknown
      }
      if (typeof question.id !== 'string' || typeof question.question !== 'string') return []
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
            if (typeof option !== 'object' || option === null) return []
            const candidate = option as { label?: unknown; description?: unknown }
            if (typeof candidate.label !== 'string') return []
            return [
              {
                label: candidate.label,
                ...(typeof candidate.description === 'string'
                  ? { description: candidate.description }
                  : {})
              }
            ]
          })
        : []
      const intentRecord =
        typeof question.intent === 'object' && question.intent !== null
          ? (question.intent as { kind?: unknown; approve?: unknown; callId?: unknown })
          : null
      const intent = {
        ...(typeof intentRecord?.kind === 'string' ? { kind: intentRecord.kind } : {}),
        ...(typeof intentRecord?.approve === 'string' ? { approve: intentRecord.approve } : {}),
        ...(typeof intentRecord?.callId === 'string' ? { callId: intentRecord.callId } : {})
      }
      return [
        {
          id: question.id,
          question: question.question,
          ...(typeof question.header === 'string' ? { header: question.header } : {}),
          ...(typeof question.detail === 'string' && question.detail.trim() !== ''
            ? { detail: question.detail }
            : {}),
          ...(options.length === 0 ? {} : { options }),
          ...(question.multiSelect === true ? { multiSelect: true } : {}),
          ...(Object.keys(intent).length === 0 ? {} : { intent })
        }
      ]
    })
    if (questions.length === 0) return null
    return { kind: 'question', eventId: frame.eventId, threadId: frame.agentId, questions }
  }
  return null
}

/** 审批四态（与内核词汇表一致；远程回执只认这四个裸字符串） */
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalAnswer {
  answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }>
}

/**
 * `$events/result` 的 RPC args（**就是这三个字段本身**，不要再包 `{args:…}`，见文件头）。
 * `outcome.kind: 'result'` = 本次应答生效；`'next'` = 我不答，交给下一个应答者。
 */
export interface RemoteEventResultArgs {
  clientId: string
  eventId: string
  outcome: { kind: 'result'; value: unknown } | { kind: 'next' }
}

/** 审批决定 → 回执 args（value = 裸四态字符串；写错内核会归一成 unavailable，不会误放行） */
export function approvalResultArgs(
  clientId: string,
  eventId: string,
  outcome: ApprovalDecision
): RemoteEventResultArgs {
  return { clientId, eventId, outcome: { kind: 'result', value: outcome } }
}

/** 提问回答 → 回执 args（value = `{answers:[…]}`，活内核实测同形） */
export function questionResultArgs(
  clientId: string,
  eventId: string,
  answer: ApprovalAnswer
): RemoteEventResultArgs {
  return { clientId, eventId, outcome: { kind: 'result', value: answer } }
}

/** 让出这次应答（交给内核里其它应答者；都没有就 fail-closed → unavailable） */
export function passResultArgs(clientId: string, eventId: string): RemoteEventResultArgs {
  return { clientId, eventId, outcome: { kind: 'next' } }
}

/**
 * 给主进程的应答入口参数（adapter 内部再补 clientId）。
 * `kind` 决定 `outcome.value` 的形状：审批=裸字符串，提问=`{answers}`。
 */
export type InteractionResponse =
  | { eventId: string; kind: 'approval'; outcome: ApprovalDecision }
  | { eventId: string; kind: 'question'; answer: ApprovalAnswer }
