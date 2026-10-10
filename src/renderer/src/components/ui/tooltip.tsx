import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ReactElement, ReactNode } from 'react'
import { cn } from './cn'

export interface TooltipProps {
  label: ReactNode
  /** 触发元素：单元素，套 Radix 的 asChild */
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /** 与触发元素的距离，默认 4（= --space-1） */
  sideOffset?: number
  className?: string
}

/**
 * 提示气泡（§2.9 的"常色"一对：深色填充 60% 黑做底 + 84% 白字，两主题同值；
 * 字号取 §3.1 的 C2 档 = 10/14）。
 * 圆角与内边距 UI 参考没点名：圆角取 §5.2 的第二主力档 8px，内边距取 §4.4 的 `0 8px`。
 * Provider 内置 —— 调用方不必记着在应用根部挂一个，多个 Tooltip 相邻也不会互相影响语义。
 */
export function Tooltip({
  label,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 4,
  className
}: TooltipProps): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={sideOffset}
            className={cn(
              'z-50 rounded-button-sm bg-(--tooltip-bg) px-2 py-1 text-c2 text-(--tooltip-fg)',
              className
            )}
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
