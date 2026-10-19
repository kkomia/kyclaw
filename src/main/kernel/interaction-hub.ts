/**
 * B3.5 / PB-004：**交互中枢（main 侧）**——审批（approval）与提问（ask_user）的状态源。
 *
 * 设计依据：`gwen/b3-5-approval-design.md`（§3.1 状态归 main、§4 状态表与文案规则）、
 * `ada/approval-cause-research.md`（四态落在 `approval/decided.outcome`，提问超时是 `pending` 不是拒绝）。
 *
 * 三条硬口径（本模块就是它们的落点）：
 * 1. **状态存活在 main**：renderer 只是订阅者。切会话/切页面/最小化**不得**改变请求状态，
 *    更不得触发 deny/abort —— `snapshot()` 是纯读，没有任何"读的时候顺手结束"的副作用。
 * 2. **四态来自内核事件**：`approval/asked` 建挂起，`approval/decided.outcome` 结算
 *    （`allowed-once | rejected | cancelled | unavailable`）。不靠工具结果反推、不自己造状态。
 * 3. **文案归因红线**：只有 `rejected` 能写「你拒绝」；`cancelled` / `unavailable` 必须写成
 *    「系统/应用取消」或「系统按安全策略自动拒绝，不是你点的」。见 `approvalOutcomeCopy`。
 *
 * 边界（本模块不做的）：
 * - 不碰 RPC/网络：内核事件由 `kernel-adapter` 的 `onSessionEvent` / `onInteractionEvent` 喂进来；
 * - 不直接发应答：应答走 adapter 的 `respondInteraction`（`$events/result`）与
 *   `answerContinuedQuestion`（`userQuestions/answer`），本模块只提供 `respondAndDismiss` /
 *   `answerContinued` 两个**纯编排** helper（PB-025 起应答通道已可用）；
 * - 不写 renderer 代码：只提供 `subscribe()` / `snapshot()` 供后续 route/IPC 接线。
 */

import type { InteractionResponse, KernelInteractionEvent } from './kernel-interactions'

/** 内核审批四态词汇（`dsh-user-approval/lib/types/index.js`，只有这四个） */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = [
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable'
]

export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && (APPROVAL_OUTCOMES as readonly string[]).includes(value)
}

/** 归因：谁结束的这次审批（红线：只有 user 才能写"你"） */
export type ApprovalAttribution = 'user' | 'system' | 'policy'

export interface ApprovalCopy {
  title: string
  detail: string
  attribution: ApprovalAttribution
  /** 是否该给「重新发起」（自动拒绝/取消/失效都要给，手动拒绝可选） */
  canRetry: boolean
}

/**
 * 四态 → 用户文案。**红线**：`unavailable`/`cancelled` 一律不许出现「你拒绝」。
 * 文案取自 gwen 设计 §4.1（逐字对齐），不在这里即兴发挥。
 */
export function approvalOutcomeCopy(outcome: ApprovalOutcome): ApprovalCopy {
  switch (outcome) {
    case 'allowed-once':
      return {
        title: '已允许一次',
        detail: '模型继续执行这次调用。',
        attribution: 'user',
        canRetry: false
      }
    case 'rejected':
      return {
        title: '你拒绝了这次操作',
        detail: '模型会继续，这次调用不会执行。',
        attribution: 'user',
        canRetry: true
      }
    case 'cancelled':
      return {
        title: '这次审批已取消',
        detail: '没有执行这次操作（可能是你点了取消、连接断开，或应用被关闭）。',
        attribution: 'system',
        canRetry: true
      }
    case 'unavailable':
      return {
        title: '这次操作被自动拒绝了',
        detail:
          '因为你当时不在（审批界面不可用），系统按安全策略默认拒绝了这次操作；这不是你点的。没有执行任何操作。',
        attribution: 'system',
        canRetry: true
      }
  }
}

/** 内核 `approval/asked` 事件（字段照 rc.2：`dsh-user-approval/lib/index.js`） */
export interface ApprovalAskedEvent {
  id: string
  toolName: string
  callId?: string
  reason?: string
}

/** 内核 `approval/decided` 事件 */
export interface ApprovalDecidedEvent {
  id: string
  outcome: ApprovalOutcome
}

/** 挂起中的审批（renderer 只读） */
export interface PendingApproval {
  threadId: string
  /** waterfall 请求用 `eventId`（可应答）；只有审计事件时用 `approval/asked` 的 id（只观察） */
  id: string
  /** `waterfall` = 我们收得到也能答（PB-025）；`asked` = 只从 session 事件看到（无应答通道时） */
  source: 'waterfall' | 'asked'
  toolName: string
  callId?: string
  reason?: string
  /** 内核事件 seq（用于"问→答"耗时与排序） */
  askedAtSeq?: number
}

/** 已结算的审批（消息流结果行用） */
export interface ApprovalResult {
  threadId: string
  id: string
  /** 与挂起项的关联方式：`id` 最准，`sole` = 该 thread 当时只有一个挂起项，`none` = 只能出结果行 */
  matchedBy: 'id' | 'sole' | 'none'
  toolName?: string
  callId?: string
  outcome: ApprovalOutcome
  copy: ApprovalCopy
  /** 是否「不是你点的」——回归提示条按这个筛（取消/自动拒绝/策略拒绝） */
  systemInitiated: boolean
  askedAtSeq?: number
  decidedAtSeq?: number
}

/** 真机（阻塞式）提问的挂起项：来自 `$events` waterfall，带可应答的 `eventId` */
export interface PendingQuestion {
  threadId: string
  eventId: string
  /** 请求到达时间（ISO；旧 `/ask-user/pending` 回包要这个字段） */
  suspendedAt: string
  questions: ReadonlyArray<{
    id: string
    question: string
    header?: string
    options?: ReadonlyArray<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

/** 提问活动项（内核投影 `userQuestions.questions.active`，字段照 rc.2） */
export interface AskUserQuestionItem {
  callId: string
  questions: ReadonlyArray<{ id: string; question: string; header?: string }>
  /** `open` = 正常等待；`continued` = timed 到期后模型已继续，但问题仍可答（**不是拒绝**） */
  state: 'open' | 'continued'
}

/** 已结算的提问（投影 `settled`） */
export interface AskUserSettledItem {
  callId: string
  answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }>
}

export interface AskUserState {
  /** 等回答 / 等待超时仍可答（`continued`）；都**不是**拒绝 */
  active: readonly AskUserQuestionItem[]
  settled: readonly AskUserSettledItem[]
  /** 投影里该会话是否启用了 timed 提问 */
  timed: boolean
}

export interface InteractionSnapshot {
  threadId: string
  approvals: { pending: readonly PendingApproval[]; results: readonly ApprovalResult[] }
  askUser: AskUserState
  /** PB-025：来自 `$events` waterfall 的**可应答**提问（与投影里的 active 是两回事） */
  questions: { pending: readonly PendingQuestion[] }
}

export interface InteractionHubOptions {
  /** 每线程最多保留多少条历史结果行（默认 50，避免无限增长） */
  maxResultsPerThread?: number
}

type Listener = (threadId: string) => void

const EMPTY_ASK_USER: AskUserState = { active: [], settled: [], timed: false }

/**
 * 交互中枢：只做「内核事件/投影 → 我方状态」的折叠，不发任何请求。
 *
 * 并发口径：每 thread 一份状态；**同一请求只结算一次**（重复的 `approval/decided` 忽略，
 * 内核 invariant 本来也不允许，但远程链路可能重放）。
 */
export class InteractionHub {
  private readonly pending = new Map<string, Map<string, PendingApproval>>()
  private readonly results = new Map<string, ApprovalResult[]>()
  private readonly askUser = new Map<string, AskUserState>()
  private readonly pendingQuestions = new Map<string, Map<string, PendingQuestion>>()
  private readonly settledIds = new Map<string, Set<string>>()
  private readonly listeners = new Set<Listener>()
  private readonly maxResults: number

  constructor(options: InteractionHubOptions = {}) {
    this.maxResults = options.maxResultsPerThread ?? 50
  }

  /** 订阅状态变化（参数是 threadId；renderer 断线/重连不影响这里的状态） */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 读某 thread 的当前状态（纯读：**不会**顺手结束任何请求） */
  snapshot(threadId: string): InteractionSnapshot {
    return {
      threadId,
      approvals: {
        pending: [...(this.pending.get(threadId)?.values() ?? [])],
        results: [...(this.results.get(threadId) ?? [])]
      },
      askUser: this.askUser.get(threadId) ?? EMPTY_ASK_USER,
      questions: { pending: [...(this.pendingQuestions.get(threadId)?.values() ?? [])] }
    }
  }

  /**
   * PB-025：`$events` 的 `approval/request` waterfall → **可应答**挂起（id = eventId）。
   * 这是 renderer dock 真正要显示、用户能点的那一条。
   */
  applyApprovalRequest(
    threadId: string,
    request: { eventId: string; toolName: string; callId?: string; reason?: string }
  ): void {
    const byId = this.pending.get(threadId) ?? new Map<string, PendingApproval>()
    this.pending.set(threadId, byId)
    if (byId.has(request.eventId)) return
    byId.set(request.eventId, {
      threadId,
      id: request.eventId,
      source: 'waterfall',
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason })
    })
    this.notify(threadId)
  }

  /** 内核 `approval/asked`：建挂起（同 id 重复到达按第一次为准） */
  applyApprovalAsked(threadId: string, event: ApprovalAskedEvent, seq?: number): void {
    const byId = this.pending.get(threadId) ?? new Map<string, PendingApproval>()
    this.pending.set(threadId, byId)
    if (byId.has(event.id)) return
    byId.set(event.id, {
      threadId,
      id: event.id,
      source: 'asked',
      toolName: event.toolName,
      ...(event.callId === undefined ? {} : { callId: event.callId }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(seq === undefined ? {} : { askedAtSeq: seq })
    })
    this.notify(threadId)
  }

  /** 应答成功后摘掉挂起项（只摘本地状态；内核侧由 `$events/result` 结算） */
  dismissPending(threadId: string, id: string): boolean {
    const byId = this.pending.get(threadId)
    if (byId === undefined || !byId.delete(id)) return false
    this.notify(threadId)
    return true
  }

  /** PB-025：`user-questions/request` waterfall → 可应答的提问挂起（id = eventId） */
  applyQuestionRequest(threadId: string, request: PendingQuestion): void {
    const byId = this.pendingQuestions.get(threadId) ?? new Map<string, PendingQuestion>()
    this.pendingQuestions.set(threadId, byId)
    if (byId.has(request.eventId)) return
    byId.set(request.eventId, { ...request, threadId })
    this.notify(threadId)
  }

  /** 回答提交成功后摘掉提问挂起 */
  dismissQuestion(threadId: string, eventId: string): boolean {
    const byId = this.pendingQuestions.get(threadId)
    if (byId === undefined || !byId.delete(eventId)) return false
    this.notify(threadId)
    return true
  }

  /**
   * 内核 `approval/decided`：按 outcome 结算（四态），并尝试与挂起项关联。
   *
   * 关联顺序（**不硬配**）：`id` 直接命中（asked 路径最准）→ 该 thread 内**恰好一个**挂起项时
   * 认它（`matchedBy:'sole'`）→ 否则只出结果行（`matchedBy:'none'`、toolName 留空）。
   * 为什么这样：waterfall 的 `eventId` 与审计事件的 `id` 不同源，而 `approval/decided`
   * 只带 `{id, outcome}`（Ada 取证），没有 callId/toolName 可对；多个挂起项时**不猜**。
   * 同一 id 重复 decided 视为重放，忽略（不重复出结果行）。
   */
  applyApprovalDecided(
    threadId: string,
    event: ApprovalDecidedEvent,
    seq?: number
  ): ApprovalResult | null {
    const settled = this.settledIds.get(threadId) ?? new Set<string>()
    this.settledIds.set(threadId, settled)
    if (settled.has(event.id)) return null
    settled.add(event.id)

    const byId = this.pending.get(threadId)
    const copy = approvalOutcomeCopy(event.outcome)
    let matched: PendingApproval | undefined
    let matchedBy: ApprovalResult['matchedBy'] = 'none'
    const direct = byId?.get(event.id)
    if (direct !== undefined) {
      matched = direct
      matchedBy = 'id'
      byId?.delete(event.id)
    } else if (byId !== undefined && byId.size === 1) {
      const [sole] = [...byId.values()]
      if (sole !== undefined) {
        matched = sole
        matchedBy = 'sole'
        byId.delete(sole.id)
      }
    }
    const result: ApprovalResult = {
      threadId,
      id: event.id,
      matchedBy,
      outcome: event.outcome,
      copy,
      systemInitiated: copy.attribution !== 'user',
      ...(matched?.toolName === undefined ? {} : { toolName: matched.toolName }),
      ...(matched?.callId === undefined ? {} : { callId: matched.callId }),
      ...(matched?.askedAtSeq === undefined ? {} : { askedAtSeq: matched.askedAtSeq }),
      ...(seq === undefined ? {} : { decidedAtSeq: seq })
    }
    const list = this.results.get(threadId) ?? []
    this.results.set(threadId, list)
    list.push(result)
    if (list.length > this.maxResults) list.splice(0, list.length - this.maxResults)
    this.notify(threadId)
    return result
  }

  /**
   * 内核投影 `session/projections.values.userQuestions`（view = `{active, settled}`）：
   * 提问状态**整体替换**（投影是全量视图），`continued` 原样保留为"仍可答"。
   */
  applyUserQuestionsProjection(
    threadId: string,
    values: unknown,
    options: { timed?: boolean } = {}
  ): void {
    const parsed = parseUserQuestions(values)
    if (parsed === null) return
    this.askUser.set(threadId, { ...parsed, timed: options.timed === true })
    this.notify(threadId)
  }

  /** 某 thread 是否还有未结算的审批（renderer dock 用；**不要**用它做"离开即拒绝"） */
  hasPending(threadId: string): boolean {
    return (this.pending.get(threadId)?.size ?? 0) > 0
  }

  private notify(threadId: string): void {
    for (const listener of this.listeners) listener(threadId)
  }
}

/** 把投影里的 userQuestions view 收窄成我方形状；形状不对返回 null（不猜） */export function parseUserQuestions(
  values: unknown
): { active: AskUserQuestionItem[]; settled: AskUserSettledItem[] } | null {
  if (typeof values !== 'object' || values === null) return null
  const view = values as { active?: unknown; settled?: unknown }
  if (!Array.isArray(view.active) || !Array.isArray(view.settled)) return null
  const active: AskUserQuestionItem[] = []
  for (const item of view.active) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { callId?: unknown; questions?: unknown; state?: unknown }
    if (typeof record.callId !== 'string' || !Array.isArray(record.questions)) continue
    const questions = record.questions.flatMap((question) => {
      if (typeof question !== 'object' || question === null) return []
      const q = question as { id?: unknown; question?: unknown; header?: unknown }
      if (typeof q.id !== 'string' || typeof q.question !== 'string') return []
      return [
        {
          id: q.id,
          question: q.question,
          ...(typeof q.header === 'string' ? { header: q.header } : {})
        }
      ]
    })
    active.push({
      callId: record.callId,
      questions,
      state: record.state === 'continued' ? 'continued' : 'open'
    })
  }
  const settled: AskUserSettledItem[] = []
  for (const item of view.settled) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { callId?: unknown; answers?: unknown }
    if (typeof record.callId !== 'string' || !Array.isArray(record.answers)) continue
    const answers = record.answers.flatMap((answer) => {
      if (typeof answer !== 'object' || answer === null) return []
      const a = answer as { id?: unknown; selected?: unknown; custom?: unknown }
      if (typeof a.id !== 'string' || !Array.isArray(a.selected)) return []
      return [
        {
          id: a.id,
          selected: a.selected.filter((value): value is string => typeof value === 'string'),
          ...(typeof a.custom === 'string' ? { custom: a.custom } : {})
        }
      ]
    })
    settled.push({ callId: record.callId, answers })
  }
  return { active, settled }
}

/**
 * 把内核 session 事件折叠进 hub（main 侧接线用：`adapter.onSessionEvent` 直接喂这里）。
 *
 * 只认审批两条事件；其余（turn/start、tool/call…）走既有 SSE 映射链路，这里不碰。
 * 返回是否有状态变化（便于上层决定要不要推给 renderer）。
 *
 * 注意：`threadId` 就是内核 `sessionId`（B3.4 的映射口径）。
 */export function feedKernelEvent(
  hub: InteractionHub,
  threadId: string,
  event: { type?: string; seq?: number; data?: Record<string, unknown> }
): boolean {
  if (event.type === 'approval/asked') {
    const data = event.data as
      | { id?: unknown; toolName?: unknown; callId?: unknown; reason?: unknown }
      | undefined
    if (typeof data?.id !== 'string' || typeof data.toolName !== 'string') return false
    hub.applyApprovalAsked(
      threadId,
      {
        id: data.id,
        toolName: data.toolName,
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
        ...(typeof data.reason === 'string' ? { reason: data.reason } : {})
      },
      event.seq
    )
    return true
  }
  if (event.type === 'approval/decided') {
    const data = event.data as { id?: unknown; outcome?: unknown } | undefined
    if (typeof data?.id !== 'string' || !isApprovalOutcome(data.outcome)) return false
    return (
      hub.applyApprovalDecided(threadId, { id: data.id, outcome: data.outcome }, event.seq) !== null
    )
  }
  return false
}

/**
 * PB-025：`adapter.onInteractionEvent` 的直连入口——把 `$events` waterfall 事件折叠进 hub。
 * 审批 → 可应答挂起（id = eventId）；提问 → 可应答提问挂起。返回是否有状态变化。
 */
export function applyInteractionEvent(
  hub: InteractionHub,
  event: KernelInteractionEvent
): boolean {
  if (event.kind === 'approval') {
    hub.applyApprovalRequest(event.threadId, {
      eventId: event.eventId,
      toolName: event.toolName,
      ...(event.callId === undefined ? {} : { callId: event.callId }),
      ...(event.reason === undefined ? {} : { reason: event.reason })
    })
    return true
  }
  hub.applyQuestionRequest(event.threadId, {
    threadId: event.threadId,
    eventId: event.eventId,
    suspendedAt: new Date().toISOString(),
    questions: event.questions
  })
  return true
}

/**
 * PB-025：应答 + 本地摘挂起。**先应答内核、成功后再摘本地状态**：
 * 应答失败时挂起项必须留着（用户还能重试），不能造成"UI 已经当它处理完了"。
 */
export async function respondAndDismiss(
  adapter: { respondInteraction: (response: InteractionResponse) => Promise<void> },
  hub: InteractionHub,
  threadId: string,
  response: InteractionResponse
): Promise<void> {
  await adapter.respondInteraction(response)
  if (response.kind === 'approval') hub.dismissPending(threadId, response.eventId)
  else hub.dismissQuestion(threadId, response.eventId)
}

/**
 * PB-025：`continued`（timed 到期后仍可答）的提问补答——走适配层 `answerContinuedQuestion`
 * （内核 `userQuestions/answer`）。返回值 = 问题是否**仍** continued（`false` = 已在别处结算）。
 * 这里不摘任何本地状态：那条问题的生命周期归内核投影（`userQuestions.active/settled`）。
 */
export async function answerContinued(
  adapter: {
    answerContinuedQuestion: (
      threadId: string,
      callId: string,
      answer: { answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }> }
    ) => Promise<boolean>
  },
  threadId: string,
  callId: string,
  answer: { answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }> }
): Promise<boolean> {
  return adapter.answerContinuedQuestion(threadId, callId, answer)
}
