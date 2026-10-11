import { useState } from 'react'
import type { UIMessage } from 'ai'
import { Paperclip } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ReasoningPart } from './parts/ReasoningPart'
import { TextPart } from './parts/TextPart'
import { TraceBlock, type TraceBlockEntry } from './parts/TraceBlock'
import { isToolPart } from './parts/tool-part'
import { parseReferenceMarkers } from './reference-markers'
import { ReferenceChip } from './reference-chip'

/**
 * 一条消息（用户 / 助手两种形态）。
 * 用户消息：右侧气泡 + 悬停出现的「编辑」（编辑 = 截断重发，见 ChatPage 的 editResend）；
 * 助手消息：左对齐的 part 流 —— 正文文本单出，**连续的过程 part（思考 / 工具调用）并成
 * 一个过程块**（round 6：TraceBlock，正文把块切开、块内保持原顺序）。
 * round 29：审批入口不在这条链上（待审批统一走输入框上方的 ApprovalDock，块内只留只读状态行）。
 */
export interface MessageProps {
  message: UIMessage
  /** 这一条正在流式（最后一条助手消息且会话处于 streaming） */
  streaming?: boolean
  onEdit?: (messageId: string, text: string) => void
}

type MessagePart = UIMessage['parts'][number]
type TextPartType = Extract<MessagePart, { type: 'text' }>
type FilePartType = Extract<MessagePart, { type: 'file' }>

/** 用户消息里的纯文本（气泡里不渲染 markdown：用户输入按原样显示） */
function userText(message: UIMessage): string {
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

/** 助手消息的渲染块：文本一节，连续的过程 part 并成一个过程块 */
type RenderChunk =
  | { kind: 'text'; part: TextPartType; index: number }
  | { kind: 'process'; entries: TraceBlockEntry[] }

function chunkParts(parts: UIMessage['parts'], streaming: boolean): RenderChunk[] {
  const lastIndex = lastRenderableIndex(parts)
  const chunks: RenderChunk[] = []
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      chunks.push({ kind: 'text', part, index })
      return
    }
    if (part.type === 'reasoning' || isToolPart(part)) {
      const entry: TraceBlockEntry = { part, streaming: streaming && index === lastIndex }
      const previous = chunks[chunks.length - 1]
      if (previous?.kind === 'process') previous.entries.push(entry)
      else chunks.push({ kind: 'process', entries: [entry] })
    }
    // step-start / file / source 等不渲染
  })
  return chunks
}

export function Message({ message, streaming = false, onEdit }: MessageProps): React.JSX.Element {
  // null = 不在编辑；string = 编辑中的草稿
  const [draft, setDraft] = useState<string | null>(null)

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
                      className="max-h-64 max-w-64 rounded-panel border-(length:--hairline-width) border-hairline object-contain"
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
            {onEdit ? (
              <button
                type="button"
                data-testid="message-edit"
                onClick={() => setDraft(text)}
                className="rounded-control px-2 py-0.5 text-c2 text-ink-tertiary opacity-0 transition-opacity duration-(--motion-fast) group-hover:opacity-100 focus-visible:opacity-100 hover:bg-hover"
              >
                编辑
              </button>
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
      </article>
    )
  }

  const chunks = chunkParts(message.parts, streaming)
  const lastIndex = lastRenderableIndex(message.parts)

  return (
    <article
      data-testid={`message-${message.id}`}
      data-role="assistant"
      data-streaming={streaming ? 'true' : undefined}
      className="animate-message-in flex flex-col gap-2"
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
        const toolCount = chunk.entries.filter((entry) => isToolPart(entry.part)).length
        if (toolCount === 0) {
          // 纯思考的 run：不套「使用 0 个工具」的头，直接给思考块
          return chunk.entries.map((entry, index) =>
            entry.part.type === 'reasoning' ? (
              <ReasoningPart
                key={`reasoning-${index}`}
                text={entry.part.text}
                streaming={entry.streaming}
              />
            ) : null
          )
        }
        return (
          <TraceBlock key={`process-${chunkIndex}`} entries={chunk.entries} running={streaming} />
        )
      })}
    </article>
  )
}
