/**
 * 用量 API 客户端（渲染端）：直连主进程内嵌的 agent 服务（和 chat / 线程同一条路）。
 *
 * 窗口是本地日历的"今天 / 本月"（服务端按本机时区切边界），所以只传 range，不传时间戳——
 * 渲染端与服务端不会因为时区/时钟不同步而各算各的。
 */
import type { z } from 'zod'
import {
  usageCalendarSchema,
  usageResponseSchema,
  usageThreadContextSchema,
  type UsageCalendar,
  type UsageRange,
  type UsageResponse,
  type UsageThreadContext
} from '@shared/usage'

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
    // 失败时尽量把服务端那句人话带出来（400 的 invalid-input 详情就在 body 里）
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    const detail = typeof body?.error === 'string' ? body.error : `用量服务返回 ${response.status}`
    throw new Error(detail.replace(/^invalid-input:\s*/, ''))
  }
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`用量服务回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** 某个窗口的用量汇总（含按模型拆分） */
export async function fetchUsage(range: UsageRange): Promise<UsageResponse> {
  const response = await authorized(`/api/usage?range=${encodeURIComponent(range)}`)
  return json(response, usageResponseSchema)
}

/**
 * 某条会话的上下文用量（round 18）：最近一轮输入 / 首轮基线 / 今日缓存合计——
 * 上下文环与 hover 明细的数据面（口径见 shared/usage.ts 的 usageThreadContextSchema）。
 */
export async function fetchThreadContext(threadId: string): Promise<UsageThreadContext> {
  const response = await authorized(`/api/usage/context?threadId=${encodeURIComponent(threadId)}`)
  return json(response, usageThreadContextSchema)
}

/**
 * 某本地年的按日聚合（task-127）：首页日历热力图的数据面。
 * 只回有记录的天（渲染端补零）；口径见 shared/usage.ts 的 usageCalendarSchema。
 */
export async function fetchUsageCalendar(year: number): Promise<UsageCalendar> {
  const response = await authorized(`/api/usage/calendar?year=${encodeURIComponent(String(year))}`)
  return json(response, usageCalendarSchema)
}
