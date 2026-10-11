/**
 * 图片预览：主进程回的原字节 → data URL → `<img>`。
 *
 * 为什么是 data URL 而不是 `file://` 或 `blob:`：CSP 只放行了 `img-src 'self' data:`，
 * 而仓库里"渲染端显示本地图片"本来就是 data URL 口径（composer 附件 / 消息 part / 插件图标同路数）。
 * 代价是 base64 膨胀约 33%（8MB 的图上限 = 约 10.7MB 字符串），换来的是不改 CSP、不留对象 URL 生命周期。
 */
import { useState } from 'react'
import type { FileByteFormat } from '@shared/workbench'
import { IMAGE_MIME } from './modes'

/** 原字节 → data URL（分块拼二进制串：一次性 apply 大数组会爆栈） */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

export function ImagePreview({
  format,
  bytes
}: {
  format: FileByteFormat
  bytes: Uint8Array
}): React.JSX.Element {
  const [broken, setBroken] = useState(false)

  if (broken) {
    return (
      <p data-testid="file-preview-image-error" className="px-3 py-2 text-b2 text-ink-secondary">
        这张图片打不开（文件可能损坏）
      </p>
    )
  }

  return (
    <div data-testid="file-preview-image" className="flex items-center justify-center p-3">
      <img
        // 面板宽高都不固定，`max-h-full` 会解析成"无上限"，所以高度按视口限一档
        className="max-h-[50vh] max-w-full object-contain"
        alt=""
        src={toDataUrl(bytes, IMAGE_MIME[format] ?? 'application/octet-stream')}
        onError={() => setBroken(true)}
      />
    </div>
  )
}
