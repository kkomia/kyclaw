/**
 * 站点视觉降级（0.1.3 网页引用）：host 首字母 + 稳定底色；认不出字母/数字时回落到 Globe。
 *
 * 为什么不是真实 favicon：渲染端 CSP 是 `img-src 'self' data:`，不允许远程图片；
 * 直接放宽 CSP 或 `<img src="https://host/favicon.ico">` 会把任意 URL 变成图片请求。
 * 真实 favicon 需要主进程代理抓取 + 缓存 + 尺寸校验，另立任务；这里只做**本地、无网络**
 * 的站点识别，不冒充 favicon。图标是装饰，对读屏隐藏（标题 / host 由旁边的文字承担）。
 */
import { Globe } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'

/** 静态类名（Tailwind 只扫描字面量，别拼字符串） */
const TINTS = [
  'bg-selected text-accent-text',
  'bg-secondary text-ink-secondary',
  'bg-hover text-ink',
  'bg-active text-ink-secondary'
] as const

function initialOf(host: string): string | undefined {
  const first = Array.from(host)[0]
  if (first === undefined) return undefined
  return /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : undefined
}

/** 稳定分桶：同一 host 每次渲染颜色一致（不用随机，避免流式期间闪色） */
function tintOf(host: string): string {
  let hash = 0
  for (const char of host) {
    hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return TINTS[hash % TINTS.length] ?? TINTS[0]
}

export interface SiteMarkProps {
  /** 展示用 host（可带非默认端口；`www.` 已被 hostOf 去掉） */
  host: string
  className?: string
}

export function SiteMark({ host, className }: SiteMarkProps): React.JSX.Element {
  const initial = initialOf(host)
  return (
    <span
      data-testid="site-mark"
      data-site-host={host}
      aria-hidden="true"
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold',
        initial === undefined ? 'text-ink-tertiary' : tintOf(host),
        className
      )}
    >
      {initial ?? <Globe className="size-3" />}
    </span>
  )
}
