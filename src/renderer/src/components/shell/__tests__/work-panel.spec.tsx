import { fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { WorkPanel, type WorkPanelProps } from '../WorkPanel'

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
function panelElement(props: Partial<WorkPanelProps> = {}): React.JSX.Element {
  return (
    <WorkPanel
      open={props.open ?? true}
      fullscreen={props.fullscreen}
      spaceConstrained={props.spaceConstrained}
      width={props.width ?? 400}
      onWidthChange={props.onWidthChange}
    />
  )
}

function renderPanel(
  props: Partial<Pick<WorkPanelProps, 'open' | 'fullscreen' | 'spaceConstrained' | 'width'>> = {}
): { onWidthChange: Mock<(width: number) => void> } & RenderResult {
  const onWidthChange = vi.fn<(width: number) => void>()
  const view = render(panelElement({ ...props, onWidthChange }))
  return { onWidthChange, ...view }
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

  it('全屏：占满内容区（flex-1，落在卡内侧栏右边），不再走宽度 token', () => {
    renderPanel({ fullscreen: true, width: 520 })

    const panel = screen.getByTestId('work-panel')
    expect(panel).toHaveAttribute('data-fullscreen', 'true')
    expect(panel).toHaveClass('is-open', 'flex-1')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
    // 2026-10-17 会话侧栏进卡、成为 panel 的 flex 兄弟：round 59 的可见左缘偏移全档退休，
    // 全屏只需 flex-1；过渡属性表里也不再有 margin-left（只过渡宽度）。
    expect(panel).not.toHaveClass('ml-(--content-safe-left)')
    expect(panel.className).toContain('transition-[width]')
    expect(panel.className).not.toContain('margin-left')
  })

  it('非全屏 docked：在右缘，不拿左缘偏移', () => {
    renderPanel({ width: 520 })

    expect(screen.getByTestId('work-panel')).not.toHaveClass('ml-(--content-safe-left)')
  })

  it('round 77：全屏的两种来源标出来（用户偏好 user / 空间不足的临时铺满 auto / 没全屏 none）', () => {
    const docked = renderPanel({ fullscreen: false, spaceConstrained: false })
    expect(screen.getByTestId('work-panel')).toHaveAttribute('data-fullscreen-source', 'none')

    docked.unmount()
    const user = renderPanel({ fullscreen: true, spaceConstrained: false })
    expect(screen.getByTestId('work-panel')).toHaveAttribute('data-fullscreen-source', 'user')

    user.unmount()
    renderPanel({ fullscreen: true, spaceConstrained: true })
    const panel = screen.getByTestId('work-panel')
    expect(panel).toHaveAttribute('data-fullscreen-source', 'auto')
    // 铺满的摆法与用户全屏完全同构（探针只需看布局，不必管来源）
    expect(panel).toHaveClass('is-open', 'flex-1')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
  })
})

/**
 * round 79（实机边界，agent18 报）：拖到越界 → 转 auto（把手从 DOM 里拿掉）时指针捕获跟着消失，
 * pointerup 落不到已卸载的节点上 → `dragging` 残留：面板永远 `transition-none`、线永远强调蓝。
 * 判据：拖动中途把手没了就必须收尾，收尾后的状态要跟"从没拖过"一样。
 */
describe('WorkPanel 拖拽收尾（round 79：把手在拖动中途被拿掉）', () => {
  it('拖到越界转 auto：过渡与强调线都收掉，恢复并排后还能正常拖', () => {
    const view = renderPanel({ width: 400 })
    const onWidthChange = view.onWidthChange

    fireEvent.pointerDown(screen.getByTestId('work-panel-resizer'), {
      button: 0,
      pointerId: 1,
      clientX: 800
    })
    expect(screen.getByTestId('work-panel')).toHaveClass('transition-none')

    // 越界 → auto（AppShell 把 fullscreen 传进来）：把手这一刻从 DOM 里消失
    view.rerender(
      panelElement({ open: true, fullscreen: true, spaceConstrained: true, onWidthChange })
    )
    expect(screen.queryByTestId('work-panel-resizer')).not.toBeInTheDocument()
    expect(screen.getByTestId('work-panel')).not.toHaveClass('transition-none')

    // 指针随后在别处松开（落不到已卸载的手柄上）：不该再改宽度
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100 })
    expect(onWidthChange).not.toHaveBeenCalled()

    // 恢复并排：新挂载的把手不带拖动高亮，面板也没留着 transition-none
    view.rerender(panelElement({ open: true, width: 400, onWidthChange }))
    const panel = screen.getByTestId('work-panel')
    const line = screen.getByTestId('work-panel-resizer').querySelector('span[aria-hidden="true"]')
    expect(panel).not.toHaveClass('transition-none')
    expect(line).toHaveClass('bg-transparent')
    expect(line).not.toHaveClass('bg-accent')

    // 收尾没收坏：之后照常拖
    drag(screen.getByTestId('work-panel-resizer'), 800, 700)
    expect(onWidthChange).toHaveBeenCalledWith(500)
  })

  it('拖动中收面板（open=false，把手同样被拿掉）也收尾', () => {
    const view = renderPanel({ open: true })
    fireEvent.pointerDown(screen.getByTestId('work-panel-resizer'), {
      button: 0,
      pointerId: 1,
      clientX: 800
    })
    expect(screen.getByTestId('work-panel')).toHaveClass('transition-none')

    view.rerender(panelElement({ open: false, onWidthChange: view.onWidthChange }))

    expect(screen.getByTestId('work-panel')).not.toHaveClass('transition-none')
    expect(screen.getByTestId('work-panel')).toHaveClass('w-0')
  })

  it('指针在窗口任意处松开/取消/丢失捕获都算收尾（不再依赖手柄那 6px 命中区）', () => {
    const cases: Array<() => void> = [
      () => fireEvent.pointerUp(window, { pointerId: 1, clientX: 700 }),
      () => fireEvent.pointerCancel(window, { pointerId: 1 }),
      () => fireEvent.lostPointerCapture(window, { pointerId: 1 })
    ]

    for (const end of cases) {
      const { onWidthChange, unmount } = renderPanel()
      fireEvent.pointerDown(screen.getByTestId('work-panel-resizer'), {
        button: 0,
        pointerId: 1,
        clientX: 800
      })
      expect(screen.getByTestId('work-panel')).toHaveClass('transition-none')

      end()

      expect(screen.getByTestId('work-panel')).not.toHaveClass('transition-none')
      // 收尾之后指针再动也不再改宽度
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 100 })
      expect(onWidthChange).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('别的指针动不影响当前拖动（多指同按不误伤）', () => {
    const { onWidthChange } = renderPanel({ width: 400 })
    drag(screen.getByTestId('work-panel-resizer'), 800, 700)
    expect(onWidthChange).toHaveBeenCalledTimes(1)

    // 换一个 pointerId 按下：这次拖动归它，前一次的 pointerId 事件不再改宽度
    fireEvent.pointerDown(screen.getByTestId('work-panel-resizer'), {
      button: 0,
      pointerId: 2,
      clientX: 800
    })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 })
    expect(onWidthChange).toHaveBeenCalledTimes(1)

    fireEvent.pointerMove(window, { pointerId: 2, clientX: 700 })
    expect(onWidthChange).toHaveBeenLastCalledWith(500)
  })
})
