/**
 * 像素海獭 · 装饰性动画组件（品牌 mark，不是助手人格；设计稿 v4 / D-32）。
 *
 * **task-96 起**：splash（128 inline SVG）/ ChatHeader 品牌位（32 static）/ 欢迎页（96 动画）/
 * 关于页（96 动画）四处已换 v4-pixel 的 `OtterMark`（inline SVG，见 ./OtterMark.tsx）；
 * 本组件**保留作回退**，目前仍用于「输入卡右上角状态灯」（task-62 落位，size 32；状态
 * idle/think/type）。如需整体回退四处，把对应调用换回 `<PixelOtter …>` 即可（资产与测试未删）。
 *
 * 资产：`src/renderer/src/assets/pixel-otter/`（task-65 子集 launch-v2，35 文件 47,493 B；
 * **32×32 栅格**、8 色、每侧 3 根胡须；显示尺寸全是 32 的整数倍）。
 * sheet 档位/挑档在 `pixel-otter-sheets.ts`（本文件只导出组件，react-refresh 口径）。splash 不走本组件
 * （index.html 内联 SVG）。落点：
 *   - 输入卡右上角状态灯（task-62 落位）：size 32，state idle/think/type；
 *   - chat 初始页欢迎 logo：size 96（A 信笺报头；API 支持 96/128），state wave→float。
 *
 * 实现要点：
 *   - **sprite sheet + CSS steps()**：一种状态一张横向 sheet，`background-position-x` 逐帧跳；
 *     `image-rendering: pixelated` 保证最近邻放大（整数倍优先，不插值）。
 *   - **主题跟随全局**：渲染浅/深两层，用 `:root[data-theme='dark']` 切显隐；不新增设置项。
 *   - **reduced-motion**：`@media (prefers-reduced-motion: reduce)` 停动画并停在 manifest 的
 *     `reducedFrame`（静态帧，不是隐藏）。
 *   - **不可见就停**：IntersectionObserver（进出视口）+ `document.visibilitychange` 暂停
 *     `animation-play-state`；`paused` prop 给"父层已淡出/不活动"时显式停（WelcomeHero 离场）。
 *   - **a11y**：纯装饰 `aria-hidden="true"`；`title` 只做原生 hover 提示（"kyclaw"），不进可访问树。
 *   - **布局**：显式 width/height（--otter-size），不产生 CLS；`pointer-events:none`。
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { OTTER_STATES, type PixelOtterSize, type PixelOtterState } from './otter-states'
import { pickSheetVariant } from './pixel-otter-sheets'
import './pixel-otter.css'

export interface PixelOtterProps {
  state: PixelOtterState
  size: PixelOtterSize
  /** 显式暂停（父层已淡出/不活动时用）；不可见（滚出视口 / document.hidden）由组件自己暂停 */
  paused?: boolean
  /** 原生 hover 提示（小尺寸用 "kyclaw"）；不进入可访问树（aria-hidden） */
  title?: string
  className?: string
}

/** prefers-reduced-motion（jsdom 没有 matchMedia：按 false 处理） */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => setReduced(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return reduced
}

/** 视口内 + 页面可见；不可见时暂停动画（省电，也符合「不可见就停」） */
function useInViewPause(): { ref: React.RefObject<HTMLSpanElement | null>; paused: boolean } {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [inView, setInView] = useState(true)
  const [pageVisible, setPageVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  )

  useEffect(() => {
    const sync = (): void => setPageVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  useEffect(() => {
    const node = ref.current
    if (node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry !== undefined) setInView(entry.isIntersecting)
      },
      { threshold: 0 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return { ref, paused: !inView || !pageVisible }
}

export function PixelOtter({
  state,
  size,
  paused = false,
  title,
  className
}: PixelOtterProps): React.JSX.Element {
  const spec = OTTER_STATES[state]
  const reduced = useReducedMotion()
  const { ref, paused: invisible } = useInViewPause()
  const sheet = pickSheetVariant(state, size)

  return (
    <span
      ref={ref}
      data-testid="pixel-otter"
      data-state={state}
      data-size={size}
      data-sheet-cell={sheet.cell}
      data-reduced={reduced ? 'true' : 'false'}
      data-paused={paused || invisible ? 'true' : 'false'}
      aria-hidden="true"
      title={title}
      className={cn('pixel-otter', className)}
      style={{ '--otter-size': `${size}px` } as React.CSSProperties}
    >
      <span
        className="pixel-otter-sheet pixel-otter-sheet--light"
        style={{ backgroundImage: `url("${sheet.light}")` }}
      />
      <span
        className="pixel-otter-sheet pixel-otter-sheet--dark"
        style={{ backgroundImage: `url("${sheet.dark}")` }}
      />
      {/* 数据属性让 CSS 知道帧数/帧时/是否循环（一种状态只有一档，见 otter-states.ts） */}
      <span
        hidden
        data-testid="pixel-otter-spec"
        data-frames={spec.frames}
        data-frame-ms={spec.frameMs}
        data-loop={spec.loop ? 'true' : 'false'}
        data-reduced-frame={spec.reducedFrame}
      />
    </span>
  )
}
