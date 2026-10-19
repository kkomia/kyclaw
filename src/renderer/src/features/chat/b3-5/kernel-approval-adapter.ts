/**
 * B3.5 内核审批事件 → 四态视图（renderer 侧适配层）。
 *
 * 内核事件（Ada `approval-cause-research.md` §1；Bao 的 KernelPort 事件落地后形状同义）：
 *   `approval/asked   { id, toolName, callId?, reason? }`
 *   `approval/decided { id, outcome: allowed-once | rejected | cancelled | unavailable }`
 * 两事件都只写日志、走 `session/follow`（不进模型上下文）。
 *
 * 我们的应答者自记（S2）：`answeredBy[id] = 'renderer' | 'host-auto'`，用于区分「用户点的」与
 * 「宿主规则自动应答」；只覆盖我方 answerer，**无记录不等于没人答**（不据此推断 unavailable）。
 */
import type { ApprovalOutcome, ApprovalOutcomeInput } from './approval-outcome'

/** 宽松事件形状：Bao 的事件类型落地前也能吃（只读我们要的字段） */
export interface KernelApprovalEventLike {
  type?: unknown
  seq?: unknown
  data?: unknown
  id?: unknown
  toolName?: unknown
  callId?: unknown
  reason?: unknown
  outcome?: unknown
}

const OUTCOMES: readonly string[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

function recordOf(event: KernelApprovalEventLike): Record<string, unknown> {
  return event.data !== null && typeof event.data === 'object'
    ? (event.data as Record<string, unknown>)
    : (event as Record<string, unknown>)
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export interface AskRecord {
  id: string
  toolName: string
  callId?: string
  reason?: string
  seq?: number
}

/** 从事件流里配出每次审批（asked + decided 按 id 对齐；缺 decided 的不产出结果） */
export function approvalOutcomesFromEvents(
  events: readonly KernelApprovalEventLike[],
  options: {
    /** S2：我方应答者自记（approvalId → 谁答的） */
    answeredBy?: Readonly<Record<string, 'renderer' | 'host-auto'>>
  } = {}
): ApprovalOutcomeInput[] {
  const asked = new Map<string, AskRecord>()
  const results: ApprovalOutcomeInput[] = []

  for (const event of events) {
    const record = recordOf(event)
    const type = stringOf(record.type)
    const id = stringOf(record.id)
    if (type === null || id === null) continue

    if (type === 'approval/asked') {
      const toolName = stringOf(record.toolName)
      if (toolName === null) continue
      asked.set(id, {
        id,
        toolName,
        callId: stringOf(record.callId) ?? undefined,
        reason: stringOf(record.reason) ?? undefined,
        seq: typeof event.seq === 'number' ? event.seq : undefined
      })
      continue
    }

    if (type === 'approval/decided') {
      const outcome = stringOf(record.outcome)
      if (outcome === null || !OUTCOMES.includes(outcome)) continue
      const ask = asked.get(id)
      if (ask === undefined) continue
      results.push({
        outcome: outcome as ApprovalOutcome,
        toolName: ask.toolName,
        cause: ask.reason,
        answeredBy: options.answeredBy?.[id] ?? null
      })
    }
  }

  return results
}
