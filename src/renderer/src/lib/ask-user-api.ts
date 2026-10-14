import type { AgentEndpoint } from '@shared/ipc'
import { validateAskUserInput, type AskUserInput, type AskUserAnswer } from '@shared/ask-user'
import { resolveAgentEndpoint } from './agent'

export interface PendingAskUser {
  runId: string
  toolCallId: string
  input: AskUserInput
  suspendedAt: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function request(
  path: string,
  init?: RequestInit,
  endpoint?: AgentEndpoint
): Promise<unknown> {
  const { baseUrl, token } = endpoint ?? (await resolveAgentEndpoint())
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }
  })
  if (!response.ok) throw new Error(`问题服务返回 ${response.status}，请刷新待答问题后重试`)
  return response.json()
}

export async function fetchPendingAskUser(threadId: string): Promise<PendingAskUser[]> {
  const result = await request(`/ask-user/pending?threadId=${encodeURIComponent(threadId)}`)
  if (!record(result) || !Array.isArray(result.pending)) throw new Error('待答问题回包格式不对')
  const keys = new Set<string>()
  return result.pending.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.runId !== 'string' ||
      !item.runId ||
      typeof item.toolCallId !== 'string' ||
      !item.toolCallId ||
      typeof item.suspendedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.suspendedAt))
    )
      throw new Error('待答问题调用标识格式不对')
    const key = JSON.stringify([item.runId, item.toolCallId])
    if (keys.has(key)) throw new Error('待答问题调用重复')
    keys.add(key)
    return {
      runId: item.runId,
      toolCallId: item.toolCallId,
      suspendedAt: item.suspendedAt,
      input: validateAskUserInput(item.input)
    }
  })
}

export async function cancelAskUser(threadId: string, runId?: string): Promise<string[]> {
  const result = await request('/ask-user/cancel', {
    method: 'POST',
    body: JSON.stringify({ threadId, ...(runId === undefined ? {} : { runId }) })
  })
  if (
    !record(result) ||
    result.status !== 'cancelled' ||
    !Array.isArray(result.runIds) ||
    !result.runIds.every((id: unknown) => typeof id === 'string' && id !== '')
  ) {
    throw new Error('停止问题回包格式不对')
  }
  return result.runIds as string[]
}

export function askUserResumeBody(
  threadId: string,
  pending: PendingAskUser,
  answer: AskUserAnswer
): { threadId: string; runId: string; toolCallId: string; resumeData: AskUserAnswer } {
  return { threadId, runId: pending.runId, toolCallId: pending.toolCallId, resumeData: answer }
}
