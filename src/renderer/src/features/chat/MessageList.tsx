import { Fragment, useEffect, useRef } from 'react'
import type { ChatStatus, UIMessage } from 'ai'
import type { ThreadCompaction } from '@shared/threads'
import { CompactionMarker } from './CompactionMarker'
import { compactionRowIndex } from './compaction-line'
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
 *
 * round 59：压缩分界线不再是"列顶一行"，而是对话流里的一个**时间点** —— 按 compaction-line.ts
 * 的定位规则插到"压缩时刻之后的第一条消息"之前；压缩进行中则画在"现在"（列表末尾）。
 * `compactionIndex` 是上层冻结的锚点（手动压缩时在手的本轮新发消息要算在压缩之前，光靠时间戳
 * 判不出来，见 ChatPage 的 compactionAnchor）：给了就用它，不给就自己按时间戳规则算。
 *
 * round 61：消息动作行（复制 / 重新生成 / 撤回）的回调从这里往下透传 ——
 * **哪一条拿到什么是这一层判的**（「重新生成」只挂最后一条助手消息），
 * 闸门（流式 / 等审批 / 压缩中）仍由上层算好（关着就整个不给回调）。
 */
export interface MessageListProps {
  messages: UIMessage[]
  status: ChatStatus
  onEdit?: (messageId: string, text: string) => void
  /** 撤回一条用户消息（确认流在 Message 里，见 ChatPage 的 undoMessage） */
  onUndo?: (messageId: string, text: string) => void
  /**
   * 重新生成一条助手回复（round 61）：**只有最后一条助手消息拿得到**（其他助手消息不出现这枚钮），
   * 闸门（流式 / 等审批 / 压缩中）由上层算好——关着就整个不给。
   */
  onRegenerate?: (messageId: string) => void
  /** round 19：压缩记录（null = 不渲染分界线） */
  compaction?: ThreadCompaction | null
  /** 压缩进行中（同一位置显示「正在压缩上下文…」） */
  compacting?: boolean
  /**
   * round 59：分界线的固定下标（压缩完成那一刻冻结的锚点；undefined = 自己按时间戳算）。
   * 压缩进行中不用它（进行中画在"现在"）。
   */
  compactionIndex?: number
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
  onUndo,
  onRegenerate,
  compaction = null,
  compacting = false,
  compactionIndex
}: MessageListProps): React.JSX.Element {
  const lastMessage = messages[messages.length - 1]
  const lastAssistantId = lastMessage?.role === 'assistant' ? lastMessage.id : undefined

  const viewRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const tail = tailSignature(messages)

  /**
   * round 59：分界线插在第几条消息之前（null = 不画）。
   * 压缩进行中画在"现在"（列表末尾）——正在发生的事就在时间轴的最新一点；压完按上层的锚点
   * 定位（手动压缩那一刻冻结，见 ChatPage），没有锚点（重开会话）就按时间戳规则算。
   */
  const markerIndex = compacting
    ? messages.length
    : (compactionIndex ?? compactionRowIndex(messages, compaction))

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
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              {index === markerIndex ? (
                <CompactionMarker compaction={compaction} compacting={compacting} />
              ) : null}
              <Message
                message={message}
                streaming={status === 'streaming' && message.id === lastAssistantId}
                onEdit={onEdit}
                onUndo={onUndo}
                /* 「重新生成」只挂最后一条助手消息上（`lastAssistantId` 与本条同一判据：
                   最后一条消息就是助手消息时它才是"最后一条助手回复"） */
                onRegenerate={
                  onRegenerate === undefined || message.id !== lastAssistantId
                    ? undefined
                    : () => onRegenerate(message.id)
                }
              />
            </Fragment>
          ))}
          {/* 落在末尾（含"一条消息都没有"）：列表末尾那一份分界线 */}
          {markerIndex === messages.length ? (
            <CompactionMarker compaction={compaction} compacting={compacting} />
          ) : null}
        </div>
      </div>
      {/* 导览轨挂在滚动区外：它自己固定在聊天区右缘，不跟着消息滚 */}
      <MessageRail messages={messages} containerRef={viewRef} />
    </div>
  )
}
