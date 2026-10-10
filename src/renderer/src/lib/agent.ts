import { DefaultChatTransport } from 'ai'
import type { ChatTransport, UIMessage } from 'ai'

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
