/**
 * PB-026：renderer ↔ main「内核交互快照/应答」契约（Bao `kernel-interaction-route.ts` v1）。
 *
 * renderer **不 import** 内核/`src/main/kernel/**` 类型（I1）；这里只描述经 HTTP 下发的 JSON 形状。
 * 口径：
 *   - 挂起（approvals.pending / questions.pending）→ **dock**；结果（approvals.results / askUser.settled）
 *     → **消息流**（gwen 设计稿 §3.1，Lead 2026-10-19 拍板）；
 *   - 审批只有 `allowed-once` / `rejected` 是用户动作；`unavailable` / `cancelled` 是系统结果，
 *     UI 不得把它们映射成按钮 outcome；
 *   - 提问有两条通道：`questions.pending`（内核阻塞式，可作答）与 `askUser.active`（投影；
 *     `continued` 目前无写路由 → 只读 + 明确提示，不做假按钮）；
 *   - `askUser.timed` 的倒计时形状未定（Bao 补契约中），本版不接。
 */

export type KernelApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export type KernelApprovalAttribution = 'user' | 'system' | 'policy'

export interface KernelApprovalCopy {
  title: string
  detail: string
  attribution: KernelApprovalAttribution
  canRetry: boolean
}

/** 挂起中的审批（id 对 `source:'waterfall'` 是应答用 eventId；`asked` 只观察、无写通道） */
export interface KernelPendingApproval {
  threadId: string
  id: string
  source: 'waterfall' | 'asked'
  toolName: string
  callId?: string
  reason?: string
  askedAtSeq?: number
  /**
   * PB-026：服务端决定的「这条挂起是否可应答」。**UI 只用这个字段**判断是否给按钮，
   * 不按 `source` 猜（真实链路同一次审批会同时出现 asked + waterfall 两条，按 source 猜会双卡）。
   * 字段未到位（undefined）时不渲染审批卡，等契约补齐。
   */
  respondable?: boolean
  /** PB-026：Bao 2231395 的按钮动作白名单（waterfall: allow-once/reject；asked: []） */
  actions?: readonly ('allow-once' | 'reject')[]
}

/** 已结算的审批（消息流结果行） */
export interface KernelApprovalResult {
  threadId: string
  id: string
  matchedBy: 'id' | 'sole' | 'none'
  toolName?: string
  callId?: string
  outcome: KernelApprovalOutcome
  copy: KernelApprovalCopy
  /** true = 取消/自动拒绝/策略拒绝（不是你点的） */
  systemInitiated: boolean
  /** PB-026（Bao 2231395）：谁结算的（system 不得归因给用户） */
  settledBy?: 'user' | 'system'
  /** PB-026：结算原因/时间（结果行详情用） */
  reason?: string
  at?: number
  askedAtSeq?: number
  decidedAtSeq?: number
}

export interface KernelQuestionOption {
  label: string
  description?: string
}

export interface KernelQuestionItem {
  id: string
  question: string
  header?: string
  options?: readonly KernelQuestionOption[]
  multiSelect?: boolean
}

/** 内核阻塞式提问（来自 `$events` waterfall；`eventId` 可用于 respond） */
export interface KernelPendingQuestion {
  threadId: string
  eventId: string
  suspendedAt: string
  questions: readonly KernelQuestionItem[]
}

export interface KernelAskUserActiveItem {
  callId: string
  questions: readonly { id: string; question: string; header?: string }[]
  /** `continued` = timed 到期后模型已继续，问题仍可答；当前**无写路由** → 只读 */
  state: 'open' | 'continued'
}

export interface KernelAskUserSettledItem {
  callId: string
  answers: readonly { id: string; selected: readonly string[]; custom?: string }[]
}

export interface KernelAskUserState {
  active: readonly KernelAskUserActiveItem[]
  settled: readonly KernelAskUserSettledItem[]
  /** timed 是否启用；倒计时数值形状待 Bao 补契约，本版不用 */
  timed: boolean
}

export interface KernelInteractionSnapshot {
  threadId: string
  approvals: {
    pending: readonly KernelPendingApproval[]
    results: readonly KernelApprovalResult[]
  }
  askUser: KernelAskUserState
  questions: { pending: readonly KernelPendingQuestion[] }
}

export type KernelApprovalRespondOutcome = 'allowed-once' | 'rejected'

export interface KernelQuestionAnswer {
  id: string
  selected: readonly string[]
  custom?: string
}

export type KernelInteractionRespondBody =
  | { kind: 'approval'; outcome: KernelApprovalRespondOutcome }
  | { kind: 'question'; answers: readonly KernelQuestionAnswer[] }

/** 写面错误码（Bao 契约；UI 按码给可理解提示，不把 409/404 当网络错误重试） */
export type KernelInteractionErrorCode =
  | 'outcome-not-a-user-decision'
  | 'answers-invalid'
  | 'kind-invalid'
  | 'invalid-json'
  | 'missing-eventId'
  | 'unknown-event'
  | 'already-settled'
  | 'interactions-unavailable'
  | 'respond-failed'
  | 'missing-threadId'

export interface KernelInteractionResponded {
  status: 'responded'
  eventId: string
  kind: 'approval' | 'question'
  threadId: string
}
