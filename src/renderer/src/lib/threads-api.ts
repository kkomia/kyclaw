/**
 * 线程 API 客户端（渲染端）：直连主进程内嵌的 agent 服务（和 chat transport 同一条路）。
 *
 * - 端点是现取的（随机端口 + 每次启动的 token），token 走 Authorization 头，不进 URL/日志；
 * - 回包一律过 shared/threads 的 zod schema（边界纪律同 IPC）：格式不对就抛，
 *   由调用方（store / 注册表）落到错误态，不把半截数据往 UI 里塞。
 */
import type { z } from 'zod'
import {
  okResponseSchema,
  threadListResponseSchema,
  threadMessagesResponseSchema,
  threadSummarySchema,
  threadTitleResponseSchema,
  truncateThreadResponseSchema,
  type StoredMessage,
  type ThreadSummary
} from '@shared/threads'

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
    throw new Error(`线程服务返回 ${response.status}`)
  }
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`线程服务回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** 会话列表（服务端是权威，侧栏每次刷新都从这里拿） */
export async function fetchThreads(): Promise<ThreadSummary[]> {
  const response = await authorized('/api/threads')
  const { threads } = await json(response, threadListResponseSchema)
  return threads
}

/** 一个线程的存储消息（历史回灌的原料，交给 message-map 映射成 UIMessage） */
export async function fetchThreadMessages(threadId: string): Promise<StoredMessage[]> {
  const response = await authorized(`/api/threads/${encodeURIComponent(threadId)}/messages`)
  const { messages } = await json(response, threadMessagesResponseSchema)
  return messages
}

/** 重命名（返回更新后的列表项） */
export async function renameThread(threadId: string, title: string): Promise<ThreadSummary> {
  const response = await authorized(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title })
  })
  return json(response, threadSummarySchema)
}

/** 删除（级联删消息；服务端幂等） */
export async function deleteThread(threadId: string): Promise<void> {
  const response = await authorized(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: 'DELETE'
  })
  await json(response, okResponseSchema)
}

/**
 * 截断（R2 的编辑重发服务端半边）：删掉这条消息及其后的全部，返回删除条数。
 * 线程/消息不存在时服务端回 deleted=0（幂等）——草稿会话编辑重发也走这条路，不必先判断。
 */
export async function truncateThread(threadId: string, messageId: string): Promise<number> {
  const response = await authorized(`/api/threads/${encodeURIComponent(threadId)}/truncate`, {
    method: 'POST',
    body: JSON.stringify({ messageId })
  })
  const { deleted } = await json(response, truncateThreadResponseSchema)
  return deleted
}

/** 首轮后生成标题（服务端调模型 + 降级；已有标题时 generated=false） */
export async function generateThreadTitle(
  threadId: string
): Promise<{ title: string; generated: boolean }> {
  const response = await authorized(`/api/threads/${encodeURIComponent(threadId)}/title`, {
    method: 'POST'
  })
  return json(response, threadTitleResponseSchema)
}
