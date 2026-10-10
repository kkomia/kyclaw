import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ReactElement, ReactNode } from 'react'
import { cn } from './cn'

export type DialogSize = 'sm' | 'md'

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'w-(--overlay-width-sm)',
  md: 'w-(--overlay-width-md)'
}

export interface DialogProps {
  /** 触发元素：单元素，套 Radix 的 asChild */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 标题：Radix 的无障碍要求，必填 */
  title: ReactNode
  description?: ReactNode
  /** 尺寸两档（§4.5：small 360 / medium 560） */
  size?: DialogSize
  /** 底部动作区（右对齐，放 Button） */
  footer?: ReactNode
  children?: ReactNode
  className?: string
}

/**
 * 弹窗（UI 参考 §4.5：尺寸 360 / 560、圆角 20、最大宽 calc(100vw - 32px)、居中）。
 * 蒙层用 MaskBg-Base —— spec §6.3 说"仅模态用蒙层"，弹窗就是那个模态。
 * 关闭途径：Esc、点蒙层（Radix 自带，含还焦点到触发元素）；底部动作按钮由 footer 里的 Button 自己接。
 */
export function Dialog({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  size = 'sm',
  footer,
  children,
  className
}: DialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger === undefined ? null : (
        <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      )}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-mask" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 max-w-(--overlay-max-width) -translate-x-1/2 -translate-y-1/2 rounded-overlay bg-(--bg-overlay) p-6 shadow-(--shadow-overlay)',
            SIZE_CLASS[size],
            className
          )}
        >
          <DialogPrimitive.Title className="text-t1 font-medium text-ink">
            {title}
          </DialogPrimitive.Title>
          {description === undefined ? null : (
            <DialogPrimitive.Description className="mt-2 text-b2 text-ink-secondary">
              {description}
            </DialogPrimitive.Description>
          )}
          {children === undefined ? null : <div className="mt-4">{children}</div>}
          {footer === undefined ? null : (
            <div className="mt-6 flex justify-end gap-2">{footer}</div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
