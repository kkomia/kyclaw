import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OtterMark } from '../OtterMark'

/**
 * task-96 · OtterMark（v4-pixel 守页海獭 inline SVG）契约。
 *
 * 关键约束（不放松）：
 *   - inline SVG（不是 <img>/背景图）→ 首帧立即有形状，没有 sheet 换载空窗；
 *   - 尺寸只允许整数档 32/96/128，显式 px，不用 em / transform: scale → 不随 --ui-scale 缩放；
 *   - 动效 3 帧 sprite strip + steps(1,end)；reduced-motion / data-motion='reduced' → 静态帧；
 *   - 浅/深由 :root[data-theme='dark'] 下的 --om-* 变量同帧切；aria-hidden 装饰位；
 *   - 一屏一只：互斥在 TitleBar/各落点的**条件渲染**里，不在 OtterMark CSS 里。
 */
const CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/brand/otter-mark.css'),
  'utf8'
)
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const ANIMATED = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/brand/otter-v4/otter-animated.svg'),
  'utf8'
)
const STATIC = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/brand/otter-v4/otter-static.svg'),
  'utf8'
)

describe('OtterMark · inline SVG 与尺寸', () => {
  it('32/96/128 三档：显式 px（--otter-mark-size），SVG 内联且带 48 栅格 path', () => {
    for (const size of [32, 96, 128] as const) {
      const view = render(<OtterMark size={size} />)
      const mark = screen.getByTestId('otter-mark')
      expect(mark).toHaveAttribute('data-size', String(size))
      expect(mark.style.getPropertyValue('--otter-mark-size')).toBe(`${size}px`)
      const svg = mark.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg).toHaveAttribute('viewBox', '0 0 48 48')
      expect(svg).toHaveAttribute('width', String(size))
      expect(svg).toHaveAttribute('height', String(size))
      expect(svg).toHaveAttribute('shape-rendering', 'crispEdges')
      // 真实 path 已经内联（不是 img/src，也不是空壳）
      expect(mark.querySelectorAll('path').length).toBeGreaterThan(10)
      expect(mark.querySelector('img')).toBeNull()
      expect(mark.querySelector('image')).toBeNull()
      view.unmount()
    }
  })

  it('尺寸/缩放纪律：CSS 里没有 em/transform: scale；宽度只吃 --otter-mark-size', () => {
    expect(CSS).toContain('width: var(--otter-mark-size)')
    expect(CSS).toContain('height: var(--otter-mark-size)')
    expect(CSS_CODE).not.toMatch(/font-size:\s*.*em/)
    expect(CSS_CODE).not.toMatch(/transform:\s*scale/)
  })

  it('animated / static 两个变体；static 只有 1 帧，animated 有 3 帧 sprite', () => {
    const animated = render(<OtterMark size={96} variant="animated" />)
    expect(animated.getByTestId('otter-mark')).toHaveAttribute('data-variant', 'animated')
    // 3 帧 = 3 个 <g transform="translate(...)">
    expect(animated.container.querySelectorAll('g.otter-strip > g').length).toBe(3)
    animated.unmount()

    const staticFrame = render(<OtterMark size={32} variant="static" />)
    expect(staticFrame.getByTestId('otter-mark')).toHaveAttribute('data-variant', 'static')
    expect(staticFrame.container.querySelectorAll('g.otter-strip > g').length).toBe(1)
    staticFrame.unmount()
  })

  it('装饰位：aria-hidden、pointer-events:none、不接收焦点；title 只给原生 hover', () => {
    render(<OtterMark size={32} title="kyclaw" />)
    const mark = screen.getByTestId('otter-mark')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).toHaveAttribute('title', 'kyclaw')
    expect(mark.querySelector('svg')).toHaveAttribute('focusable', 'false')
    expect(CSS).toContain('pointer-events: none')
  })
})

describe('OtterMark · 动效与 reduced', () => {
  it('animated 用 4s steps(1,end) sprite 位移；三个整数帧位 -48px / -96px', () => {
    expect(CSS).toMatch(/animation: otter-mark-frames 4s steps\(1, end\) infinite/)
    expect(CSS).toContain('@keyframes otter-mark-frames')
    expect(CSS).toContain('translateX(-48px)')
    expect(CSS).toContain('translateX(-96px)')
    // 原始设计资产仍是 3 帧 strip（48 一帧）
    expect((ANIMATED.match(/<g transform=/g) ?? []).length).toBe(3)
    expect((STATIC.match(/<g transform=/g) ?? []).length).toBe(1)
  })

  it('reduced-motion 直接静态：animation:none；data-motion=reduced 同样静止', () => {
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important/
    )
    expect(CSS).toContain("[data-motion='reduced']")
    const view = render(<OtterMark size={96} motion="reduced" />)
    expect(view.getByTestId('otter-mark')).toHaveAttribute('data-motion', 'reduced')
    view.unmount()
  })

  it('paused 只改 animation-play-state（不重置帧）', () => {
    expect(CSS).toMatch(
      /\[data-paused='true'\] \.otter-strip \{[\s\S]*?animation-play-state: paused/
    )
    const view = render(<OtterMark size={96} paused />)
    expect(view.getByTestId('otter-mark')).toHaveAttribute('data-paused', 'true')
    view.unmount()
  })
})

describe('OtterMark · 浅深变量（深色首帧不空窗）', () => {
  it('浅色默认变量 + :root[data-theme=dark] 整段覆盖（同一份 inline SVG，无图片请求）', () => {
    expect(CSS).toMatch(/\.otter-mark \{[\s\S]*?--om-page: #ffffff/)
    expect(CSS).toContain(":root[data-theme='dark'] .otter-mark")
    for (const token of ['--om-page', '--om-ink', '--om-fur', '--om-line', '--om-clay']) {
      expect(CSS, `深色缺 ${token}`).toContain(`${token}:`)
    }
    // SVG 组件本身只有一个 <svg>（没有浅/深两张图等待加载）
    render(<OtterMark size={96} />)
    const mark = screen.getByTestId('otter-mark')
    expect(mark.querySelectorAll('svg')).toHaveLength(1)
    expect(mark.querySelectorAll('img, image')).toHaveLength(0)
  })
})

describe('一屏一只：靠挂载条件而不是 CSS 隐藏', () => {
  it('OtterMark 自身不写 :has/display:none 的互斥规则（互斥在 TitleBar/各落点条件渲染）', () => {
    expect(CSS).not.toContain(':has(')
    expect(CSS).not.toMatch(/display:\s*none/)
  })
})
