/**
 * 轨迹用的取数（渲染端）：直连主进程内嵌的 agent 服务（与 chat / 线程 / usage 同一条路）。
 *
 * 三样：
 *   - 该会话的**逐轮用量行**（`GET /api/usage/thread`）——"这一轮 token 花在哪"；
 *   - 该会话的**逐次模型请求摘要**（`GET /api/trajectory/requests`，用户反馈 015）——
 *     一步一步（一轮里每调一次模型 = 一次请求）的计数与状态；正文按需取；
 *   - 一次请求的**完整形态**（`GET /api/trajectory/requests/detail?id=`）——
 *     系统指令 / 工具表 / 消息清单原文（明细面板打开时才取，一条请求实测 ~96 KB）。
 * 轨迹的其余原料（存储消息、压缩记录）走既有的 threads-api，不在这里重复一遍。
 *
 * 失败回包**带出服务端那句人话**（与 usage-api.ts 同一口径）：以前这里只回
 * "用量服务返回 500"，服务端写的人话（`{ error }`）被丢掉，排障时看不出是哪一步坏的。
 * 每条腿的标签可注入（`label`）——轨迹页把"用量"与"请求快照"分开说，别混成一句"用量服务"
 * （用户反馈 017 点的就是"轨迹被用量带走"这件事）。
 */
import type { z } from 'zod'
import {
  trajectoryRequestDetailResponseSchema,
  trajectoryThreadRequestsResponseSchema,
  trajectoryThreadUsageResponseSchema,
  type TrajectoryRequestDetail,
  type TrajectoryRequestSummary,
  type TrajectoryUsageRun
} from '@shared/trajectory'

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

async function json<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
  if (!response.ok) {
    // 失败时把服务端那句人话带出来（400 的 invalid-input 详情、500 的"读取失败：…"都在 body 里）
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    const detail = typeof body?.error === 'string' ? body.error : `${label}返回 ${response.status}`
    throw new Error(detail.replace(/^invalid-input:\s*/, ''))
  }
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`${label}回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** 某条会话的逐轮用量行（时间升序；空数组 = 这个会话没记过账，是事实不是错误） */
export async function fetchThreadUsageRuns(threadId: string): Promise<TrajectoryUsageRun[]> {
  const response = await authorized(`/api/usage/thread?threadId=${encodeURIComponent(threadId)}`)
  const { runs } = await json(response, trajectoryThreadUsageResponseSchema, '用量服务')
  return runs
}

/** 某条会话的逐次请求摘要（时间升序；空数组 = 没记过 / 老会话，是事实不是错误） */
export async function fetchThreadRequestSummaries(
  threadId: string
): Promise<TrajectoryRequestSummary[]> {
  const response = await authorized(
    `/api/trajectory/requests?threadId=${encodeURIComponent(threadId)}`
  )
  const { requests } = await json(response, trajectoryThreadRequestsResponseSchema, '请求快照服务')
  return requests
}

/** 一次请求的完整形态（系统指令 / 工具表 / 消息清单原文） */
export async function fetchRequestDetail(id: string): Promise<TrajectoryRequestDetail> {
  const response = await authorized(`/api/trajectory/requests/detail?id=${encodeURIComponent(id)}`)
  const { request } = await json(response, trajectoryRequestDetailResponseSchema, '请求快照明细')
  return request
}
