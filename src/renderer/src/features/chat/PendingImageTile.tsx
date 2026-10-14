import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AtSign, Trash2 } from 'lucide-react'
import { Tooltip } from '@renderer/components/ui/tooltip'
import type { PendingAttachment } from './composer-attachments'

/**
 * 图片附件的磁贴（round 50，用户口径 + Kimi 实拍）：粘贴/上传进来的图片不再走文字 chip，
 * 而是一张 **64px 圆角小磁贴**（缩略图 object-cover、细描边；右下角一个数字小徽章——序号
 * 就是「提及图片 N」用的那个数，徽章是它的可见图例）。
 *
 *   - hover / 键盘聚焦时浮出半透明遮罩 + 两个图标钮：**删除**（Trash2）与 **@ 提及**（AtSign，
 *     提示「提及图片 N」）；按钮常驻 DOM、靠 opacity 过渡（`--motion-fast`，不硬切），
 *     所以键盘也能走到（group-focus-within）；
 *   - **点磁贴空白处 = 放大预览**：全屏遮罩 lightbox（≤90vw/85vh contain），点遮罩空白 / Esc 关闭，
 *     进出场走既有浮层动效（animate-fade-in / animate-dialog-in，不硬切）；
 *   - 右键一律不吃原生菜单（雷点 4，与预览区同口径）；
 *   - **提及只是文字指路**：把 `【引用】图片：图N` 插进输入框（走既有引用 chip 覆盖层），
 *     图片本体仍作为附件随消息真发（见 composer-attachments 的 outgoingFilesOf），不重复携带载荷。
 */
const TILE_ACTION_CLASS =
  'pointer-events-auto inline-flex size-6 shrink-0 items-center justify-center rounded-pill text-(--tooltip-fg) transition-colors duration-(--motion-fast) ease-main hover:bg-(--fill-active) motion-reduce:transition-none'

export interface PendingImageTileProps {
  attachment: PendingAttachment
  /** 图片本体（data URL）；调用方已判 undefined */
  image: { url: string; mediaType: string }
  /** 图片序号（1 基）：徽章与「提及图片 N」共用这一个数（按附件条里图片的当前顺序） */
  index: number
  onRemove: () => void
  onMention: () => void
}

export function PendingImageTile({
  attachment,
  image,
  index,
  onRemove,
  onMention
}: PendingImageTileProps): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false)

  return (
    <>
      <div
        data-testid={`composer-attachment-${attachment.name}`}
        data-image-tile="true"
        className="group relative size-16 shrink-0 overflow-hidden rounded-control border-(length:--hairline-width) border-surface-border"
      >
        {/* 整块磁贴 = 预览钮（"点空白处"落在它身上；操作钮是它的兄弟层，不会误触到预览） */}
        <button
          type="button"
          data-testid="composer-image-preview-open"
          aria-label={`预览 ${attachment.name}`}
          onClick={() => setPreviewOpen(true)}
          className="block size-full cursor-zoom-in"
        >
          <img
            data-testid={`composer-attachment-thumb-${attachment.name}`}
            src={image.url}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="size-full object-cover"
          />
        </button>

        {/* hover / 聚焦浮出的操作层：半透明遮罩 + 删除 / @ 提及（opacity 过渡，不硬切） */}
        <div
          data-testid="composer-image-overlay"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-1 bg-mask opacity-0 transition-opacity duration-(--motion-fast) ease-main group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
        >
          <Tooltip label={`删除图片 ${index}`}>
            <button
              type="button"
              data-testid="composer-image-remove"
              aria-label={`删除图片 ${index}`}
              // 按下不抢输入框焦点：光标原地不动，删除/提及都不会把输入位置带偏
              onMouseDown={(event) => event.preventDefault()}
              onClick={onRemove}
              className={TILE_ACTION_CLASS}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </button>
          </Tooltip>
          <Tooltip label={`提及图片 ${index}`}>
            <button
              type="button"
              data-testid="composer-image-mention"
              aria-label={`提及图片 ${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onMention}
              className={TILE_ACTION_CLASS}
            >
              <AtSign aria-hidden="true" className="size-3.5" />
            </button>
          </Tooltip>
        </div>

        <span
          data-testid="composer-image-badge"
          className="pointer-events-none absolute right-1 bottom-1 z-10 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-(--tooltip-bg) px-1 text-c2 text-(--tooltip-fg) tabular-nums"
        >
          {index}
        </span>
      </div>

      <ImageLightbox
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        src={image.url}
        name={attachment.name}
      />
    </>
  )
}

/**
 * 放大预览（lightbox）：全屏遮罩（bg-mask）+ 图片居中 contain（≤90vw/85vh）。
 * 用 Radix Dialog 的原语（Portal / 焦点管理 / Esc / 进出场 Presence 全复用 ui/dialog 那套），
 * 但外框自己画：内容铺满视口做居中容器——"点空白"就是点它自己（event.target === currentTarget）。
 */
function ImageLightbox({
  open,
  onOpenChange,
  src,
  name
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  name: string
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-mask data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <DialogPrimitive.Content
          data-testid="composer-image-lightbox"
          onClick={(event) => {
            if (event.target === event.currentTarget) onOpenChange(false)
          }}
          // 雷点 4：原生右键菜单不进客户端（预览区同口径）
          onContextMenu={(event) => event.preventDefault()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-transparent outline-none data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out"
        >
          <DialogPrimitive.Title className="sr-only">图片预览</DialogPrimitive.Title>
          <img
            data-testid="composer-image-lightbox-img"
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
