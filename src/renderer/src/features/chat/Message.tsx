import { useState } from 'react'
import type { UIMessage } from 'ai'
import { Button } from '@renderer/components/ui/button'
import type { Workspace } from '@shared/settings'
import type { ApprovalDecision } from './ApprovalCard'
import type { ApprovalRequest } from './approval'
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
 */
export interface MessageProps {
  message: UIMessage
  /** 这一条正在流式（最后一条助手消息且会话处于 streaming） */
  streaming?: boolean
  onEdit?: (messageId: string, text: string) => void
  /** 渲染端那份授权工作区列表（审批卡判记忆粒度用） */
  workspaces?: readonly Workspace[]
  /**
   * 审批决策回调（工具 part 处于 approval-requested 时出现审批卡）。
   * 没有这个回调时不渲染审批卡、退回静态工具行 —— 没接线的位置不该给"点了没用"的按钮。
   */
  onApprovalDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void
}

type MessagePart = UIMessage['parts'][number]
type TextPartType = Extract<MessagePart, { type: 'text' }>

/** 用户消息里的纯文本（气泡里不渲染 markdown：用户输入按原样显示） */
function userText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
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

export function Message({
  message,
  streaming = false,
  onEdit,
  workspaces,
  onApprovalDecision
}: MessageProps): React.JSX.Element {
  // null = 不在编辑；string = 编辑中的草稿
  const [draft, setDraft] = useState<string | null>(null)

  if (message.role === 'user') {
    const text = userText(message)
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
          <TraceBlock
            key={`process-${chunkIndex}`}
            entries={chunk.entries}
            running={streaming}
            workspaces={workspaces}
            onApprovalDecision={onApprovalDecision}
          />
        )
      })}
    </article>
  )
}
