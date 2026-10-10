import { useState } from 'react'
import type { UIMessage } from 'ai'
import { Button } from '@renderer/components/ui/button'
import { ReasoningPart } from './parts/ReasoningPart'
import { TextPart } from './parts/TextPart'
import { ToolCard, type ToolCardPart } from './parts/ToolCard'

/**
 * 一条消息（用户 / 助手两种形态）。
 * 用户消息：右侧气泡 + 悬停出现的「编辑」（编辑 = 截断重发，见 ChatPage 的 editResend）；
 * 助手消息：左对齐的 part 流（文本 / 思考 / 工具卡在后面几步各自接上）。
 */
export interface MessageProps {
  message: UIMessage
  /** 这一条正在流式（最后一条助手消息且会话处于 streaming） */
  streaming?: boolean
  onEdit?: (messageId: string, text: string) => void
}

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

type MessagePart = UIMessage['parts'][number]

/** 静态工具 part（tool-<name>）与动态工具 part（dynamic-tool）都算工具调用 */
function isToolPart(part: MessagePart): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** 把 AI SDK 的 tool part 收成 ToolCard 认的形状（toolName / state / input / output / errorText） */
function toToolCardPart(part: MessagePart): ToolCardPart | null {
  if (part.type === 'dynamic-tool') {
    return {
      toolName: part.toolName,
      state: part.state,
      input: part.input,
      output: 'output' in part ? part.output : undefined,
      errorText: 'errorText' in part ? part.errorText : undefined
    }
  }
  if (!part.type.startsWith('tool-')) return null
  const tool = part as {
    type: string
    state: string
    input?: unknown
    output?: unknown
    errorText?: string
  }
  return {
    toolName: tool.type.slice('tool-'.length),
    state: tool.state,
    input: tool.input,
    output: tool.output,
    errorText: tool.errorText
  }
}

export function Message({ message, streaming = false, onEdit }: MessageProps): React.JSX.Element {
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
              {text}
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

  return (
    <article
      data-testid={`message-${message.id}`}
      data-role="assistant"
      data-streaming={streaming ? 'true' : undefined}
      className="animate-message-in flex flex-col gap-2"
    >
      {message.parts.map((part, index) => {
        // 光标（细竖线）只挂在最后一个可渲染的 part 上：末尾可能是不渲染的 file / step-start
        const isStreamingTail = streaming && index === lastRenderableIndex(message.parts)
        if (part.type === 'text') {
          return <TextPart key={`text-${index}`} text={part.text} streaming={isStreamingTail} />
        }
        if (part.type === 'reasoning') {
          return (
            <ReasoningPart
              key={`reasoning-${index}`}
              text={part.text}
              streaming={isStreamingTail}
            />
          )
        }
        const tool = toToolCardPart(part)
        if (tool) {
          return <ToolCard key={`tool-${index}`} part={tool} />
        }
        return null
      })}
    </article>
  )
}
