/**
 * 轨迹用的用量取数（渲染端）：直连主进程内嵌的 agent 服务（与 chat / 线程 / usage 同一条路）。
 *
 * 只多要一样东西：该会话的**逐轮用量行**（`GET /api/usage/thread`）。轨迹的其余原料
 * （存储消息、压缩记录）走既有的 threads-api，不在这里重复一遍。
 */
import type { z } from 'zod'
import { trajectoryThreadUsageResponseSchema, type TrajectoryUsageRun } from '@shared/trajectory'

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

async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    throw new Error(`用量服务返回 ${response.status}`)
  }
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`用量服务回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** 某条会话的逐轮用量行（时间升序；空数组 = 这个会话没记过账，是事实不是错误） */
export async function fetchThreadUsageRuns(threadId: string): Promise<TrajectoryUsageRun[]> {
  const response = await authorized(`/api/usage/thread?threadId=${encodeURIComponent(threadId)}`)
  const { runs } = await json(response, trajectoryThreadUsageResponseSchema)
  return runs
}
