import { useEffect, useRef } from 'react'
import type { ChatStatus, UIMessage } from 'ai'
import type { Workspace } from '@shared/settings'
import type { ApprovalDecision } from './ApprovalCard'
import type { ApprovalRequest } from './approval'
import { Message } from './Message'
import { MessageRail } from './MessageRail'

/**
 * 消息列：滚动区（flex-1 + overflow-y-auto），内容列限宽 800 居中（spec §6.2）。
 * 流式标记的判定只在这里做一处：只有"最后一条助手消息 + status=streaming"才带光标。
 * 滚动跟随：本来贴底就跟着新内容走（流式增量、新消息），用户翻了历史就不打扰他。
 * 右缘消息导览轨（round 7）：**不随内容滚动**（挂在滚动区外的相对容器上），节点=用户消息。
 */
export interface MessageListProps {
  messages: UIMessage[]
  status: ChatStatus
  onEdit?: (messageId: string, text: string) => void
  /** 授权工作区列表与审批决策回调：透传给审批卡（T13） */
  workspaces?: readonly Workspace[]
  onApprovalDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void
}

/** 贴底阈值（px）：离底超过它就算"用户在翻历史" */
const STICK_THRESHOLD = 40

/** 末尾内容指纹：条数 + part 数 + 可见内容量 —— 文本增量、工具行出现/状态转档
 *  （调用中 → 已完成）都会让它变，贴底的人跟着新内容走。 */
function tailSignature(messages: UIMessage[]): string {
  const last = messages[messages.length - 1]
  if (last === undefined) return '0:0:0'
  let size = 0
  for (const part of last.parts) {
    const text = (part as { text?: unknown }).text
    if (typeof text === 'string') size += text.length
    const output = (part as { output?: unknown }).output
    if (typeof output === 'string') size += output.length
    const state = (part as { state?: unknown }).state
    if (typeof state === 'string') size += state.length
  }
  return `${messages.length}:${last.parts.length}:${size}`
}

export function MessageList({
  messages,
  status,
  onEdit,
  workspaces,
  onApprovalDecision
}: MessageListProps): React.JSX.Element {
  const lastMessage = messages[messages.length - 1]
  const lastAssistantId = lastMessage?.role === 'assistant' ? lastMessage.id : undefined

  const viewRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const tail = tailSignature(messages)

  useEffect(() => {
    const view = viewRef.current
    if (view && stickyRef.current) view.scrollTop = view.scrollHeight
  }, [tail])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={viewRef}
        data-testid="message-list"
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={() => {
          const view = viewRef.current
          if (!view) return
          stickyRef.current =
            view.scrollHeight - view.scrollTop - view.clientHeight < STICK_THRESHOLD
        }}
      >
        <div className="flex w-full flex-col gap-6 px-4 py-6">
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              streaming={status === 'streaming' && message.id === lastAssistantId}
              onEdit={onEdit}
              workspaces={workspaces}
              onApprovalDecision={onApprovalDecision}
            />
          ))}
        </div>
      </div>
      {/* 导览轨挂在滚动区外：它自己固定在聊天区右缘，不跟着消息滚 */}
      <MessageRail messages={messages} containerRef={viewRef} />
    </div>
  )
}
