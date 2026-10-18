import { Fragment, useMemo, useRef } from 'react'
import type { ChatStatus, UIMessage } from 'ai'
import type { ThreadCompaction } from '@shared/threads'
import { motionDataAttributes, useEffectiveMotion } from '@renderer/lib/motion'
import {
  EMPTY_CITATIONS,
  extractCitationsFromTexts,
  knownSourcesOfParts,
  mergeKnownSources,
  type Citation,
  type CitationHint
} from './citations'
import { CompactionMarker } from './CompactionMarker'
import { compactionRowIndex } from './compaction-line'
import { deliverablesByTurnTail } from './deliverable'
import { Message } from './Message'
import { MessageRail } from './MessageRail'
import { WaitingLine } from './parts/WaitingLine'
import { useChatFollow } from './use-chat-follow'
import { shouldShowWaitingLine } from './waiting-line'
// P1b：对话区的签名动效（角色令牌全在 motion.css，本文件只做 chat 域类名/关键帧）
import './chat-motion.css'

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
  /**
   * 选中助手正文 → 引用（0.1.3 / 013 返工）：由 ChatPage 接到草稿通道，落成 Composer 的
   * 原文摘要卡（不写输入框、不自动发送）；不给 = 不挂选文菜单（其余只读宿主保持原样）。
   */
  onQuoteSelection?: (text: string, source: { messageId: string }) => void
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

interface CitationTurn {
  /** 本轮已完成工具结果建立的 allowlist（键存在即授权） */
  knownSources: ReadonlyMap<string, CitationHint>
  /** 本轮末尾汇总的来源；非轮末消息显式空数组（压掉各自的面板） */
  sources: readonly Citation[]
}

/**
 * 网页引用的**按轮**接线（0.1.3 · P0 provenance）。
 *
 * 审批 / ask-user / 计划续跑会追加 assistant 消息：工具结果可能在 A、引用在 B。用户消息是
 * 轮次边界，同一轮连续的 assistant 消息共享一份 allowlist；**不跨用户轮**，否则上一轮搜到的
 * URL 会给下一轮正文授权。来源面板只在轮末那条汇总一次（与交付卡的 `deliverablesByTurnTail`
 * 同一形状），避免 A/B 各出一份。
 *
 * 正文按 text part 分别提取；每个 part 在渲染时也是独立 Markdown 实例。
 */
function citationTurnsOf(
  messages: UIMessage[],
  streamingMessageId: string | undefined
): Array<CitationTurn | undefined> {
  const slots: Array<CitationTurn | undefined> = new Array(messages.length)
  let assistantIndices: number[] = []

  const flush = (): void => {
    if (assistantIndices.length === 0) return
    const knownSources = new Map<string, CitationHint>()
    const texts: string[] = []
    for (const index of assistantIndices) {
      const message = messages[index]
      if (message === undefined) continue
      mergeKnownSources(knownSources, knownSourcesOfParts(message.parts))
      for (const part of message.parts) {
        if (part.type === 'text') texts.push(part.text)
      }
    }
    // 正在流的那一轮：面板不出现，只建 allowlist 供角标门控，不扫长正文（round 73 的流式预算）。
    // 历史轮不受影响（它们没在流，面板该在还在）。
    const streaming = assistantIndices.some((index) => messages[index]?.id === streamingMessageId)
    const sources =
      streamingMessageId !== undefined && streaming
        ? EMPTY_CITATIONS
        : extractCitationsFromTexts(texts, knownSources)
    const tail = assistantIndices[assistantIndices.length - 1]
    for (const index of assistantIndices) {
      slots[index] = {
        knownSources,
        sources: index === tail ? sources : EMPTY_CITATIONS
      }
    }
    assistantIndices = []
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'user') {
      flush()
      continue
    }
    if (message.role === 'assistant') assistantIndices.push(index)
  }
  flush()
  return slots
}

export function MessageList({
  messages,
  status,
  onEdit,
  onUndo,
  onRegenerate,
  onQuoteSelection,
  compaction = null,
  compacting = false,
  compactionIndex
}: MessageListProps): React.JSX.Element {
  const lastMessage = messages[messages.length - 1]
  const lastAssistantId = lastMessage?.role === 'assistant' ? lastMessage.id : undefined
  /** P1b：最后一条用户消息 —— 本轮正在发送时给它挂 320ms 右下 origin 的入场 */
  let lastUserIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') lastUserIndex = index
  }
  /** P1b 配方 4：submitted 且本轮还没有 assistant 正文 → 补一行等待（原模板这里是空白） */
  const waiting = shouldShowWaitingLine(status, messages)
  /**
   * 交付卡的整轮汇总（0.1.3 / 014）：连续助手消息算一轮，只有轮末那条拿得到聚合结果
   * （审批 / ask-user / 计划续跑会追加助手消息，不能把卡截在半轮）。用户消息是轮次边界；
   * 历史回灌与实时流走同一份消息数组，所以回读后的位置一致。
   */
  const turnDeliverables = useMemo(() => deliverablesByTurnTail(messages), [messages])
  /**
   * 网页引用也按轮接线（0.1.3 · P0 provenance）：同一轮连续的 assistant 消息共享工具结果
   * allowlist，来源面板只在轮末汇总；用户消息是边界，不跨轮污染。
   */
  const citationTurns = useMemo(
    () => citationTurnsOf(messages, status === 'streaming' ? lastAssistantId : undefined),
    [messages, status, lastAssistantId]
  )

  const viewRef = useRef<HTMLDivElement>(null)
  const tail = tailSignature(messages)
  /** 换会话 / 本轮新发送 → 外层消息流重置贴底 */
  const followResetKey = `${messages.find((message) => message.role === 'user')?.id ?? ''}:${String(messages.filter((message) => message.role === 'user').length)}`
  const motion = useEffectiveMotion()
  /** 动效 B：聊天区滚动跟随（弹簧/限速/贴底/大跳追赶；关/reduced 回 P1b 瞬时） */
  const follow = useChatFollow({
    viewRef,
    tail,
    enabled: motion.chatScroll,
    resetKey: followResetKey
  })

  /** round 59：分界线插在第几条消息之前（null = 不画）。
   *  压缩进行中画在"现在"（列表末尾）——正在发生的事就在时间轴的最新一点；压完按上层的锚点
   *  定位（手动压缩那一刻冻结，见 ChatPage），没有锚点（重开会话）就按时间戳规则算。 */
  const markerIndex = compacting
    ? messages.length
    : (compactionIndex ?? compactionRowIndex(messages, compaction))

  return (
    // round 21：外层**不带 relative**——消息导览轨（absolute）的定位基准因此上溯到
    // ChatFrame 的 chat 页根（整幅、相对定位），横线列/浮窗贴 chat 区最右缘 8px；
    // 之前这里自带 relative，轨道被钉在限宽内容列（约 800px）的右缘，图2 的偏差即由此来。
    <div
      data-testid="message-list-frame"
      {...motionDataAttributes(motion)}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* 消息区不显示滚动条（round 8 用户实拍：右侧那条滚动条去掉）——滚动能力不变，
          只隐藏原生条；全局 ::-webkit-scrollbar 样式与其它区域不动。 */}
      <div
        ref={viewRef}
        data-testid="message-list"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={follow.onScroll}
      >
        <div className="chat-content mx-auto flex w-full max-w-[calc(var(--chat-content-width)+32px)] flex-col gap-6 px-4 py-6">
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              {index === markerIndex ? (
                <CompactionMarker compaction={compaction} compacting={compacting} />
              ) : null}
              <Message
                message={message}
                streaming={status === 'streaming' && message.id === lastAssistantId}
                animateSend={status !== 'ready' && index === lastUserIndex}
                onEdit={onEdit}
                onUndo={onUndo}
                /* 「重新生成」只挂最后一条助手消息上（`lastAssistantId` 与本条同一判据：
                   最后一条消息就是助手消息时它才是"最后一条助手回复"） */
                onRegenerate={
                  onRegenerate === undefined || message.id !== lastAssistantId
                    ? undefined
                    : () => onRegenerate(message.id)
                }
                /* 交付卡只给轮末那条助手消息；其余助手消息显式给空数组（压掉自己的卡） */
                deliverables={turnDeliverables[index]}
                onQuoteSelection={
                  onQuoteSelection === undefined
                    ? undefined
                    : (text) => onQuoteSelection(text, { messageId: message.id })
                }
                /* 引用 allowlist 本轮共享；来源面板只给轮末那条，非轮末显式空数组 */
                knownSources={citationTurns[index]?.knownSources}
                citationSources={citationTurns[index]?.sources}
              />
            </Fragment>
          ))}
          {/* 落在末尾（含"一条消息都没有"）：列表末尾那一份分界线 */}
          {markerIndex === messages.length ? (
            <CompactionMarker compaction={compaction} compacting={compacting} />
          ) : null}
          {waiting ? (
            <div
              data-testid="waiting-lane"
              data-font-role="reading"
              className="flex max-w-[calc(var(--chat-content-width)+18px)] border-l border-(--hairline-soft) pl-[18px]"
            >
              <WaitingLine status={status} messages={messages} />
            </div>
          ) : null}
        </div>
      </div>
      {/* 导览轨挂在滚动区外：它自己固定在聊天区右缘，不跟着消息滚 */}
      <MessageRail messages={messages} containerRef={viewRef} />
    </div>
  )
}
