import type { ChatStatus, UIMessage } from 'ai'

/**
 * 等待行的显示判据（P1b 配方 4）：**只看最后一轮**。
 * - 必须是 `submitted`（请求已发出、模型还没吐第一个可见字）；
 * - 最后一条 user 之后没有任何非空 assistant 文本 —— 一旦正文/工具块开始上屏，
 *   等待行就该让位给真实内容（工具块也算"已经开始"了吗？不算：工具调用到达但还没有
 *   正文时仍展示等待扫光更连贯；这里只看 text，避免工具行出现/消失让等待行闪）。
 */
export function shouldShowWaitingLine(status: ChatStatus, messages: readonly UIMessage[]): boolean {
  if (status !== 'submitted') return false
  let lastUserIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') lastUserIndex = index
  }
  for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'assistant') continue
    const hasText = message.parts.some((part) => part.type === 'text' && part.text.trim() !== '')
    if (hasText) return false
  }
  return true
}
