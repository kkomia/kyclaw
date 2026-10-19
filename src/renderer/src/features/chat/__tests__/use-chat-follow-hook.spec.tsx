import { fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatFollow } from '../use-chat-follow'

/**
 * PB-044：轮末（running=false）不再启动弹簧跟随，改一次瞬时锚定。
 * 真机逐帧 diff 由 Eve 的 PB-041 探针采样；这里只钉 hook 行为。
 */
function Harness({ running, tail }: { running: boolean; tail: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useChatFollow({ viewRef: ref, tail, enabled: true, running })
  return <div ref={ref} data-testid="view" onScroll={follow.onScroll} />
}

/** jsdom 的 scrollHeight/clientHeight 是只读 0：按实例覆盖 */
function setMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PB-044 · 终态瞬时锚定（不启动弹簧）', () => {
  it('running=false 的 tail 突变：一次瞬时锚定、不新增 rAF；终态再变仍即时', () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { rerender, getByTestId } = render(<Harness running tail="a" />)
    const view = getByTestId('view')
    setMetrics(view, 1000, 400)

    // running=true：tail 变化走弹簧（会排一帧 rAF）
    rerender(<Harness running tail="b" />)
    const rafBeforeEnd = raf.mock.calls.length
    expect(rafBeforeEnd).toBeGreaterThan(0)

    // 终态：正文首次上屏（scrollHeight 1000 / clientHeight 400）→ 一次贴底，不排新 rAF
    rerender(<Harness running={false} tail="c" />)
    expect(view.scrollTop).toBe(600)
    expect(raf.mock.calls.length).toBe(rafBeforeEnd)

    // 终态再出现高度变化：仍即时贴底，不启动弹簧
    setMetrics(view, 1500, 400)
    rerender(<Harness running={false} tail="d" />)
    expect(view.scrollTop).toBe(1100)
    expect(raf.mock.calls.length).toBe(rafBeforeEnd)
  })

  it('用户上滑（reader-hold）后 running=false 不强制回底', () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { rerender, getByTestId } = render(<Harness running tail="a" />)
    const view = getByTestId('view')
    setMetrics(view, 1000, 400)
    view.scrollTop = 100
    fireEvent.scroll(view) // 离底 500px → sticky=false

    rerender(<Harness running={false} tail="b" />)
    expect(view.scrollTop).toBe(100)
  })
})
