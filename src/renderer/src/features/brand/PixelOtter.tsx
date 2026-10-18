/**
 * 像素海獭 · 聊天输入卡右上角的状态灯（brand mark，不是助手人格）。
 *
 * 2026-10-18「同步 v4-pixel」：本组件从 v5 时代的 **32×32 旧 sprite sheet + CSS background**
 * 换成 **v4-pixel 设计语言的 inline SVG sprite strip**（与 `OtterMark` 同一套做法）：
 *   - 资产：`./otter-v4/chat-{idle,think,type}.svg`（32 原生栅格，3/4 帧、1 px 墨描边、
 *     圆头/小圆耳/奶油口鼻/深鼻/一页纸 + 折角 + 两行灰字 + 陶土光标、无手）；设计源在
 *     `.superpowers/brand/otter-v4-pixel/chat-states/`。
 *   - 只抽 `<g class="pixel-otter-strip">` 内联，调色板/动效留在 `pixel-otter.css`：
 *     浅/深由 `:root[data-theme='dark']` 下的 `--po-*` 变量同帧切换（没有 sheet 换载空窗）。
 *   - **32 原生 = 1×**：输入卡落位 32 px（`Composer.tsx` 不改），DPR 1/2/3 都是整数倍设备像素；
 *     其它 32 的整数倍尺寸直接放大，`shape-rendering="crispEdges"` 保证硬边。
 *   - 动效：离散 steps（`translateX(-32px × n)`），reduced-motion 或 `paused` 定格在
 *     `OTTER_STATES[state].reducedFrame`（静态帧也读得出状态）；不可见（滚出视口 / 页面隐藏）
 *     只暂停 `animation-play-state`，不重置帧。
 *   - 装饰性：`aria-hidden` + `pointer-events:none`；title 只做原生 hover 提示。
 *
 * 对外契约（Composer / chat 测试依赖，勿改）：props state/size/paused/title/className；
 * data-testid `pixel-otter`；data-state / data-size / data-sheet-cell / data-reduced /
 * data-paused；隐藏规格 `pixel-otter-spec` 的 data-frames / data-frame-ms / data-loop /
 * data-reduced-frame。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { OTTER_STATES, type PixelOtterSize, type PixelOtterState } from './otter-states'
import idleRaw from './otter-v4/chat-idle.svg?raw'
import thinkRaw from './otter-v4/chat-think.svg?raw'
import typeRaw from './otter-v4/chat-type.svg?raw'
import './pixel-otter.css'

export interface PixelOtterProps {
  state: PixelOtterState
  size: PixelOtterSize
  /** 显式暂停（父层已淡出 / 不活动 / 壳层「减弱」）；定格在 reducedFrame */
  paused?: boolean
  /** 原生 hover 提示（小尺寸用 "kyclaw"）；不进入可访问树（aria-hidden） */
  title?: string
  className?: string
}

/** 32 原生栅格（见 otter-states.ts 的说明） */
const GRID = 32

/** 从设计文件里抽出 strip 层（`<g class="pixel-otter-strip">…</g>`），保持类名不变 */
function stripInnerOf(raw: string): string {
  const start = raw.indexOf('<g class="pixel-otter-strip">')
  const end = raw.lastIndexOf('</g>')
  if (start < 0 || end < start) throw new Error('PixelOtter：SVG 资产里找不到 pixel-otter-strip 层')
  return raw.slice(start, end + 4)
}

const INNER = {
  idle: stripInnerOf(idleRaw),
  think: stripInnerOf(thinkRaw),
  type: stripInnerOf(typeRaw)
} as const

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
  const inner = useMemo(() => INNER[state], [state])
  // paused（父层「减弱」/离场）与系统 reduced-motion 都定格静态帧；不可见只暂停播放
  const still = reduced || paused

  return (
    <span
      ref={ref}
      data-testid="pixel-otter"
      data-state={state}
      data-size={size}
      data-sheet-cell={GRID}
      data-reduced={still ? 'true' : 'false'}
      data-paused={paused || invisible ? 'true' : 'false'}
      aria-hidden="true"
      title={title}
      className={cn('pixel-otter', className)}
      style={{ '--otter-size': `${size}px` } as CSSProperties}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${GRID} ${GRID}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        focusable="false"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: inner }}
      />
      {/* 数据属性让 CSS 知道帧数/帧时/是否循环（值来自 otter-states.ts） */}
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
