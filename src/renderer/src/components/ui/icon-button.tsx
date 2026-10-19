import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

export interface IconButtonProps extends ComponentProps<'button'> {
  /** 无障碍名（也是画 tooltip 时的文案来源；要 tooltip 就用 Tooltip 把本组件包一层） */
  label: string
  icon: ReactNode
  /** 只改图标盒尺寸（热区/间距不动）：如窗口控制用 --icon-size-window-control */
  iconClassName?: string
}

/**
 * 图标按钮（UI 参考 §4.7 .linear-icon-button / §4.8 图标不透明度）：
 * 36 高、圆角 20、.5px 描边、图标 18、不透明度 .56 / hover .84 / disabled .26。
 * 悬停只改图标不透明度（Kimi 的三档就是图标的不透明度，不铺底色）。
 */
export function IconButton({
  label,
  icon,
  iconClassName,
  type = 'button',
  disabled,
  className,
  ...props
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      aria-label={label}
      disabled={disabled}
      data-disabled={disabled === true ? '' : undefined}
      className={cn(
        'group inline-flex size-(--icon-button-size) shrink-0 items-center justify-center rounded-icon-button border-(length:--hairline-width) border-hairline bg-transparent text-ink disabled:cursor-not-allowed',
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-(--icon-size-md) shrink-0 opacity-(--icon-opacity) transition-opacity duration-(--motion-fast) ease-main group-hover:opacity-(--icon-opacity-hover) group-data-disabled:opacity-(--icon-opacity-disabled) [&>svg]:size-full',
          iconClassName
        )}
      >
        {icon}
      </span>
    </button>
  )
}
