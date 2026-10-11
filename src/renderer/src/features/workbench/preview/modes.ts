/**
 * 预览路由（纯函数，单测直接打）：按文件名后缀决定用哪条通道、哪个渲染器。
 *
 * 三条路：
 *   - `text`：现有的文本通道（`workbench:read-file`，64KB 有界，`<pre>` 原样）；
 *   - `markdown`：同样是文本通道，但过 markdown 渲染器（`.md` / `.markdown`）；
 *   - `image` / `pdf`：走新的字节通道（`workbench:read-bytes`），渲染端真画出来。
 *
 * 为什么按后缀分流而不是"先读回来再看内容"：文本通道 64KB 且只给字符串，图片/PDF 拿不到字节；
 * 反过来给所有文件都拉一次字节也太重。后缀是这里唯一便宜的判据（真格式判定在主进程，头对不上
 * 会回 `unsupported`，渲染端回落二进制占位）。
 */
export type PreviewMode = 'text' | 'markdown' | 'image' | 'pdf'

const MARKDOWN_EXTENSIONS = ['md', 'markdown']
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']

/** 取小写后缀（不含点；正反斜杠都认；没有后缀给空串） */
export function extensionOf(relative: string): string {
  const base = relative.slice(Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 后缀 → 预览方式（认不出的一律走现有文本通道，保持既有行为） */
export function previewModeOf(relative: string): PreviewMode {
  const extension = extensionOf(relative)
  if (MARKDOWN_EXTENSIONS.includes(extension)) return 'markdown'
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  return 'text'
}

/** 图片格式 → data URL 的 MIME（主进程回的格式枚举，六种都在这里收口） */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  'image-png': 'image/png',
  'image-jpeg': 'image/jpeg',
  'image-gif': 'image/gif',
  'image-webp': 'image/webp',
  'image-bmp': 'image/bmp'
}
