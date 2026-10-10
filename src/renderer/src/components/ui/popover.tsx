import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ReactElement, ReactNode } from 'react'
import { cn } from './cn'
import { OVERLAY_SURFACE_CLASS } from './surface'

export interface PopoverProps {
  /** 触发元素：单元素，套 Radix 的 asChild */
  trigger: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 与触发元素的距离，默认 4（= --space-1） */
  sideOffset?: number
  children: ReactNode
  className?: string
}

/**
 * 气泡弹层（spec §6.3 的"菜单类弹层"配方：底 Bg-Tertiary、圆角 ≈20、玻璃 blur(15px) 裸写法；
 * 阴影取 §5.4 的弹层特征值）。**无蒙层**——蒙层只给模态。
 * 内边距 UI 参考没点名，取 §4.4 的主力组合 16px（`0 16px`）。
 */
export function Popover({
  trigger,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
  children,
  className
}: PopoverProps): React.JSX.Element {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={sideOffset}
          className={cn(OVERLAY_SURFACE_CLASS, 'p-4', className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
