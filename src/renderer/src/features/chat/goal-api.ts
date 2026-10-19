/**
 * PB-039 goal API 客户端（渲染端）：与 `/api/threads` 同一条主进程内嵌服务。
 * 契约见 `.superpowers/dev-verify/20261019-0.1.6/b1/goal-api-contract.md`（Bao，v1 冻结）。
 */
import { goalStateSchema, type GoalState, type GoalRequest } from '@shared/goal'

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

async function readState(response: Response): Promise<GoalState> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      message?: string
    } | null
    const error = new Error(body?.message ?? `goal 服务返回 ${response.status}`)
    ;(error as Error & { code?: string }).code = body?.error
    throw error
  }
  return goalStateSchema.parse(await response.json())
}

export async function fetchGoal(threadId: string): Promise<GoalState> {
  return readState(
    await authorized(`/api/goal?threadId=${encodeURIComponent(threadId)}`, { method: 'GET' })
  )
}

export async function postGoal(request: GoalRequest): Promise<GoalState> {
  return readState(
    await authorized('/api/goal', { method: 'POST', body: JSON.stringify(request) })
  )
}

/** 409 GOAL_STALE_REVISION → 重新 GET 后重试一次（契约要求） */
export async function postGoalWithRetry(
  request: GoalRequest,
  threadId: string
): Promise<GoalState> {
  try {
    return await postGoal(request)
  } catch (error) {
    if ((error as Error & { code?: string }).code !== 'GOAL_STALE_REVISION') throw error
    const state = await fetchGoal(threadId)
    if (state.goal === null) throw error
    const ref = { id: state.goal.id, revision: state.goal.revision }
    return postGoal(
      'ref' in request ? ({ ...request, ref } as GoalRequest) : request
    )
  }
}
