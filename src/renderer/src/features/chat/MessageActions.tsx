import type { ReactNode } from 'react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 消息动作行的图标按钮（round 63；0.1.3 返工抽出为独立组件）。
 *
 * 钮上一个字都不写：语义靠 `aria-label` + `title`（图标是装饰，对读屏隐藏）。
 * 尺寸与间距照 composer（ComposerControls 的 ICON_TRIGGER_CLASS），点击热区 32×32 ≥ 28×28。
 *
 * 抽出的原因：网页来源入口现在必须和「复制 / 重新生成」**同一行**（0.1.3 返工），
 * 两处都要用同一枚图标钮；放在这里比在 Message.tsx 里互相 import 更不容易把
 * 动作行与消息体绑成一团（也方便与图片相关的改动分开）。
 */
export interface MessageActionProps {
  testId: string
  /** 无障碍名，也当 title 用（中文，如「复制」） */
  label: string
  onClick: () => void
  children: ReactNode
  /** 可开合入口（网页来源）：展开态 */
  ariaExpanded?: boolean
  /** 可开合入口控制的列表 id */
  ariaControls?: string
}

export function MessageAction({
  testId,
  label,
  onClick,
  children,
  ariaExpanded,
  ariaControls
}: MessageActionProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
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
export function MessageActions({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="message-actions"
      className={cn(
        'flex items-center gap-1 opacity-0 transition-opacity duration-(--motion-fast) group-hover:opacity-100 focus-within:opacity-100',
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * 动作组之间的**单竖线**（0.1.3 返工：复制 / 重新生成 | 网页来源入口）。
 * 只是分隔符：不给读屏念，不占动作的点击热区。
 */
export function MessageActionsDivider(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="message-actions-divider"
      className="mx-0.5 h-4 w-px shrink-0 bg-hairline"
    />
  )
}
