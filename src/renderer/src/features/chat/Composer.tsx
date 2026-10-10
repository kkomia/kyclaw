import { ArrowUp, Square } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 输入卡（UI 参考 §4.6 实测）：宽 max 768、圆角 24（--chat-input-radius）；
 * 结构 = 输入区（自适应，最小 48 / 最大 170，超出内部滚动）+ 底部工具条（48，右端发送钮）；
 * 发送钮直径 36、图标 28（§4.8 `.send-icon`）。
 *
 * 高度按 Kimi 实况页（a84af355 截图：单行输入 + 一行工具条），默认单行时紧凑，
 * 不再固定三段 "40 + 111 + 49" —— 那是首屏形态，常态下多出来的空白正是用户点名的"过高"。
 * 字号/提示不做小字说明（雷点 2）：键盘行为靠肌肉记忆与按钮语义，不写提示行。
 *
 * 交互：Enter 发送 / Shift+Enter 换行（输入法合成中不拦截）；流式中发送钮变停止（stop()）；
 * 流式中按下发送不丢内容 —— 交给上层排队（见 ChatPage 的队列）。
 * 组件本身不碰聊天状态：只把 onSend / onStop 抛上去，好单测。
 */
export interface ComposerProps {
  /** 流式中（submitted / streaming）：发送钮切换为停止 */
  busy?: boolean
  /** 已排队的条数（流式中发送的消息），0 时不显示 */
  queuedCount?: number
  onSend: (text: string) => void
  onStop: () => void
}

export function Composer({
  busy = false,
  queuedCount = 0,
  onSend,
  onStop
}: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const canSend = draft.trim() !== ''

  const submit = (): void => {
    if (!canSend) return
    onSend(draft.trim())
    setDraft('')
  }

  return (
    <div
      data-testid="composer"
      className="focus-ring-container mx-auto w-full max-w-(--chat-input-max-width) rounded-input border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) shadow-(--shadow-input)"
    >
      {/* 输入区：随内容长高（field-sizing），到 --composer-input-max-height 封顶后内部滚动。
          焦点指示由卡片给（focus-ring-container）：输入框自己没有圆角，自己画环就是直角方框。 */}
      <textarea
        data-testid="composer-input"
        aria-label="输入消息"
        rows={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return
          // 输入法合成中（中文/日文候选）的回车是在选词，不算发送
          if (event.nativeEvent.isComposing) return
          event.preventDefault()
          submit()
        }}
        placeholder="输入你的问题"
        className="field-sizing-content block max-h-(--composer-input-max-height) min-h-(--composer-input-min-height) w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-b1 text-ink outline-none placeholder:text-(--text-quaternary) focus-visible:shadow-none"
      />

      {/* 工具条：左边只放真实状态（排队条数），右端发送 / 停止 */}
      <div
        data-testid="composer-footer"
        className="flex h-(--composer-toolbar-height) items-center gap-3 px-3"
      >
        <span className="min-w-0 flex-1 truncate">
          {queuedCount > 0 ? (
            <span data-testid="composer-queue" className="text-c1 text-ink-secondary">
              已排队 {queuedCount} 条，当前回复结束后自动发出
            </span>
          ) : null}
        </span>
        {busy ? (
          <button
            type="button"
            data-testid="composer-stop"
            aria-label="停止生成"
            onClick={onStop}
            className="flex size-9 items-center justify-center rounded-pill bg-(--button-primary-bg) text-(--button-primary-fg) transition-colors duration-(--motion-main) ease-main hover:bg-(--button-primary-bg-hover)"
          >
            <Square aria-hidden="true" className="size-5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            data-testid="composer-send"
            aria-label="发送"
            disabled={!canSend}
            onClick={submit}
            className={cn(
              'flex size-9 items-center justify-center rounded-pill transition-colors duration-(--motion-main) ease-main',
              canSend
                ? 'bg-(--button-primary-bg) text-(--button-primary-fg) hover:bg-(--button-primary-bg-hover)'
                : 'bg-(--fill-disabled) text-(--text-disabled)'
            )}
          >
            <ArrowUp aria-hidden="true" className="size-7" />
          </button>
        )}
      </div>
    </div>
  )
}
