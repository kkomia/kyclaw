import type { AgentEndpoint } from '@shared/ipc'
import { z } from '@shared/zod'
import {
  planBodySchema,
  planRefSchema,
  planThreadIdSchema,
  sessionPlanSchema,
  type PlanRef,
  type SessionPlan
} from '@shared/plan'
import { resolveAgentEndpoint } from './agent'

export interface PlanResumeRequest {
  url: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}
export interface PlanApiResult {
  state: SessionPlan
  ref: PlanRef | null
}
export interface PlansApi {
  get(threadId: string): Promise<PlanApiResult>
  enter(threadId: string, expectedVersion: number): Promise<PlanApiResult>
  decision(
    threadId: string,
    ref: PlanRef,
    decision: 'approve' | 'revise',
    feedback?: string
  ): Promise<PlanApiResult>
  cancel(threadId: string, expectedVersion: number): Promise<PlanApiResult>
  resumeRequest(threadId: string, ref: PlanRef): Promise<PlanResumeRequest>
}
export class PlansApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
export function planStateRef(state: SessionPlan): PlanRef | null {
  return state.planId === null
    ? null
    : { planId: state.planId, revision: state.revision, version: state.version }
}
export function createPlansApi(
  endpoint: () => Promise<AgentEndpoint> = resolveAgentEndpoint
): PlansApi {
  const prepare = async (path: string, body?: unknown): Promise<PlanResumeRequest> => {
    const { baseUrl, token } = await endpoint()
    return {
      url: `${baseUrl}/plans/${path}`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      }
    }
  }
  const request = async (thread: string, path: string, body?: unknown): Promise<PlanApiResult> => {
    const threadId = planThreadIdSchema.parse(thread)
    const prepared = await prepare(path, body)
    const response =
      path === 'state'
        ? await fetch(`${prepared.url}?threadId=${encodeURIComponent(threadId)}`, {
            headers: prepared.init.headers
          })
        : await fetch(prepared.url, prepared.init)
    if (!response.ok)
      throw new PlansApiError(response.status, `计划服务返回 ${response.status}，请刷新后重试`)
    const parsed = z.strictObject({ state: sessionPlanSchema }).parse(await response.json())
    if (parsed.state.threadId !== threadId) throw new Error('计划回包会话不一致')
    return { state: parsed.state, ref: planStateRef(parsed.state) }
  }
  const version = (value: number): number => z.number().int().nonnegative().parse(value)
  return {
    get: (threadId) => request(threadId, 'state'),
    enter: (threadId, expectedVersion) =>
      request(threadId, 'enter', {
        threadId: planThreadIdSchema.parse(threadId),
        expectedVersion: version(expectedVersion)
      }),
    decision: (threadId, ref, decision, feedback) =>
      request(threadId, 'decision', {
        threadId: planThreadIdSchema.parse(threadId),
        ref: planRefSchema.parse(ref),
        decision: z.enum(['approve', 'revise']).parse(decision),
        ...(decision === 'revise' ? { feedback: planBodySchema.parse(feedback) } : {})
      }),
    cancel: (threadId, expectedVersion) =>
      request(threadId, 'cancel', {
        threadId: planThreadIdSchema.parse(threadId),
        expectedVersion: version(expectedVersion)
      }),
    resumeRequest: (threadId, ref) =>
      prepare('resume', {
        threadId: planThreadIdSchema.parse(threadId),
        ref: planRefSchema.parse(ref)
      })
  }
}
export const plansApi = createPlansApi()
