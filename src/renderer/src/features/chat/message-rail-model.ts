import type { UIMessage } from 'ai'

/**
 * 消息导览轨的纯逻辑（组件在 MessageRail.tsx：react-refresh 要求组件文件只导出组件）。
 */
/** 当前节点阈值（px）：消息顶边越过容器上沿这么多，就算"滚过它了" */
export const RAIL_ACTIVE_THRESHOLD = 32

/** 用户消息摘要：所有 text part 压成一行（面板里由 CSS 截断，不再切字） */
export function summarizeMessage(message: UIMessage): string {
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? '（无文本）' : text
}

/** 当前节点 = 顶边已越过容器上沿的最后一条；都没有（还没滚动）取第一条 */
export function activeUserIdFrom(
  entries: ReadonlyArray<{ id: string; top: number }>,
  threshold = RAIL_ACTIVE_THRESHOLD
): string | null {
  if (entries.length === 0) return null
  let active: string | null = null
  for (const entry of entries) {
    if (entry.top <= threshold) active = entry.id
  }
  return active ?? entries[0].id
}
