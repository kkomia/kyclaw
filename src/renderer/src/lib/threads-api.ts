/**
 * 线程 API 客户端（渲染端）：直连主进程内嵌的 agent 服务（和 chat transport 同一条路）。
 *
 * - 端点是现取的（随机端口 + 每次启动的 token），token 走 Authorization 头，不进 URL/日志；
 * - 回包一律过 shared/threads 的 zod schema（边界纪律同 IPC）：格式不对就抛，
 *   由调用方（store / 注册表）落到错误态，不把半截数据往 UI 里塞。
 */
import type { z } from 'zod'
import { tasksStore } from './tasks-store'
import {
  compactThreadResponseSchema,
  okResponseSchema,
  threadCompactionResponseSchema,
  threadListResponseSchema,
  threadMessagesResponseSchema,
  threadSummarySchema,
  threadTitleResponseSchema,
  truncateThreadResponseSchema,
  type StoredMessage,
  type ThreadCompaction,
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

/**
 * 建线程（round 26）：把草稿会话"物化"成真实线程——与"首条消息建线程"同一条服务端路径
 * （memory.createThread），只是不带消息。置顶/归档/移至项目这类要给会话记归属的动作
 * 先物化再执行；已经在的线程幂等回现况（动作重试/两个入口同时点都安全）。
 */
export async function createThread(threadId: string, title?: string): Promise<ThreadSummary> {
  const response = await authorized('/api/threads', {
    method: 'POST',
    body: JSON.stringify(title === undefined ? { threadId } : { threadId, title })
  })
  return json(response, threadSummarySchema)
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
  await tasksStore.getState().load(threadId)
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

/**
 * round 19：触发一次上下文压缩（POST /compact）。失败时把服务端那句人话带出来
 * （400/500 的 body 里就是给人看的文案，见路由层）；调用方负责降级与 notice。
 */
export async function compactThread(
  threadId: string,
  keep?: number
): Promise<{ compacted: boolean; compaction: ThreadCompaction | null }> {
  const response = await authorized(`/api/threads/${encodeURIComponent(threadId)}/compact`, {
    method: 'POST',
    body: JSON.stringify(keep === undefined ? {} : { keep })
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    const detail = typeof body?.error === 'string' ? body.error : ''
    throw new Error(detail === '' ? `压缩服务返回 ${response.status}` : detail)
  }
  const parsed = compactThreadResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`压缩服务回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** round 19：该会话的压缩记录（顶部「上下文已压缩」标记的数据面；没有记录 = null） */
export async function fetchThreadCompaction(threadId: string): Promise<ThreadCompaction | null> {
  const response = await authorized(`/api/threads/${encodeURIComponent(threadId)}/compaction`)
  const { compaction } = await json(response, threadCompactionResponseSchema)
  return compaction
}
