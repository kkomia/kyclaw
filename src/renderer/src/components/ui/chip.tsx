import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

export interface ChipProps extends ComponentProps<'button'> {
  icon?: ReactNode
}

/**
 * 快捷 chip（UI 参考 §4.6 实测）：高 36、药丸、1px 描边、无独立底色；
 * 文字取量到的 #505050/#979797 那一档（= --text-secondary）。
 * 横向间隙 12 是行内布局的事，由放它的父容器给（§4.6：chip 行 gap 约 12）。
 */
export function Chip({
  icon,
  type = 'button',
  className,
  children,
  ...props
}: ChipProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-(--chip-height) shrink-0 items-center gap-1.5 rounded-pill border border-hairline bg-transparent px-3 text-b2 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover active:bg-active',
        className
      )}
      {...props}
    >
      {icon === undefined ? null : (
        <span aria-hidden="true" className="size-(--icon-size-sm) shrink-0 [&>svg]:size-full">
          {icon}
        </span>
      )}
      {children}
    </button>
  )
}
