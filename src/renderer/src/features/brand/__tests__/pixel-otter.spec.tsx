import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PixelOtter } from '../PixelOtter'
import { OTTER_STATES, type PixelOtterSize, type PixelOtterState } from '../otter-states'
import { MASCOT_IDLE_FALLBACK_MS, useChatMascotState } from '../chat-mascot-state'
import { resetThreadRunStore, useThreadRunStore } from '@renderer/features/chat/thread-run-store'

/**
 * 像素海獭组件（task-41 / 设计稿 rev2）：
 *   - props：6 个状态 × 7 档尺寸；浅/深两层 sheet（主题跟 `data-theme`）；
 *   - 装饰性：aria-hidden + pointer-events:none；title 只做 hover 提示；
 *   - 不可见就停：IntersectionObserver / document.hidden → data-paused；
 *   - reduced-motion：读 matchMedia，静态帧（CSS 契约在 splash-asset.spec 里对文件断言）；
 *   - chat 状态灯：run-store（busy）+ 工具卡 DOM → idle/think/type，结束 1.2s 回 idle。
 */

const THREAD_ID = 't-otter'

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

describe('PixelOtter · 渲染契约', () => {
  it('6 个状态都渲染：data-state + manifest 的帧数/帧时/循环/reduced 帧', () => {
    const states: PixelOtterState[] = ['idle', 'loading', 'float', 'wave', 'think', 'type']

    for (const state of states) {
      const view = render(<PixelOtter state={state} size={24} />)
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

  it('尺寸写进 --otter-size（显式宽高，不产生 CLS）；24 是 header master 档', () => {
    const first = render(<PixelOtter state="idle" size={24} />)
    const otter = within(first.container).getByTestId('pixel-otter')
    expect(otter).toHaveAttribute('data-size', '24')
    expect(otter.style.getPropertyValue('--otter-size')).toBe('24px')
    first.unmount()

    const sizes: PixelOtterSize[] = [16, 32, 48, 64, 96, 128]
    for (const size of sizes) {
      const view = render(<PixelOtter state="float" size={size} />)
      expect(
        within(view.container).getByTestId('pixel-otter').style.getPropertyValue('--otter-size')
      ).toBe(`${size}px`)
      view.unmount()
    }
  })

  it('装饰性：aria-hidden；title 只做 hover 提示；浅/深两层 sheet 都在 DOM（CSS 按 data-theme 切）', () => {
    render(<PixelOtter state="idle" size={24} title="kyclaw" />)
    const otter = screen.getByTestId('pixel-otter')
    expect(otter).toHaveAttribute('aria-hidden', 'true')
    expect(otter).toHaveAttribute('title', 'kyclaw')
    expect(otter.querySelectorAll('.pixel-otter-sheet--light')).toHaveLength(1)
    expect(otter.querySelectorAll('.pixel-otter-sheet--dark')).toHaveLength(1)
    // 背景图来自 Vite 资产（sprite sheet），不是外链
    const light = otter.querySelector<HTMLElement>('.pixel-otter-sheet--light')
    expect(light?.style.backgroundImage).toContain('url(')
  })

  it('不可见就停：滚出视口 → data-paused=true，回到视口恢复', () => {
    const io = stubIntersectionObserver()
    render(<PixelOtter state="float" size={96} />)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-paused', 'false')

    io.trigger(false)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-paused', 'true')

    io.trigger(true)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-paused', 'false')
  })

  it('reduced-motion：读 matchMedia，标 data-reduced（CSS 停动画并停到 reducedFrame）', () => {
    stubMatchMedia(true)
    render(<PixelOtter state="think" size={32} />)
    expect(screen.getByTestId('pixel-otter')).toHaveAttribute('data-reduced', 'true')
  })

  it('显式 paused（父层离场）优先暂停，不重置状态', () => {
    render(<PixelOtter state="wave" size={128} paused />)
    const otter = screen.getByTestId('pixel-otter')
    expect(otter).toHaveAttribute('data-paused', 'true')
    expect(otter).toHaveAttribute('data-state', 'wave')
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
