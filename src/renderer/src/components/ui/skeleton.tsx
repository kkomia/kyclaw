import type { ComponentProps } from 'react'
import { cn } from './cn'

/**
 * 骨架屏（§6.6 的 shimmer 关键帧：background-position 200% → 0，1.4s linear 循环）。
 * 底用 Fills-F2、高光按主题换档（浅色比底更亮、深色换白高光），两者都在 semantic.css。
 * 尺寸与圆角由调用方给（默认 4px 圆角对应单行文字），本组件只负责"底 + 动画"。
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn('shimmer rounded-badge bg-(--skeleton-base)', className)}
      {...props}
    />
  )
}
