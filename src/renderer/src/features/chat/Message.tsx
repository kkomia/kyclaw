import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { Check, Copy, Pencil, Paperclip, RefreshCw, Undo2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { DeliverableCard } from './DeliverableCard'
import { deliverableOf, type Deliverable } from './deliverable'
import { ReasoningPart } from './parts/ReasoningPart'
import {
  lookupReasoningChoice,
  reasoningOrdinalsOf,
  reasoningTextOf,
  withReasoningChoice,
  type ReasoningOverrides
} from './reasoning-overrides'
import { TextPart } from './parts/TextPart'
import { TraceBlock, type TraceBlockEntry } from './parts/TraceBlock'
import { isToolPart, toToolCardPart } from './parts/tool-part'
import { parseReferenceMarkers } from './reference-markers'
import { ReferenceChip } from './reference-chip'

/**
 * 一条消息（用户 / 助手两种形态）。
 * 用户消息：右侧气泡 + 悬停出现的动作行（「编辑」= 截断重发，见 ChatPage 的 editResend；
 * 「撤回」= 确认后把这条及之后的对话从上下文与列表里去掉、原文放回输入框，见 ChatPage 的 undoMessage）；
 * 助手消息：左对齐的 part 流 —— 正文文本单出，**连续的过程 part（思考 / 工具调用）并成
 * 一个过程块**（round 6：TraceBlock，正文把块切开、块内保持原顺序）；
 * **正文下方**另有一行动作（round 61）：「复制」= 正文 parts 的拼接，「重新生成」= 同一条重试路径。
 * round 63：四个动作（编辑 / 撤回 / 复制 / 重新生成）一律是**图标按钮**——钮上不写字，
 * 名字只走 `aria-label` 与 `title`（详见 MessageAction 的头注）。
 * round 29：审批入口不在这条链上（待审批统一走输入框上方的 ApprovalDock，块内只留只读状态行）。
 * round 50：交付（deliver_file 的结果）单出一张卡 —— 它是"给用户看的东西"，不埋进会收起的
 * 过程块里（见 chunkParts 的头注）。
 *
 * round 61 的两条口径（动作行的可见性都在上层算好，这里只管画）：
 *   - **流式中的那条不显示动作行**（内容还在长，复制/重生成都没意义）；等审批 / 压缩中同理，
 *     由 ChatPage 不给回调来关掉（与「编辑」同一道闸）；
 *   - 「重新生成」只在**最后一条助手消息**上出现（谁拿到回调由 MessageList 判）。
 */
export interface MessageProps {
  message: UIMessage
  /** 这一条正在流式（最后一条助手消息且会话处于 streaming） */
  streaming?: boolean
  onEdit?: (messageId: string, text: string) => void
  /** 撤回到这条用户消息（确认后截断并移除这条及其后的消息，原文放回输入框） */
  onUndo?: (messageId: string, text: string) => void
  /** 重新生成这一条助手回复（只有最后一条助手消息会拿到；闸门关时上层不给） */
  onRegenerate?: () => void
}

type MessagePart = UIMessage['parts'][number]
type TextPartType = Extract<MessagePart, { type: 'text' }>
type FilePartType = Extract<MessagePart, { type: 'file' }>

/** 「已复制」这个反馈保持多久（到点把图标从对勾退回复制、名字退回「复制」） */
const COPIED_RESET_MS = 1500

/**
 * 消息动作钮（round 63：**图标按钮**，与 composer 的图标钮同一形态 —— 32 热区、圆形 hover 底、
 * 次要墨色 → hover 转主墨色、`--motion-fast` 过渡）。
 * 钮上一个字都不写：语义靠 `aria-label` + `title`（图标是装饰，对读屏隐藏）。
 * 尺寸与间距照 composer（ComposerControls 的 ICON_TRIGGER_CLASS），点击热区 32×32 ≥ 28×28。
 */
function MessageAction({
  testId,
  label,
  onClick,
  children
}: {
  testId: string
  /** 无障碍名，也当 title 用（中文，如「复制」） */
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink active:bg-active motion-reduce:transition-none"
    >
      {children}
    </button>
  )
}

/**
 * 动作行：悬停这条消息（或焦点进来）才显形 —— 与 R2 起「编辑」的显隐同一套。
 * 容器统一持有 `group-hover` / `focus-within`：焦点落到行内任一个钮上，整行都可见
 * （单钮带 focus-visible 的话，行还是 opacity-0，键盘用户看不见自己焦点在哪）。
 */
function MessageActions({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-1 opacity-0 transition-opacity duration-(--motion-fast) group-hover:opacity-100 focus-within:opacity-100',
        className
      )}
    >
      {children}
    </div>
  )
}

/** 用户消息里的纯文本（气泡里不渲染 markdown：用户输入按原样显示） */
function userText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

/** 助手消息的正文（复制取它：**不含**思考 / 工具 / 文件 part） */
function assistantText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

/** 用户消息里的 file part（模块 2：图片随消息发出去就是它们） */
function userFiles(message: UIMessage): FilePartType[] {
  return message.parts.filter((part): part is FilePartType => part.type === 'file')
}

/** 最后一个"真渲染出来"的 part 的下标（光标挂它身上）；没有就是 -1 */
function lastRenderableIndex(parts: UIMessage['parts']): number {
  let last = -1
  parts.forEach((part, index) => {
    if (part.type === 'text' || part.type === 'reasoning' || isToolPart(part)) last = index
  })
  return last
}

/**
 * 这个 part 是不是**看得见的内容**（用来判"这一段后面已经有内容上屏了"）。
 *
 * 与 `lastRenderableIndex` 的区别只有空正文这一处，但这一处会咬人：SSE 的 `text-start` 会先落一个
 * **空 text part**（`TextPart` 那时只画一枚流式光标、没有一个字，见 TextPart 的 `text === ''` 分支），
 * 拿它当"内容出现了"会把思考块在正文还没开始时就被收掉 —— 用户口径是"下一个工具或**其他内容**显示时"。
 * 所以这里要求正文真有字（空白也算没字）；工具 part 直接算（工具卡一出现就有名字与状态行）；
 * reasoning part 也算（它自己就是"内容"，只是会在自己的 `settled` 里再判一次）。
 */
function hasVisibleContent(part: UIMessage['parts'][number]): boolean {
  if (part.type === 'text') {
    const text: unknown = part.text
    return typeof text === 'string' && text.trim() !== ''
  }
  return part.type === 'reasoning' || isToolPart(part)
}

/**
 * 助手消息的渲染块：文本一节，连续的过程 part 并成一个过程块，**交付卡单出**。
 *
 * 交付卡为什么要从过程块里摘出来（round 50）：过程块这一轮跑完会自动收起，交付物埋在
 * 折起来的"使用 N 个工具"里就等于没交付。摘出来之后它与正文平级、始终可见；
 * 还在调用中的 deliver_file（没有结果）照旧走过程块里的普通工具行。
 */
type RenderChunk =
  | { kind: 'text'; part: TextPartType; index: number }
  | { kind: 'process'; entries: TraceBlockEntry[] }
  | { kind: 'deliverable'; deliverable: Deliverable; index: number }

function chunkParts(parts: UIMessage['parts'], streaming: boolean): RenderChunk[] {
  const lastIndex = lastRenderableIndex(parts)
  // "后面已经有内容上屏"的分界：**空正文不算**（见 hasVisibleContent）
  let lastVisibleIndex = -1
  parts.forEach((part, index) => {
    if (hasVisibleContent(part)) lastVisibleIndex = index
  })
  const chunks: RenderChunk[] = []
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      chunks.push({ kind: 'text', part, index })
      return
    }
    if (part.type === 'reasoning' || isToolPart(part)) {
      const tool = toToolCardPart(part)
      const deliverable = tool === null ? null : deliverableOf(tool)
      if (deliverable !== null) {
        chunks.push({ kind: 'deliverable', deliverable, index })
        return
      }
      const entry: TraceBlockEntry = {
        part,
        index,
        streaming: streaming && index === lastIndex,
        // 这一段后面已经有别的内容上屏了（工具行 / 正文 / 下一段思考）→ 思考框收起来让版面。
        // 判据用 lastVisibleIndex 而不是 lastIndex：只有一枚流式光标的空正文不算"内容"
        settled: index < lastVisibleIndex
      }
      const previous = chunks[chunks.length - 1]
      if (previous?.kind === 'process') previous.entries.push(entry)
      else chunks.push({ kind: 'process', entries: [entry] })
    }
    // step-start / file / source 等不渲染
  })
  return chunks
}

export function Message({
  message,
  streaming = false,
  onEdit,
  onUndo,
  onRegenerate
}: MessageProps): React.JSX.Element {
  // null = 不在编辑；string = 编辑中的草稿
  const [draft, setDraft] = useState<string | null>(null)
  /** 撤回的二次确认弹窗（Kimi 口径：撤销会连带清掉这条之后的所有内容，先说清楚再动） */
  const [undoOpen, setUndoOpen] = useState(false)
  /** 助手正文刚被复制（图标短暂转对勾、名字短暂转「已复制」，到点退回） */
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 思考段的手动开合：消息的渲染形态会变（纯思考 → 加进来一条工具行就换成过程块），
   * **组件类型一变整棵重挂**，思考块自己的 state 会丢。用户手动点开过的那一段，
   * 在工具到达后不能被自动折叠再压回去 —— 所以这份选择存在这一层。
   * 段身份 = **消息内 reasoning 序号**（工具插入不改它；两段同样正文也各算一段），见 `reasoning-overrides`。
   */
  const [reasoningOverrides, setReasoningOverrides] = useState<ReasoningOverrides>(() => new Map())
  const [overridesOwner, setOverridesOwner] = useState(message.id)
  // 同一个组件实例换成另一条消息（列表复用 / 列表被顶掉）：上一条的手动开合不许跟过去。
  // 渲染期按 props 调整 state（同 TraceFold 的写法）：提交前就带上新值，不会多画一帧旧状态。
  if (overridesOwner !== message.id) {
    setOverridesOwner(message.id)
    setReasoningOverrides(new Map())
  }
  /** 每个 part 下标 → 它是第几段思考（这一轮渲染的段身份） */
  const reasoningOrdinals = useMemo(() => reasoningOrdinalsOf(message.parts), [message.parts])

  /** 某一段思考的手动选择（没选过 = undefined → 思考块自己按自动档走） */
  const reasoningOverrideAt = useCallback(
    (ordinal: number, text: string): boolean | null | undefined =>
      lookupReasoningChoice(reasoningOverrides, ordinal, text)?.open,
    [reasoningOverrides]
  )

  /** 记一段思考的手动开合（顺手清掉已经换了一段的旧记录，见 withReasoningChoice） */
  const rememberReasoningChoice = useCallback(
    (ordinal: number, text: string, open: boolean): void => {
      setReasoningOverrides((current) =>
        withReasoningChoice(current, message.parts, reasoningOrdinals, ordinal, { open, text })
      )
    },
    [message.parts, reasoningOrdinals]
  )

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    }
  }, [])

  if (message.role === 'user') {
    const text = userText(message)
    const files = userFiles(message)
    const submitEdit = (): void => {
      const next = (draft ?? '').trim()
      setDraft(null)
      if (next !== '' && next !== text) onEdit?.(message.id, next)
    }

    return (
      <article
        data-testid={`message-${message.id}`}
        data-role="user"
        className="animate-message-in group flex flex-col items-end gap-1.5"
      >
        {draft === null ? (
          <>
            {/* 随消息发出去的图片（模块 2）：最小实现——直接给缩略图；非图片的 file part 给一条文件名 */}
            {files.length === 0 ? null : (
              <div
                data-testid="message-files"
                className="flex max-w-[85%] flex-wrap justify-end gap-1.5"
              >
                {files.map((part, index) =>
                  part.mediaType.startsWith('image/') ? (
                    <img
                      key={`${part.url.slice(0, 24)}-${index}`}
                      data-testid="message-image"
                      src={part.url}
                      alt={part.filename ?? '图片'}
                      className="max-h-64 max-w-64 rounded-panel border-(length:--hairline-width) border-surface-border object-contain"
                    />
                  ) : (
                    <span
                      key={`${part.url.slice(0, 24)}-${index}`}
                      data-testid="message-file"
                      className="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-pill border-(length:--hairline-width) border-hairline px-2.5 text-c1 text-ink-secondary"
                    >
                      <Paperclip
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-ink-tertiary"
                      />
                      <span className="min-w-0 truncate">{part.filename ?? part.mediaType}</span>
                    </span>
                  )
                )}
              </div>
            )}
            <div className="max-w-[85%] rounded-panel bg-secondary px-4 py-2 text-b1 break-words whitespace-pre-wrap text-ink">
              {/* 引用标记画成内联 chip（round 14 起；round 21 换图3 观感：细描边圆角 + 图标，
                  `【引用】` 前缀不进可见层）。底层消息文本不变——编辑重发仍是原文。 */}
              {parseReferenceMarkers(text).map((segment, index) =>
                segment.kind === 'text' ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <ReferenceChip key={index} refs={segment.refs} />
                )
              )}
            </div>
            {onEdit || onUndo ? (
              <MessageActions>
                {onEdit ? (
                  <MessageAction testId="message-edit" label="编辑" onClick={() => setDraft(text)}>
                    <Pencil aria-hidden="true" className="size-4" />
                  </MessageAction>
                ) : null}
                {onUndo ? (
                  <MessageAction
                    testId="message-undo"
                    label="撤回"
                    onClick={() => setUndoOpen(true)}
                  >
                    <Undo2 aria-hidden="true" className="size-4" />
                  </MessageAction>
                ) : null}
              </MessageActions>
            ) : null}
          </>
        ) : (
          <div className="flex w-full flex-col items-end gap-2">
            <textarea
              data-testid="message-edit-input"
              aria-label="编辑消息"
              value={draft}
              autoFocus
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(null)
                  return
                }
                if (event.key !== 'Enter' || event.shiftKey) return
                if (event.nativeEvent.isComposing) return
                event.preventDefault()
                submitEdit()
              }}
              className="min-h-(--field-height) w-full resize-none rounded-panel border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 py-2 text-b1 text-ink"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                data-testid="message-edit-cancel"
                onClick={() => setDraft(null)}
              >
                取消
              </Button>
              <Button size="sm" data-testid="message-edit-save" onClick={submitEdit}>
                重新发送
              </Button>
            </div>
          </div>
        )}
        {/* 撤回的二次确认（Kimi 口径的 kyclaw 版）：这条及之后的对话会从上下文与列表里移除，
            原文回输入框；工作区里已改动的文件不在这里、也不受影响（那是工具干的事）。
            取消 = 什么都不做（`onUndo` 只在点确认时调一次）。 */}
        <Dialog
          open={undoOpen}
          onOpenChange={(open) => {
            if (!open) setUndoOpen(false)
          }}
          title="撤回这条消息？"
          description="撤销后，这条消息及之后的对话会从上下文与列表中移除，这条消息的原文会放回输入框；已改动的工作区文件不受影响。"
          footer={
            <>
              <Button
                variant="ghost"
                data-testid="message-undo-cancel"
                onClick={() => setUndoOpen(false)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                data-testid="message-undo-confirm"
                onClick={() => {
                  setUndoOpen(false)
                  onUndo?.(message.id, text)
                }}
              >
                撤回
              </Button>
            </>
          }
        />
      </article>
    )
  }

  const chunks = chunkParts(message.parts, streaming)
  const lastIndex = lastRenderableIndex(message.parts)
  const text = assistantText(message)
  /**
   * 动作行什么时候有：**流式中的那条没有**（内容还在长）。
   * 「复制」只在这条真有正文时出现（纯工具轮没有可复制的东西——不给一枚点了没反应的钮）；
   * 「重新生成」由上层给不给回调决定（只有最后一条助手消息拿到）。
   */
  const showActions = !streaming && (text !== '' || onRegenerate !== undefined)

  /** 复制正文（不含思考 / 工具 / 文件）；成功把图标转成对勾、名字转「已复制」，失败只留日志（不假装复制了） */
  const copyText = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        if (copyTimer.current !== null) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
      })
      .catch((cause: unknown) => {
        console.warn('[kyclaw] 复制消息失败', cause)
      })
  }

  return (
    <article
      data-testid={`message-${message.id}`}
      data-role="assistant"
      data-streaming={streaming ? 'true' : undefined}
      className="animate-message-in group flex flex-col gap-2"
    >
      {chunks.map((chunk, chunkIndex) => {
        if (chunk.kind === 'text') {
          return (
            <TextPart
              key={`text-${chunk.index}`}
              text={chunk.part.text}
              streaming={streaming && chunk.index === lastIndex}
            />
          )
        }
        if (chunk.kind === 'deliverable') {
          return (
            <DeliverableCard key={`deliverable-${chunk.index}`} deliverable={chunk.deliverable} />
          )
        }
        const toolCount = chunk.entries.filter((entry) => isToolPart(entry.part)).length
        if (toolCount === 0) {
          // 纯思考的 run：不套「使用 0 个工具」的头，直接给思考块。
          // `live` 传的是"这一轮还在跑"而不是这一条自己的 `streaming`：正文刚开个头（SSE 先落一枚
          // 空 text part）时最后可渲染的已经不是这段思考了，`streaming` 早就翻假 —— 光看它会在
          // 正文还没写出一个字的时候就把思考收掉。真收的时机由 `settled`（后面有**看得见的内容**）管。
          // 手动开合走受控（overrides/onToggle）：工具到达把这一块换成过程块时整棵重挂，
          // 本地 state 会丢，选择得存在这一层才不会被自动折叠再压回去。
          return chunk.entries.map((entry) => {
            const text = reasoningTextOf(entry.part)
            const ordinal = reasoningOrdinals.get(entry.index)
            if (text === null || ordinal === undefined) return null
            return (
              <ReasoningPart
                key={`reasoning-${entry.index}`}
                text={text}
                streaming={entry.streaming}
                live={streaming}
                settled={entry.settled}
                override={reasoningOverrideAt(ordinal, text)}
                onToggle={(nextOpen) => rememberReasoningChoice(ordinal, text, nextOpen)}
              />
            )
          })
        }
        return (
          <TraceBlock
            key={`process-${chunkIndex}`}
            entries={chunk.entries}
            running={streaming}
            overrides={reasoningOverrides}
            reasoningOrdinals={reasoningOrdinals}
            onReasoningToggle={rememberReasoningChoice}
          />
        )
      })}
      {showActions ? (
        <MessageActions>
          {text === '' ? null : (
            <MessageAction
              testId="message-copy"
              label={copied ? '已复制' : '复制'}
              onClick={copyText}
            >
              {copied ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
            </MessageAction>
          )}
          {onRegenerate === undefined ? null : (
            <MessageAction testId="message-regenerate" label="重新生成" onClick={onRegenerate}>
              <RefreshCw aria-hidden="true" className="size-4" />
            </MessageAction>
          )}
        </MessageActions>
      ) : null}
    </article>
  )
}
