/**
 * 记忆 API 客户端（渲染端）：直连主进程内嵌的 agent 服务（和 chat / 线程同一条路）。
 *
 * - 端点是现取的（随机端口 + 每次启动的 token），token 走 Authorization 头，不进 URL/日志；
 * - 回包过 shared/memory 的 zod schema（边界纪律同 IPC/线程）：格式不对就抛，
 *   由页面落到错误态，不把半截数据往 UI 里塞；
 * - **记忆按会话隔离（round 58）**：三个接口都要求会话 id（`?threadId=…`）——看/写/清的都是
 *   那一个会话那一份（工作记忆 thread 作用域，见 mastra/index.ts 的装配）。
 */
import type { z } from 'zod'
import {
  clearMemoryResponseSchema,
  recallStatusResponseSchema,
  workingMemoryResponseSchema,
  type RecallStatus
} from '@shared/memory'

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
    const detail = typeof body?.error === 'string' ? body.error : `记忆服务返回 ${response.status}`
    throw new Error(detail.replace(/^invalid-input:\s*/, ''))
  }
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`记忆服务回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** 记忆接口的路径：会话 id 必填（round 58 记忆按会话隔离，服务端缺/空即 400） */
function memoryPath(threadId: string): string {
  return `/api/memory?threadId=${encodeURIComponent(threadId)}`
}

/** 某个会话的 working memory（null = 还没写过 / 已被清空） */
export async function fetchMemory(threadId: string): Promise<string | null> {
  const response = await authorized(memoryPath(threadId))
  const { content } = await json(response, workingMemoryResponseSchema)
  return content
}

/** 某个会话的整块保存（返回服务端归一后的内容：全空白会回 null） */
export async function saveMemory(threadId: string, content: string): Promise<string | null> {
  const response = await authorized(memoryPath(threadId), {
    method: 'PUT',
    body: JSON.stringify({ content })
  })
  const parsed = await json(response, workingMemoryResponseSchema)
  return parsed.content
}

/** 清空某个会话的记忆（服务端幂等） */
export async function clearMemory(threadId: string): Promise<void> {
  const response = await authorized(memoryPath(threadId), { method: 'DELETE' })
  await json(response, clearMemoryResponseSchema)
}

/**
 * 语义召回（设置页标签是「会话记忆（语义召回）」）的本次运行状态（round 28）：
 * 开关在设置里、状态在服务里——
 * 状态行必须说清"这次启动到底有没有召回"，所以这里读的是服务端的现读值，不是设置的期望值。
 */
export async function fetchRecallStatus(): Promise<RecallStatus> {
  const response = await authorized('/api/memory/recall')
  const { recall } = await json(response, recallStatusResponseSchema)
  return recall
}
