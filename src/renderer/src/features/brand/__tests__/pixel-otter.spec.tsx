import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PixelOtter } from '../PixelOtter'
import { OTTER_STATES, type PixelOtterSize, type PixelOtterState } from '../otter-states'
import { MASCOT_IDLE_FALLBACK_MS, useChatMascotState } from '../chat-mascot-state'
import { resetThreadRunStore, useThreadRunStore } from '@renderer/features/chat/thread-run-store'

/**
 * 像素海獭 · 聊天状态灯（v4-pixel · 32 原生栅格，inline SVG sprite strip）：
 *   - props：3 个状态（idle/think/type）× 7 档尺寸（32 的整数倍）；浅/深由 --po-* 变量切；
 *   - 资产：3 个 self-contained SVG，每帧 32 用户单位；组件只内联 strip 层；
 *   - 装饰性：aria-hidden + pointer-events:none；title 只做 hover 提示；
 *   - 不可见就停：IntersectionObserver / document.hidden → data-paused（只暂停，不重置帧）；
 *   - reduced-motion / 父层 paused：定格在 OTTER_STATES[state].reducedFrame（静态可读态）；
 *   - chat 状态灯：run-store（busy）+ 工具卡 DOM → idle/think/type，结束 1.2s 回 idle。
 */

const THREAD_ID = 't-otter'

const CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/brand/pixel-otter.css'),
  'utf8'
)
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const ASSET = (state: string): string =>
  readFileSync(
    resolve(process.cwd(), `src/renderer/src/features/brand/otter-v4/chat-${state}.svg`),
    'utf8'
  )

/** matchMedia 替身（jsdom 没有）：reduced-motion 场景 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  )
}

/** IntersectionObserver 替身：记录回调，测试里手动喂"离开视口" */
function stubIntersectionObserver(): {
  trigger: (isIntersecting: boolean) => void
} {
  const callbacks: IntersectionObserverCallback[] = []
  class FakeIO {
    readonly callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
      callbacks.push(callback)
    }
    observe(): void {
      void 0 // 测试替身：不真正观察
    }
    unobserve(): void {
      void 0
    }
    disconnect(): void {
      void 0
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO)
  return {
    trigger(isIntersecting: boolean) {
      act(() => {
        for (const callback of callbacks) {
          callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
        }
      })
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetThreadRunStore()
})

describe('PixelOtter · 渲染契约（v4-pixel 32 栅格）', () => {
  it('3 个状态都渲染：data-state + 帧数/帧时/循环/reduced 帧与规格表一致', () => {
    const states: PixelOtterState[] = ['idle', 'think', 'type']

    for (const state of states) {
      const view = render(<PixelOtter state={state} size={32} />)
      const otter = screen.getByTestId('pixel-otter')
      expect(otter).toHaveAttribute('data-state', state)
      const spec = screen.getByTestId('pixel-otter-spec')
      const expected = OTTER_STATES[state]
      expect(spec).toHaveAttribute('data-frames', String(expected.frames))
      expect(spec).toHaveAttribute('data-frame-ms', String(expected.frameMs))
      expect(spec).toHaveAttribute('data-loop', expected.loop ? 'true' : 'false')
      expect(spec).toHaveAttribute('data-reduced-frame', String(expected.reducedFrame))
      view.unmount()
    }
  })

  it('尺寸写进 --otter-size（显式宽高，不产生 CLS）；32 原生栅格、允许 32 的整数倍', () => {
    const first = render(<PixelOtter state="idle" size={32} />)
    const otter = within(first.container).getByTestId('pixel-otter')
    expect(otter).toHaveAttribute('data-size', '32')
    expect(otter.style.getPropertyValue('--otter-size')).toBe('32px')
    // 输入卡状态灯 = 32 原生栅格的 1×（不是旧 32 sheet 的倍率）
    expect(otter).toHaveAttribute('data-sheet-cell', '32')
    first.unmount()

    const sizes: PixelOtterSize[] = [32, 64, 96, 128, 192, 256, 512]
    for (const size of sizes) {
      const view = render(<PixelOtter state="type" size={size} />)
      expect(
        within(view.container).getByTestId('pixel-otter').style.getPropertyValue('--otter-size')
      ).toBe(`${size}px`)
      view.unmount()
    }
  })

  it('inline SVG：32 viewBox、crispEdges、每状态 N 帧、只有 strip 一层（不是整张 sheet 上屏）', () => {
    for (const state of ['idle', 'think', 'type'] as const) {
      const view = render(<PixelOtter state={state} size={32} />)
      const otter = screen.getByTestId('pixel-otter')
      const svg = otter.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg).toHaveAttribute('viewBox', '0 0 32 32')
      expect(svg).toHaveAttribute('width', '32')
      expect(svg).toHaveAttribute('height', '32')
      expect(svg).toHaveAttribute('shape-rendering', 'crispEdges')
      // 真实 path 已内联（不是 img / 背景图 / 空壳）
      expect(otter.querySelectorAll('path').length).toBeGreaterThan(5)
      expect(otter.querySelector('img')).toBeNull()
      expect(otter.querySelector('image')).toBeNull()
      // 一屏一格：strip 里恰好 N 帧，x = 0 / 32 / 64 / 96 整数位移
      const frames = Array.from(svg?.querySelectorAll('g.pixel-otter-strip > g') ?? [])
      expect(frames).toHaveLength(OTTER_STATES[state].frames)
      expect(frames.map((frame) => frame.getAttribute('transform'))).toEqual(
        OTTER_STATES[state].frames === 3
          ? ['translate(0 0)', 'translate(32 0)', 'translate(64 0)']
          : ['translate(0 0)', 'translate(32 0)', 'translate(64 0)', 'translate(96 0)']
      )
      view.unmount()
    }
  })

  it('资产文件是 self-contained SVG：32 栅格、整数坐标、无 stroke/filter/位图/外链', () => {
    for (const state of ['idle', 'think', 'type'] as const) {
      const raw = ASSET(state)
      expect(raw).toContain('viewBox="0 0 32 32"')
      expect(raw).toContain('shape-rendering="crispEdges"')
      expect(raw).toContain('<g class="pixel-otter-strip">')
      expect((raw.match(/<g transform=/g) ?? []).length).toBe(OTTER_STATES[state].frames)
      // 像素几何：path 全是 M x y h w v1 h -w z 的行游程，没有 stroke / filter / image
      const d = raw.match(/ d="([^"]*)"/g) ?? []
      expect(d.length).toBeGreaterThan(0)
      for (const pathData of d) {
        expect(pathData).not.toMatch(/[0-9]\.[0-9]/) // 无小数坐标
        expect(pathData).toMatch(/^ d="(?:M\d+ \d+h\d+v1h-\d+z)+"$/)
      }
      expect(raw).not.toContain('<image')
      expect(raw).not.toContain('stroke=')
      expect(raw).not.toContain('<filter')
      // 无外链（xmlns 是唯一允许的 http 字符串）
      expect(raw).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
    }
  })

  it('装饰性：aria-hidden；title 只做 hover 提示；浅/深靠同一份 inline SVG 的变量（无 sheet 等待）', () => {
    render(<PixelOtter state="idle" size={32} title="kyclaw" />)
    const otter = screen.getByTestId('pixel-otter')
    expect(otter).toHaveAttribute('aria-hidden', 'true')
    expect(otter).toHaveAttribute('title', 'kyclaw')
    expect(otter.querySelectorAll('svg')).toHaveLength(1)
    expect(otter.querySelectorAll('img, image')).toHaveLength(0)
    expect(CSS).toContain('--po-page: #ffffff')
    expect(CSS).toContain(":root[data-theme='dark'] .pixel-otter")
    for (const token of ['--po-page', '--po-ink', '--po-fur', '--po-line', '--po-clay']) {
      expect(CSS, `深色缺 ${token}`).toContain(`${token}:`)
    }
  })

  it('不可见就停：滚出视口 → data-paused=true，回到视口恢复（不改 data-reduced）', () => {
    const io = stubIntersectionObserver()
    render(<PixelOtter state="think" size={32} />)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-paused', 'false')
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-reduced', 'false')

    io.trigger(false)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-paused', 'true')

    io.trigger(true)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-paused', 'false')
  })

  it('reduced-motion：读 matchMedia，标 data-reduced（CSS 定格在 reducedFrame，不隐藏）', () => {
    stubMatchMedia(true)
    render(<PixelOtter state="think" size={32} />)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-reduced', 'true')
  })

  it('显式 paused（壳层「减弱」/父层离场）→ data-paused + 静态帧，不重置状态', () => {
    render(<PixelOtter state="type" size={32} paused />)
    const otter = screen.getByTestId('pixel-otter')
    expect(otter).toHaveAttribute('data-paused', 'true')
    expect(otter).toHaveAttribute('data-reduced', 'true')
    expect(otter).toHaveAttribute('data-state', 'type')
  })
})

describe('pixel-otter.css · 动效契约（离散帧 / 整数位移 / 静态 reduced）', () => {
  it('三态各自的 steps 动画 + 关键帧；整数 32 用户单位位移', () => {
    expect(CSS).toMatch(
      /\[data-state='idle'\][\s\S]*?--po-anim: pixel-otter-idle 4s steps\(1, end\) infinite/
    )
    expect(CSS).toMatch(
      /\[data-state='think'\][\s\S]*?--po-anim: pixel-otter-frames-4 480ms steps\(4\) infinite/
    )
    expect(CSS).toMatch(
      /\[data-state='type'\][\s\S]*?--po-anim: pixel-otter-frames-4 360ms steps\(4\) infinite/
    )
    expect(CSS).toContain('@keyframes pixel-otter-idle')
    expect(CSS).toContain('@keyframes pixel-otter-frames-4')
    expect(CSS).toContain('translateX(-32px)')
    expect(CSS).toContain('translateX(-64px)')
    expect(CSS).toContain('translateX(-128px)')
    // 像素图不插值：没有线性/缓动 timing function
    expect(CSS_CODE).not.toMatch(/animation:.*\b(ease|linear|cubic-bezier)\b/)
  })

  it('一屏一格：SVG viewBox 32 + overflow hidden；不再用 background-position sheet 机制', () => {
    expect(CSS).toMatch(/\.pixel-otter svg \{[\s\S]*?overflow: hidden;/)
    expect(CSS).not.toContain('background-position')
    expect(CSS).not.toContain('.pixel-otter-sheet')
    expect(CSS).not.toContain('image-rendering')
  })

  it('不可见暂停：data-paused 用 animation-play-state（不重置帧）；reduced 用静态 transform', () => {
    expect(CSS).toMatch(
      /\.pixel-otter\[data-paused='true'\] \.pixel-otter-strip \{\s*animation-play-state: paused;/
    )
    expect(CSS).toMatch(
      /\.pixel-otter\[data-reduced='true'\] \.pixel-otter-strip \{\s*animation: none !important;[\s\S]*?transform: translateX\(var\(--po-reduced-x, 0px\)\)/
    )
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pixel-otter \.pixel-otter-strip \{\s*animation: none !important;[\s\S]*?transform: translateX\(var\(--po-reduced-x, 0px\)\)/
    )
    // reduced 静态帧：idle 帧 A / think 帧 C / type 帧 D（-64px / -96px）
    expect(CSS).toMatch(/\[data-state='think'\][\s\S]*?--po-reduced-x: -64px/)
    expect(CSS).toMatch(/\[data-state='type'\][\s\S]*?--po-reduced-x: -96px/)
  })

  it('装饰性：pointer-events:none（不挡输入区/发送钮），尺寸只吃 --otter-size', () => {
    expect(CSS).toMatch(/\.pixel-otter \{[\s\S]*?pointer-events: none;/)
    expect(CSS).toContain('width: var(--otter-size)')
    expect(CSS).toContain('height: var(--otter-size)')
    expect(CSS).not.toMatch(/font-size:\s*.*em/)
    expect(CSS_CODE).not.toMatch(/transform:\s*scale/)
  })
})

/** 小壳：把 hook 的返回值直接画出来，测状态映射而不依赖 ChatHeader 布局 */
function MascotProbe(): React.JSX.Element {
  const state = useChatMascotState(THREAD_ID)
  return <div data-testid="mascot-state">{state}</div>
}

describe('chat 状态灯 · 映射（idle / think / type + 1.2s 回落）', () => {
  beforeEach(() => {
    resetThreadRunStore()
  })

  it('空闲 → idle；run-store 在跑 → think；工具卡 input-available → type', async () => {
    render(<MascotProbe />)
    expect(screen.getByTestId('mascot-state')).toHaveTextContent('idle')

    act(() => {
      useThreadRunStore.getState().setRunning(THREAD_ID, true)
    })
    await vi.waitFor(() => expect(screen.getByTestId('mascot-state')).toHaveTextContent('think'))

    // 工具卡在跑（ToolCard 的既有 DOM 契约）：think → type
    const card = document.createElement('div')
    card.setAttribute('data-testid', 'tool-card')
    card.setAttribute('data-state', 'input-available')
    act(() => {
      document.body.appendChild(card)
    })
    await vi.waitFor(() => expect(screen.getByTestId('mascot-state')).toHaveTextContent('type'))

    // 工具结束（回到 think），本轮也结束 → 1.2s 后才回 idle
    card.remove()
    await vi.waitFor(() => expect(screen.getByTestId('mascot-state')).toHaveTextContent('think'))
    act(() => {
      useThreadRunStore.getState().setRunning(THREAD_ID, false)
    })
    expect(screen.getByTestId('mascot-state')).toHaveTextContent('think')
    await vi.waitFor(() => expect(screen.getByTestId('mascot-state')).toHaveTextContent('idle'), {
      timeout: MASCOT_IDLE_FALLBACK_MS + 800
    })
  })

  it('等待用户处理（审批卡）时显示 think，不显示 type', async () => {
    const approval = document.createElement('div')
    approval.setAttribute('data-testid', 'approval-card')
    document.body.appendChild(approval)
    try {
      render(<MascotProbe />)
      act(() => {
        useThreadRunStore.getState().setRunning(THREAD_ID, true)
      })
      await vi.waitFor(() => expect(screen.getByTestId('mascot-state')).toHaveTextContent('think'))
      // 审批卡优先级高于工具卡：即使有在跑的工具卡也按"等用户"算 think
      const card = document.createElement('div')
      card.setAttribute('data-testid', 'tool-card')
      card.setAttribute('data-state', 'input-available')
      document.body.appendChild(card)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(screen.getByTestId('mascot-state')).toHaveTextContent('think')
      card.remove()
    } finally {
      approval.remove()
    }
  })
})
