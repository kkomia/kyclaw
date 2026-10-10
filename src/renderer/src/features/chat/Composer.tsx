import { useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 输入卡（UI 参考 §4.6 实测）：宽 max 768、圆角 24、首屏三段＝横幅带 40 + 输入框 111 + 底栏带 49；
 * 发送钮直径 36、图标 28。
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
      className="mx-auto w-full max-w-(--chat-input-max-width) rounded-input border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) shadow-(--shadow-input)"
    >
      {/* 横幅带（40）：首屏形态的一部分；流式排队时在这里露一条提示 */}
      <div data-testid="composer-banner" className="flex h-10 items-center px-4">
        {queuedCount > 0 ? (
          <span data-testid="composer-queue" className="text-c2 text-ink-tertiary">
            已排队 {queuedCount} 条，当前回复结束后自动发出
          </span>
        ) : null}
      </div>

      {/* 输入框带（111） */}
      <div className="px-4">
        <textarea
          data-testid="composer-input"
          aria-label="输入消息"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            // 输入法合成中（中文/日文候选）的回车是在选词，不算发送
            if (event.nativeEvent.isComposing) return
            event.preventDefault()
            submit()
          }}
          placeholder="输入你的问题，Enter 发送"
          className="h-[111px] w-full resize-none bg-transparent py-3 text-b1 text-ink outline-none placeholder:text-(--text-quaternary)"
        />
      </div>

      {/* 底栏带（49） */}
      <div
        data-testid="composer-footer"
        className="flex h-[49px] items-center justify-between px-4"
      >
        <span className="text-c2 text-ink-tertiary">Enter 发送 · Shift+Enter 换行</span>
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
