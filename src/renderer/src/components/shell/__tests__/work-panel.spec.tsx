import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkPanel } from '../WorkPanel'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 右栏面板本体（round 39）：宽度来自 props（AppShell 从 shell-store 给），
 * 左缘把手负责拖拽调宽 —— 这里验拖动换算与夹取、双击复位、拖动期间关过渡、全屏让位。
 *
 * jsdom 里没有真实布局：容器宽（内容区）默认读出来是 0，所以按"容器宽未知"只夹 280–760；
 * 70% 这一层的换算在下面有一个把内容区宽度摆出来的用例，纯函数口径见 `shell-store.spec.ts`。
 */
function renderPanel(props: Partial<{ open: boolean; fullscreen: boolean; width: number }> = {}): {
  onWidthChange: ReturnType<typeof vi.fn>
  container: HTMLElement
  unmount: () => void
} {
  const onWidthChange = vi.fn()
  const view = render(
    <WorkPanel
      open={props.open ?? true}
      fullscreen={props.fullscreen}
      width={props.width ?? 400}
      onWidthChange={onWidthChange}
    />
  )
  return { onWidthChange, container: view.container, unmount: view.unmount }
}

function drag(handle: HTMLElement, from: number, to: number): void {
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: from })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: to })
}

describe('WorkPanel 拖拽调宽', () => {
  it('展开时左缘有把手（6px 命中区、col-resize、可访问名），收起/全屏时没有', () => {
    const expanded = renderPanel()
    const handle = screen.getByTestId('work-panel-resizer')
    expect(handle).toHaveClass('w-1.5', 'cursor-col-resize')
    expect(handle).toHaveAccessibleName('调整工作台宽度')
    expect(handle).toHaveAttribute('role', 'separator')

    expanded.unmount()
    const collapsed = renderPanel({ open: false })
    expect(screen.queryByTestId('work-panel-resizer')).not.toBeInTheDocument()

    collapsed.unmount()
    renderPanel({ fullscreen: true })
    expect(screen.queryByTestId('work-panel-resizer')).not.toBeInTheDocument()
  })

  it('往左拖 = 变宽（宽度 prop 落成内联 token，内外层同值）', () => {
    const { onWidthChange } = renderPanel({ width: 400 })

    drag(screen.getByTestId('work-panel-resizer'), 800, 700)

    expect(onWidthChange).toHaveBeenCalledWith(500)
    const panel = screen.getByTestId('work-panel')
    expect(panel).toHaveStyle('--work-panel-width: 400px')
  })

  it('拖动夹取 280–760；拖动期间关掉宽度过渡，松手恢复', () => {
    const { onWidthChange } = renderPanel()
    const handle = screen.getByTestId('work-panel-resizer')
    const panel = screen.getByTestId('work-panel')

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 800 })
    expect(panel).toHaveClass('transition-none')
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -200 }) // 往左拉到底
    expect(onWidthChange).toHaveBeenLastCalledWith(760)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1400 }) // 往右推到底
    expect(onWidthChange).toHaveBeenLastCalledWith(280)
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 1400 })
    expect(panel).not.toHaveClass('transition-none')

    // 松手之后的移动不再改宽度（指针已经松开）
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 })
    expect(onWidthChange).toHaveBeenLastCalledWith(280)
    expect(onWidthChange).toHaveBeenCalledTimes(2)
  })

  it('双击把手复位默认 400', () => {
    const { onWidthChange } = renderPanel({ width: 620 })

    fireEvent.doubleClick(screen.getByTestId('work-panel-resizer'))

    expect(onWidthChange).toHaveBeenCalledWith(400)
  })

  it('上限按内容区（父容器）实测宽算：600 宽的内容区里拖不出 420 以上', () => {
    const view = renderPanel({ width: 400 })
    // jsdom 没有布局：直接把内容区宽度摆出来（真机上这里是 getBoundingClientRect 量的）
    Object.defineProperty(view.container, 'clientWidth', { configurable: true, value: 600 })

    drag(screen.getByTestId('work-panel-resizer'), 800, 100)

    expect(view.onWidthChange).toHaveBeenCalledWith(420)
  })

  it('窗口变窄：内容区尺寸变化时把过宽的宽度收回来（拖动中不动）', () => {
    const callbacks: ResizeObserverCallback[] = []
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }
      observe(): void {
        /* 只收集回调 */
      }
      disconnect(): void {
        /* noop */
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    const view = renderPanel({ width: 760 })
    Object.defineProperty(view.container, 'clientWidth', { configurable: true, value: 600 })

    expect(callbacks).toHaveLength(1)
    callbacks[0]?.([], {} as ResizeObserver)
    expect(view.onWidthChange).toHaveBeenCalledWith(420)

    // 拖动中收到容器回调不跟手打架
    const handle = screen.getByTestId('work-panel-resizer')
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 800 })
    view.onWidthChange.mockClear()
    callbacks[0]?.([], {} as ResizeObserver)
    expect(view.onWidthChange).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('展开态：宽度写进 --work-panel-width，收起态占宽 0（内容层不重排）', () => {
    const view = renderPanel({ width: 520 })
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open', 'w-(--work-panel-width)')
    expect(screen.getByTestId('work-panel')).toHaveStyle('--work-panel-width: 520px')

    view.unmount()
    renderPanel({ open: false, width: 520 })
    expect(screen.getByTestId('work-panel')).toHaveClass('w-0')
    expect(screen.getByTestId('work-panel')).not.toHaveClass('is-open')
  })

  it('全屏：占满内容区（flex-1），不再走宽度 token', () => {
    renderPanel({ fullscreen: true, width: 520 })

    const panel = screen.getByTestId('work-panel')
    expect(panel).toHaveAttribute('data-fullscreen', 'true')
    expect(panel).toHaveClass('is-open', 'flex-1')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
  })
})
