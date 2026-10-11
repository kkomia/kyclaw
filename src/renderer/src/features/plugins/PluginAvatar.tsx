import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { avatarInitialOf, avatarToneOf } from './avatar'

/**
 * 插件/市场头像（round 23）：有本地图标资源 → 显示图片（data URL，经 `plugins:icon` 读回，
 * 大小/类型/containment 都在主进程把关）；没有 → 字母头像（首字母 + 名称哈希定的稳定中性底色）。
 * 尺寸 32（size-8、圆角 control）；`alt=""` + aria-hidden：名字就在同一行的文本里，读屏不重复念。
 * data URL 坏了（onError）也回字母头像——按"坏的是哪一个 URL"记账，换图标自动重试。
 */
export interface PluginAvatarProps {
  name: string
  /** 图标 data URL（没有 = null / undefined → 字母头像） */
  iconDataUrl?: string | null
  className?: string
}

export function PluginAvatar({
  name,
  iconDataUrl = null,
  className
}: PluginAvatarProps): React.JSX.Element {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)

  if (iconDataUrl !== null && iconDataUrl !== '' && iconDataUrl !== brokenUrl) {
    return (
      <img
        data-testid="plugin-avatar-img"
        src={iconDataUrl}
        alt=""
        aria-hidden="true"
        onError={() => setBrokenUrl(iconDataUrl)}
        className={cn(
          'size-8 shrink-0 rounded-control border-(length:--hairline-width) border-hairline object-cover',
          className
        )}
      />
    )
  }
  return (
    <span
      data-testid="plugin-avatar"
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-control text-b2 font-medium text-ink-secondary select-none',
        avatarToneOf(name),
        className
      )}
    >
      {avatarInitialOf(name)}
    </span>
  )
}
