import type { ComponentProps } from 'react'
import { cn } from './cn'

/**
 * 字段外观（UI 参考 §4.7 .kimi-select）：40 高、圆角 12、`.5px solid var(--Fills-F1)` 描边。
 * 底色按 §2.14 实测分档（浅 = Bg-Primary 的 #ffffff、深 = Bg-Secondary 的 #1f1f1f，见 semantic.css）。
 * 占位文字用达标四级灰（台账 R6）；禁用态（T5 随修 T3 遗留）文字与占位符一起降到禁用档、光标禁止。
 */
const FIELD_CLASS =
  'w-full rounded-field border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) text-b2 text-ink transition-colors duration-(--motion-fast) ease-main placeholder:text-(--text-quaternary) disabled:cursor-not-allowed disabled:text-(--text-disabled) disabled:placeholder:text-(--text-disabled)'

export function Input({ className, ...props }: ComponentProps<'input'>): React.JSX.Element {
  return <input className={cn(FIELD_CLASS, 'h-(--field-height) px-3', className)} {...props} />
}

/**
 * 多行输入：同一套字段外观，高度改成"最小 40"（可随内容长高），
 * 纵向内边距 8（§4.2 的 8px 是最高频档），禁用拖拽角（走查不合再放开）。
 */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>): React.JSX.Element {
  return (
    <textarea
      className={cn(FIELD_CLASS, 'min-h-(--field-height) resize-none px-3 py-2', className)}
      {...props}
    />
  )
}
