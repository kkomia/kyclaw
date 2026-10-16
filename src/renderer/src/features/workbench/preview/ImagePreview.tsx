/**
 * 图片预览（接线薄壳）：模式分派与字节读取都在外层，这里只把"一份图片字节"交给
 * `dsh-media/image-body.tsx`（DSH 图片阅读器移植：SVG/ICO 在内共八种格式 + 统一缩放视口 +
 * 旋转 + 双击回位）。
 *
 * 为什么保留这个文件名与入参形状：`PreviewBody` 的字节分支与既有 spec 都按
 * `{ format, bytes }` 调它；实现搬家到 `dsh-media/` 之后这里只做转发，接线一处都不用动。
 *
 * `format` 收的是 **`DshImageFormat`（共享字节枚举里的 `image-*` 一族：png/jpeg/gif/webp/bmp/ico/svg）**：
 * `PreviewBody` 在字节分支里先摘掉 pdf / html 再把它传进来，类型上是精确的收窄，不用断言。
 *
 * 安全口径与缩放边界见 `dsh-media/image-body.tsx` 头注（SVG 只走 `<img>` 的 data URL，不进 DOM；
 * 图片保留 round 52 那套 10%–800% / ×1.25 的能力，边界由共用的 `ZoomViewport` 配置项给）。
 */
import type { DshImageFormat } from './dsh-media/formats'
import { DshImageBody } from './dsh-media/image-body'

export function ImagePreview({
  format,
  bytes
}: {
  format: DshImageFormat
  bytes: Uint8Array
}): React.JSX.Element {
  return <DshImageBody format={format} bytes={bytes} />
}
