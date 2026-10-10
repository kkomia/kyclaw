import { DefaultChatTransport } from 'ai'
import type { ChatTransport, UIMessage } from 'ai'
import { threadMemoryBody } from '@shared/threads'

/**
 * 对话传输（T7 裁决）：渲染端直连主进程内嵌的 agent 服务。
 *
 * 两条硬要求：
 *   1. 端点要现取 —— baseUrl 是随机端口、token 每次启动都换，只能经 IPC 问主进程；
 *      拿到 `{baseUrl, token}` 之前不建 transport（服务没起来时错误在 ChatPage 那层就有得显示）。
 *   2. token 走 Authorization 头，不进 URL / 不进日志。
 *
 * 路由与 agent id 对齐 T6（`chatRoute({ path: '/chat/:agentId' })`，agent id = kyclaw-agent）。
 */
export function agentChatUrl(baseUrl: string): string {
  return `${baseUrl}/chat/kyclaw-agent`
}

export async function getTransport(): Promise<ChatTransport<UIMessage>> {
  const { baseUrl, token } = await window.kyclaw.agent.endpoint()
  return new DefaultChatTransport({
    api: agentChatUrl(baseUrl),
    headers: { Authorization: `Bearer ${token}` }
  })
}

/**
 * 每轮请求带的线程上下文（T9）：threadId 由会话状态给（草稿就是本地生成的 uuid，
 * 服务端据此建线程）。形状来自 shared/threads 的 `threadMemoryBody`（Mastra 只认
 * `memory.thread` / `memory.resource`），走 sendMessage/regenerate 的 per-request body
 * （DefaultChatTransport 会把它合并进请求体），transport 本身保持无状态。
 */
export function threadRequestOptions(threadId: string): {
  body: { memory: { thread: string; resource: string } }
} {
  return { body: threadMemoryBody(threadId) }
}
