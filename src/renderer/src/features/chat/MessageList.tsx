import { useEffect, useRef } from 'react'
import type { ChatStatus, UIMessage } from 'ai'
import type { ThreadCompaction } from '@shared/threads'
import { CompactionMarker } from './CompactionMarker'
import { Message } from './Message'
import { MessageRail } from './MessageRail'

/**
 * 消息列：滚动区（flex-1 + overflow-y-auto），内容列限宽 800 居中（spec §6.2）。
 * 流式标记的判定只在这里做一处：只有"最后一条助手消息 + status=streaming"才带光标。
 * 滚动跟随：本来贴底就跟着新内容走（流式增量、新消息），用户翻了历史就不打扰他。
 * 右缘消息导览轨（round 7）：**不随内容滚动**（挂在滚动区外的相对容器上），节点=用户消息。
 * 右侧走廊（round 14，用户实拍「摘要条快和消息贴住了」）：消息列右内边距 56px（pr-14）——
 * 导览轨占右缘 8+40=48px，正文最远停在 56px，任何窗口宽度都不与轨道重叠（留 8px 呼吸位）。
 *
 * round 29：审批入口搬到输入框上方（ApprovalDock），这里不再透传审批回调与工作区列表 ——
 * 消息流只把"等审批"如实画成只读状态行。
 */
export interface MessageListProps {
  messages: UIMessage[]
  status: ChatStatus
  onEdit?: (messageId: string, text: string) => void
  /** round 19：顶部「上下文已压缩」标记的数据（null = 不渲染标记） */
  compaction?: ThreadCompaction | null
  /** 压缩进行中（标记显示「上下文压缩中…」） */
  compacting?: boolean
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
  compaction = null,
  compacting = false
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
    // round 21：外层**不带 relative**——消息导览轨（absolute）的定位基准因此上溯到
    // ChatFrame 的 chat 页根（整幅、相对定位），横线列/浮窗贴 chat 区最右缘 8px；
    // 之前这里自带 relative，轨道被钉在限宽内容列（约 800px）的右缘，图2 的偏差即由此来。
    <div data-testid="message-list-frame" className="flex min-h-0 flex-1 flex-col">
      {/* 消息区不显示滚动条（round 8 用户实拍：右侧那条滚动条去掉）——滚动能力不变，
          只隐藏原生条；全局 ::-webkit-scrollbar 样式与其它区域不动。 */}
      <div
        ref={viewRef}
        data-testid="message-list"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={() => {
          const view = viewRef.current
          if (!view) return
          stickyRef.current =
            view.scrollHeight - view.scrollTop - view.clientHeight < STICK_THRESHOLD
        }}
      >
        <div className="flex w-full flex-col gap-6 py-6 pr-14 pl-4">
          <CompactionMarker compaction={compaction} compacting={compacting} />
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              streaming={status === 'streaming' && message.id === lastAssistantId}
              onEdit={onEdit}
            />
          ))}
        </div>
      </div>
      {/* 导览轨挂在滚动区外：它自己固定在聊天区右缘，不跟着消息滚 */}
      <MessageRail messages={messages} containerRef={viewRef} />
    </div>
  )
}
