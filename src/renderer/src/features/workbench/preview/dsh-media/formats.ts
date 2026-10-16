/**
 * dsh-media：图片字节 → MIME 的单一映射 + data URL 编码（纯函数，单测直接打）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/image/ImageBody.tsx` 顶部那张
 * `IMAGE_MEDIA_TYPES`，两处与上游不同：
 *   1) **格式集合跟共享枚举走**：`DshImageFormat` 从 `fileByteFormatSchema` 里把 `image-*` 抽出来
 *      （png/jpeg/gif/webp/bmp + 本轮新收的 ico/svg），**不在本文件另写一份名单** ——
 *      共享枚举加一种图片格式，这里跟着变；
 *   2) **继续用 data URL**（与既有 `ImagePreview` 同口径）：本仓 CSP 只放行
 *      `img-src 'self' data:`，上游用的 Blob URL 在这里会被 CSP 挡掉；data URL 的代价是 base64
 *      膨胀约 33%（预览上限 30MB，见 `PREVIEW_IMAGE_MAX_BYTES`），换来的是不改 CSP。
 *
 * SVG 的安全口径与上游一致、也与 `shared/workbench.ts` 里的合同一致：字节只经 `<img>` 的
 * data URL 静态图上下文进入渲染，**SVG 标记永远不进应用 DOM、也不进 iframe** ——
 * `<img>` 里的 SVG 不执行脚本、拿不到父页面。
 */
import type { FileByteFormat } from '@shared/workbench'

/** 本组件认的图片格式：共享字节枚举里的 `image-*` 一族（含 svg / ico）。 */
export type DshImageFormat = Extract<FileByteFormat, `image-${string}`>

/** 格式 → MIME（键与上游同名枚举逐项对齐）。 */
export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  'image-png': 'image/png',
  'image-jpeg': 'image/jpeg',
  'image-gif': 'image/gif',
  'image-webp': 'image/webp',
  'image-bmp': 'image/bmp',
  'image-ico': 'image/x-icon',
  'image-svg': 'image/svg+xml'
}

/** 原始字节 → data URL（分块拼二进制串：一次性 apply 大数组会爆栈）。 */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}
