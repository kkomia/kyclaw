import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { cn } from './cn'
import { IconButton } from './icon-button'

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
 * 关闭途径：Esc、点蒙层（Radix 自带，含还焦点到触发元素）、右上角 DialogClose、footer 里的 Button。
 * 面板自己带 outline-none：Radix 打开时会把焦点落到面板上，焦点环留给内部元素表达（§5.4）。
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
            'fixed top-1/2 left-1/2 z-50 max-w-(--overlay-max-width) -translate-x-1/2 -translate-y-1/2 rounded-overlay bg-(--bg-overlay) p-6 shadow-(--shadow-overlay) outline-none',
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

export interface DialogCloseProps {
  /** 无障碍名 */
  label?: string
  className?: string
}

/**
 * 弹窗右上角的关闭钮（R12：一律受控用法 —— 它只把 open=false 回吐给调用方，自己不存状态）。
 * 外观就是图标按钮（§4.7：36 高、圆角 20、.5px 描边、图标 18），浮在面板角上。
 */
export function DialogClose({ label = '关闭', className }: DialogCloseProps): React.JSX.Element {
  return (
    <DialogPrimitive.Close asChild>
      <IconButton label={label} icon={<X />} className={cn('absolute top-3 right-3', className)} />
    </DialogPrimitive.Close>
  )
}
