import type { ComponentProps } from 'react'
import { cn } from './cn'

export type SpinnerSize = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<SpinnerSize, string> = {
  sm: 'size-(--icon-size-sm)',
  md: 'size-(--icon-size-md)',
  lg: 'size-(--icon-size-lg)'
}

export interface SpinnerProps extends ComponentProps<'span'> {
  /** 尺寸档（§4.7：按钮三档的 spinner 16 / 18 / 20） */
  size?: SpinnerSize
  /** 无障碍名（默认 role=status + 这个名字，读屏能念出来） */
  label?: string
  /** 装饰性：放进已经有 aria-busy 的容器（如 Button）时用，不进无障碍树、不污染可访问名 */
  decorative?: boolean
}

/**
 * 环形 loading：1s linear 常速（§6.5 "spinner 统一 1s linear infinite"），
 * 描边 1.5px（§5.3 唯一的 1.5px，出自 .overflow-spinner）。
 * 颜色跟 currentColor —— 放进按钮就是按钮的前景色。
 */
export function Spinner({
  size = 'md',
  label = '加载中',
  decorative = false,
  className,
  ...props
}: SpinnerProps): React.JSX.Element {
  return (
    <span
      {...props}
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      className={cn(
        'inline-block shrink-0 animate-spin rounded-pill border-(length:--spinner-stroke) border-t-current border-r-current border-b-transparent border-l-transparent',
        SIZE_CLASS[size],
        className
      )}
    />
  )
}
