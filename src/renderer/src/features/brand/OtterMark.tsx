/**
 * kyclaw 品牌 mark · 守页海獭 v4-pixel（inline SVG，task-96）。
 *
 * 资产来源：`.superpowers/brand/otter-v4-pixel/otter-{animated,static}.svg`（设计侧交付）。
 * 本组件的 SVG 从 `otter-v4/*.svg?raw` 读入并**只保留栅格 path**：
 *   - 去掉原文件的 `<title>/<desc>/<style>`（装饰位 aria-hidden，不需要可访问名；样式统一在
 *     `otter-mark.css` 里按 `--om-*` 变量写，避免 inline `<style>` 泄漏到全局）；
 *   - `48×48` 整数栅格、`shape-rendering="crispEdges"`，只给 width/height（整数档 32/96/128），
 *     **不包 transform: scale / 不用 em** → 不随 `--ui-scale` 缩放，像素永远是整数倍栅格化；
 *   - 动效 = 3 帧 sprite strip + `steps(1,end)`（4s；光标闪/眨眼），reduced-motion 或
 *     `data-motion="reduced"` 时 `animation: none` → 自然定格帧 A（静态帧）；
 *   - 浅/深由 `:root[data-theme='dark']` 下的 `--om-*` CSS 变量同帧切换（无图片请求、无 sheet
 *     换载 → 不会出现「深色首帧 1–2s 空白」）。
 */
import { useMemo, type CSSProperties } from 'react'
import { cn } from '@renderer/components/ui/cn'
import animatedRaw from './otter-v4/otter-animated.svg?raw'
import staticRaw from './otter-v4/otter-static.svg?raw'
import './otter-mark.css'

/** 产品允许的整数档（与 DESIGN §7 落地建议一致；32 顶栏 / 96 欢迎页与关于 / 128 splash） */
export type OtterMarkSize = 32 | 96 | 128

export type OtterMarkVariant = 'animated' | 'static'

export interface OtterMarkProps {
  size: OtterMarkSize
  /** 动效版（3 帧 sprite）/ 静态版（帧 A）；reduced-motion 下两者视觉相同 */
  variant?: OtterMarkVariant
  /** 父层淡出/不可见时显式暂停（不重置帧） */
  paused?: boolean
  /** `reduced` = 强制静态帧（设置页「减弱」等壳层状态可直接传） */
  motion?: 'auto' | 'reduced'
  /** 落点样式（尺寸由 size 决定，这里只给布局/定位类） */
  className?: string
  /** 是否给原生 hover 提示；默认不给（装饰位 aria-hidden） */
  title?: string
}

/** 从设计文件里抽出 `<g class="strip">…</g>`（含 3 帧或 1 帧 path），并换成本组件的类名 */
function stripInnerOf(raw: string): string {
  const start = raw.indexOf('<g class="strip">')
  const end = raw.lastIndexOf('</g>')
  if (start < 0 || end < start) throw new Error('OtterMark：SVG 资产里找不到 strip 层')
  return raw.slice(start, end + 4).replace('class="strip"', 'class="otter-strip"')
}

const INNER = {
  animated: stripInnerOf(animatedRaw),
  static: stripInnerOf(staticRaw)
} as const

export function OtterMark({
  size,
  variant = 'animated',
  paused = false,
  motion = 'auto',
  className,
  title
}: OtterMarkProps): React.JSX.Element {
  const inner = useMemo(() => INNER[variant], [variant])
  return (
    <span
      data-testid="otter-mark"
      data-size={size}
      data-variant={variant}
      data-motion={motion}
      data-paused={paused ? 'true' : 'false'}
      aria-hidden="true"
      title={title}
      className={cn('otter-mark', className)}
      style={{ '--otter-mark-size': `${size}px` } as CSSProperties}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 48 48"
        width={size}
        height={size}
        shapeRendering="crispEdges"
        focusable="false"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: inner }}
      />
    </span>
  )
}
