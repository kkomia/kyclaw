/**
 * 记忆 API 客户端（渲染端）：直连主进程内嵌的 agent 服务（和 chat / 线程同一条路）。
 *
 * - 端点是现取的（随机端口 + 每次启动的 token），token 走 Authorization 头，不进 URL/日志；
 * - 回包过 shared/memory 的 zod schema（边界纪律同 IPC/线程）：格式不对就抛，
 *   由页面落到错误态，不把半截数据往 UI 里塞。
 */
import type { z } from 'zod'
import { clearMemoryResponseSchema, workingMemoryResponseSchema } from '@shared/memory'

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

/** 当前 working memory（null = 还没写过 / 已被清空） */
export async function fetchMemory(): Promise<string | null> {
  const response = await authorized('/api/memory')
  const { content } = await json(response, workingMemoryResponseSchema)
  return content
}

/** 整块保存（返回服务端归一后的内容：全空白会回 null） */
export async function saveMemory(content: string): Promise<string | null> {
  const response = await authorized('/api/memory', {
    method: 'PUT',
    body: JSON.stringify({ content })
  })
  const parsed = await json(response, workingMemoryResponseSchema)
  return parsed.content
}

/** 清空（服务端幂等） */
export async function clearMemory(): Promise<void> {
  const response = await authorized('/api/memory', { method: 'DELETE' })
  await json(response, clearMemoryResponseSchema)
}
