import type { UIMessage } from 'ai'

export function hasPendingAskUser(message: UIMessage | undefined): boolean {
  if (!message) return false
  return message.parts.some((part) => {
    if (
      part.type !== 'tool-ask_user' &&
      !(part.type === 'dynamic-tool' && part.toolName === 'ask_user')
    )
      return false
    return part.state === 'input-available' || part.state === 'input-streaming'
  })
}

export function chatStreamActive(chat: { status: string }): boolean {
  return chat.status === 'submitted' || chat.status === 'streaming'
}

export function askUserResultLabel(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null
  const status = (output as { status?: unknown }).status
  return status === 'answered' ? '已回答' : status === 'cancelled' ? '已取消' : null
}
