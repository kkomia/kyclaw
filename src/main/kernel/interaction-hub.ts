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
 * - 不碰 RPC/网络：内核事件由 `kernel-adapter` 的 `onSessionEvent` 喂进来（见其 options）；
 * - 不回答审批/提问：**应答通道**（内核 `approval/request` waterfall、`userQuestions.answer`）
 *   目前只在 kernel 进程内的插件侧可用，我们还没有 main → 内核的应答端点，见报告「已知缺口」；
 * - 不写 renderer 代码：只提供 `subscribe()` / `snapshot()` 供后续 route/IPC 接线。
 */

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
  id: string
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
  toolName: string
  callId?: string
  outcome: ApprovalOutcome
  copy: ApprovalCopy
  /** 是否「不是你点的」——回归提示条按这个筛（取消/自动拒绝/策略拒绝） */
  systemInitiated: boolean
  askedAtSeq?: number
  decidedAtSeq?: number
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
      askUser: this.askUser.get(threadId) ?? EMPTY_ASK_USER
    }
  }

  /** 内核 `approval/asked`：建挂起（同 id 重复到达按第一次为准） */
  applyApprovalAsked(threadId: string, event: ApprovalAskedEvent, seq?: number): void {
    const byId = this.pending.get(threadId) ?? new Map<string, PendingApproval>()
    this.pending.set(threadId, byId)
    if (byId.has(event.id)) return
    byId.set(event.id, {
      threadId,
      id: event.id,
      toolName: event.toolName,
      ...(event.callId === undefined ? {} : { callId: event.callId }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(seq === undefined ? {} : { askedAtSeq: seq })
    })
    this.notify(threadId)
  }

  /**
   * 内核 `approval/decided`：按 outcome 结算（四态）。
   * 找不到对应 asked 时不伪造结果——内核 invariant 不允许，出现说明事件缺口，返回 null 让上层记日志。
   */
  applyApprovalDecided(
    threadId: string,
    event: ApprovalDecidedEvent,
    seq?: number
  ): ApprovalResult | null {
    const byId = this.pending.get(threadId)
    const asked = byId?.get(event.id)
    if (asked === undefined) return null
    byId?.delete(event.id)
    const copy = approvalOutcomeCopy(event.outcome)
    const result: ApprovalResult = {
      threadId,
      id: event.id,
      toolName: asked.toolName,
      ...(asked.callId === undefined ? {} : { callId: asked.callId }),
      outcome: event.outcome,
      copy,
      systemInitiated: copy.attribution !== 'user',
      ...(asked.askedAtSeq === undefined ? {} : { askedAtSeq: asked.askedAtSeq }),
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
 */
export function feedKernelEvent(
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
