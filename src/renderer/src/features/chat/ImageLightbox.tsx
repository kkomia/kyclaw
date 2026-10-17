import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

/**
 * 图片放大预览（lightbox）：全屏遮罩 + 图片居中 contain（≤90vw / 85vh）。
 *
 * 这套原本长在 `PendingImageTile` 里（round 50）。0.1.3 / 006 返工把用户消息里的
 * 图片缩略图也接上同一个预览，于是抽成独立组件复用 —— **一份实现**，输入框附件与
 * 消息附件不会各长一套。缩放 / 拖拽仍归右侧预览工作台（001），这里只做"看得更大"。
 *
 * 关闭途径：右上角关闭钮、点遮罩空白、Esc（Radix 自带，含焦点管理 / 还焦点到触发元素）。
 * 图片只经 `<img>` 静态上下文显示，不解析 SVG 标记；右键不吃原生菜单（与预览区同口径）。
 */
export interface ImageLightboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  name: string
  /** 根节点 / 图片 / 关闭钮的 data-testid 前缀（默认 `image-lightbox`） */
  testId?: string
}

export function ImageLightbox({
  open,
  onOpenChange,
  src,
  name,
  testId = 'image-lightbox'
}: ImageLightboxProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-mask data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <DialogPrimitive.Content
          data-testid={testId}
          onClick={(event) => {
            if (event.target === event.currentTarget) onOpenChange(false)
          }}
          onContextMenu={(event) => event.preventDefault()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-transparent outline-none data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out"
        >
          <DialogPrimitive.Title className="sr-only">图片预览</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            放大查看 {name}；按 Esc 键或点击空白处关闭。
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            data-testid={`${testId}-close`}
            aria-label="关闭"
            className="absolute top-3 right-3 z-10 inline-flex size-10 items-center justify-center rounded-full bg-(--tooltip-bg) text-(--tooltip-fg) transition-opacity duration-(--motion-fast) ease-main hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text motion-reduce:transition-none"
          >
            <X aria-hidden="true" className="size-5" />
          </DialogPrimitive.Close>
          <img
            data-testid={`${testId}-img`}
            src={src}
            alt={name}
            draggable={false}
            onContextMenu={(event) => event.preventDefault()}
            className="max-h-[85vh] max-w-[90vw] object-contain"
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
