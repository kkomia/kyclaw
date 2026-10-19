/**
 * PB-026：renderer 的内核交互 HTTP 客户端（GET 快照 / POST 应答）。
 *
 * 契约来源：Bao `kernel-interaction-route.ts`（2026-10-19，commit 2d7f081）。
 * 错误处理红线：
 *   - 409 `already-settled` / 404 `unknown-event` → **刷新快照 + 提示「已处理/已过期」**，不重试；
 *   - 502 `respond-failed` / 503 `interactions-unavailable` → 挂起还在，保留卡片可重试；
 *   - 审批只允许 `allowed-once` / `rejected`（`unavailable`/`cancelled` 是系统结果，不传）。
 */
import type {
  KernelApprovalResult,
  KernelInteractionErrorCode,
  KernelInteractionRespondBody,
  KernelInteractionResponded,
  KernelInteractionSnapshot,
  KernelApprovalRespondOutcome,
  KernelQuestionAnswer
} from '@shared/kernel-interactions'

export class KernelInteractionError extends Error {
  readonly code: KernelInteractionErrorCode | 'http-error' | 'network-error'
  readonly status: number
  /** 409 already-settled 的终态（Bao 2231395；null = decided 还没到） */
  readonly result: KernelApprovalResult | null
  readonly eventId?: string

  constructor(
    code: KernelInteractionError['code'],
    status: number,
    message: string,
    details: { result?: KernelApprovalResult | null; eventId?: string } = {}
  ) {
    super(message)
    this.name = 'KernelInteractionError'
    this.code = code
    this.status = status
    this.result = details.result ?? null
    if (details.eventId !== undefined) this.eventId = details.eventId
  }
}

async function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl, token } = await window.kyclaw.agent.endpoint()
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers
    }
  })
}

function asResult(value: unknown): KernelApprovalResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { outcome?: unknown; copy?: unknown }
  if (typeof record.outcome !== 'string') return null
  if (typeof record.copy !== 'object' || record.copy === null) return null
  return value as KernelApprovalResult
}

async function parseError(response: Response): Promise<KernelInteractionError> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown
    message?: unknown
    eventId?: unknown
    result?: unknown
  } | null
  const code =
    typeof body?.error === 'string' ? (body.error as KernelInteractionErrorCode) : 'http-error'
  const message =
    typeof body?.message === 'string'
      ? body.message
      : response.status === 503
        ? '内核交互服务尚未就绪，请稍后重试。'
        : response.status === 409
          ? '这次交互已在别处处理。'
          : response.status === 404
            ? '这次交互已过期或不存在。'
            : `内核交互服务返回 ${String(response.status)}`
  return new KernelInteractionError(code, response.status, message, {
    result: asResult(body?.result),
    ...(typeof body?.eventId === 'string' ? { eventId: body.eventId } : {})
  })
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** 读快照（只读；形状不合法时退回空集合，不让坏包把页面打崩） */
export async function fetchKernelInteractions(
  threadId: string
): Promise<KernelInteractionSnapshot> {
  let response: Response
  try {
    response = await authorized(`/api/kernel/interactions?threadId=${encodeURIComponent(threadId)}`)
  } catch (cause) {
    throw new KernelInteractionError(
      'network-error',
      0,
      cause instanceof Error ? cause.message : String(cause)
    )
  }
  if (!response.ok) throw await parseError(response)
  const body = (await response
    .json()
    .catch(() => null)) as Partial<KernelInteractionSnapshot> | null
  if (body === null || typeof body !== 'object') {
    throw new KernelInteractionError('http-error', response.status, '交互快照回包格式不对')
  }
  return {
    threadId: typeof body.threadId === 'string' ? body.threadId : threadId,
    approvals: {
      pending: asArray(body.approvals?.pending),
      results: asArray(body.approvals?.results)
    },
    askUser: {
      active: asArray(body.askUser?.active),
      settled: asArray(body.askUser?.settled),
      timed: body.askUser?.timed === true
    },
    questions: { pending: asArray(body.questions?.pending) }
  }
}

async function respond(
  eventId: string,
  body: KernelInteractionRespondBody
): Promise<KernelInteractionResponded> {
  let response: Response
  try {
    response = await authorized(`/api/kernel/interactions/${encodeURIComponent(eventId)}/respond`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  } catch (cause) {
    throw new KernelInteractionError(
      'network-error',
      0,
      cause instanceof Error ? cause.message : String(cause)
    )
  }
  if (!response.ok) throw await parseError(response)
  const payload = (await response.json().catch(() => null)) as KernelInteractionResponded | null
  if (payload === null || payload.status !== 'responded') {
    throw new KernelInteractionError('http-error', response.status, '应答回包格式不对')
  }
  return payload
}

export function respondKernelApproval(
  eventId: string,
  outcome: KernelApprovalRespondOutcome
): Promise<KernelInteractionResponded> {
  return respond(eventId, { kind: 'approval', outcome })
}

export function respondKernelQuestion(
  eventId: string,
  answers: readonly KernelQuestionAnswer[]
): Promise<KernelInteractionResponded> {
  return respond(eventId, { kind: 'question', answers })
}

/** 409/404：已处理/已过期 → 刷新，不重试；502/503：挂起还在 → 可重试 */
export function isStaleInteractionError(error: unknown): boolean {
  return (
    error instanceof KernelInteractionError &&
    (error.code === 'already-settled' || error.code === 'unknown-event')
  )
}
