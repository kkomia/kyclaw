import type { UIMessage } from 'ai'
import { turnFailureFromMetadata, type TurnFailure } from '@shared/turn-failure'

/**
 * PB-037：失败轮在 renderer 的**单一判定出口**。
 *
 * - `turnFailureOfMessage`：只认 UIMessage.metadata.turnFailure（由 message-map 从存储透传；
 *   坏形状已在那里/这里被 `parseTurnFailure` 拒绝）——缺失 → null，不渲染、不猜。
 * - `failurePresentationOf(messages, error)`：决定「消息内失败卡」与「页脚 dock 错误卡」谁出现。
 *   口径（Lead 拍板）：**有 turnFailure 的消息卡优先；dock 提示只在该轮没有消息卡时出现**。
 *   这里用**最近一条 user message**代表"该轮"：历史更早的失败卡不压当前/新失败轮的 dock 错误，
 *   避免旧卡把新错误吞掉。
 *
 * 注意：`error` 只代表当前轮（useChat.error）；`syncError`/`turnNotice`/交互错误不是本函数范围，
 * 它们不是"这一轮失败"的同一次事件（见 PB-037 报告 §清单）。
 */

export function turnFailureOfMessage(message: UIMessage): TurnFailure | null {
  return turnFailureFromMetadata(message.metadata)
}

export interface FailurePresentation {
  /** 最近一条 user message 是否已有失败卡（= 这次失败已有消息内展示） */
  messageCard: boolean
  /** 页脚 dock `ErrorCard` 是否该出现 */
  dockErrorVisible: boolean
}

export function failurePresentationOf(
  messages: readonly UIMessage[],
  error: Error | null | undefined
): FailurePresentation {
  let latestUser: UIMessage | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      latestUser = message
      break
    }
  }
  const messageCard = latestUser !== undefined && turnFailureOfMessage(latestUser) !== null
  return {
    messageCard,
    dockErrorVisible: error !== null && error !== undefined && !messageCard
  }
}

const ERROR_TITLE = '这一轮没有完成'
const INTERRUPTED_TITLE = '已中断'

/** 卡片标题：只有 error 用「这一轮没有完成」；aborted/interrupted 一律「已中断」 */
export function turnFailureTitle(failure: TurnFailure): string {
  return failure.kind === 'error' ? ERROR_TITLE : INTERRUPTED_TITLE
}

/**
 * error 的可读原因（优先 message，其次 code；都没有才给通用句）。
 * aborted/interrupted 不返回任何失败原因（禁止把中断说成失败/重试）。
 */
export function turnFailureDetail(failure: TurnFailure): string | null {
  if (failure.kind !== 'error') return null
  if (failure.message !== undefined) return failure.message
  if (failure.code !== undefined) return failure.code
  return '本轮生成失败，未提供错误详情。'
}

/** error 且有 message 时，code 单独一行；只有 code 时它已经在 detail 里，不重复 */
export function turnFailureCode(failure: TurnFailure): string | null {
  if (failure.kind !== 'error') return null
  return failure.code !== undefined && failure.message !== undefined ? failure.code : null
}
