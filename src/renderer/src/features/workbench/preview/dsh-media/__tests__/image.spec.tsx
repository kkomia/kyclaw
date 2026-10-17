import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DshImageBody } from '../image-body'

/** 渲染一份图片字节，拿回根元素与里面的 `<img>`（此时还没"解码完成"）。 */
function mount(format: Parameters<typeof DshImageBody>[0]['format'] = 'image-png'): {
  root: HTMLElement
  image: HTMLImageElement
  unmount: () => void
} {
  const rendered = render(<DshImageBody format={format} bytes={new Uint8Array([1, 2, 3])} />)
  const root = screen.getByTestId('file-preview-image')
  const image = root.querySelector('img') as HTMLImageElement
  return { root, image, unmount: rendered.unmount }
}

/** jsdom 不真解码：显式铺"原始像素尺寸"再触发 load。 */
function decode(image: HTMLImageElement, w = 1000, h = 400): void {
  Object.defineProperty(image, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: h, configurable: true })
  fireEvent.load(image)
}

/**
 * jsdom 量不到任何布局：把滚动口的视口尺寸钉住再渲染（contain 的口径要吃宽 **和** 高）。
 * 只在这一层动原型上的两个 getter，跑完就删掉 —— 不 mock 任何产品逻辑。
 */
function withViewport(
  size: { readonly width: number; readonly height: number },
  run: () => void
): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => size.width
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => size.height
  })
  try {
    run()
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  }
}

/**
 * 拖拽平移要量滚动口：jsdom 没有布局，把 client / scroll 尺寸钉在原型上（跑完删掉）。
 * 只动这四个只读尺寸，不改产品逻辑；`scrollLeft/Top` 在用例里对具体节点另钉。
 */
function withPanMetrics(
  metrics: {
    readonly width: number
    readonly height: number
    readonly scrollWidth: number
    readonly scrollHeight: number
  },
  run: () => void
): void {
  const values = {
    clientWidth: metrics.width,
    clientHeight: metrics.height,
    scrollWidth: metrics.scrollWidth,
    scrollHeight: metrics.scrollHeight
  }
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => values[key]
    })
  }
  try {
    run()
  } finally {
    for (const key of Object.keys(values)) Reflect.deleteProperty(HTMLElement.prototype, key)
  }
}

/** jsdom 没有 ResizeObserver：只提供 observe/disconnect 与一个手动 emit 的入口。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  private readonly handler: ResizeObserverCallback

  constructor(handler: ResizeObserverCallback) {
    this.handler = handler
    FakeResizeObserver.instances.push(this)
  }

  observe(): void {
    void 0
  }

  unobserve(): void {
    void 0
  }

  disconnect(): void {
    void 0
  }

  emit(): void {
    this.handler([], this as unknown as ResizeObserver)
  }
}

/**
 * 在 `withPanMetrics` 里铺一张"两个方向都装不下"的图，并给滚动位置装上可观测的替身。
 * 产品代码只读写标准属性；这里不 mock 任何 handler。
 */
function setupPannable(): {
  image: HTMLImageElement
  port: HTMLElement
  scroll: { left: number; top: number }
  unmount: () => void
} {
  const { image, unmount } = mount('image-jpeg')
  decode(image, 1000, 400)
  const frame = screen.getByTestId('dsh-zoom-frame')
  const port = frame.querySelector('[data-dsh-zoom-scrollport]') as HTMLElement
  const scroll = { left: 0, top: 0 }
  Object.defineProperty(port, 'scrollLeft', {
    configurable: true,
    get: () => scroll.left,
    set: (value: number) => {
      scroll.left = value
    }
  })
  Object.defineProperty(port, 'scrollTop', {
    configurable: true,
    get: () => scroll.top,
    set: (value: number) => {
      scroll.top = value
    }
  })
  return { image, port, scroll, unmount }
}

/** 在图片中心按下鼠标左键（拖拽平移的起手）。 */
function beginPan(image: HTMLImageElement): void {
  fireEvent.pointerDown(image, {
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    pointerId: 1,
    clientX: 200,
    clientY: 150
  })
}

describe('DshImageBody：格式与 data URL', () => {
  it('svg / ico 也编成 data URL，MIME 分别是 svg+xml 与 x-icon（CSP 只放行 img-src data:）', () => {
    const svg = render(<DshImageBody format="image-svg" bytes={new Uint8Array([1, 2, 3])} />)
    const svgImage = svg.container.querySelector('img') as HTMLImageElement
    expect(svgImage.getAttribute('src')).toBe('data:image/svg+xml;base64,AQID')
    svg.unmount()

    const ico = render(<DshImageBody format="image-ico" bytes={new Uint8Array([1, 2, 3])} />)
    const icoImage = ico.container.querySelector('img') as HTMLImageElement
    expect(icoImage.getAttribute('src')).toBe('data:image/x-icon;base64,AQID')
  })

  it('SVG 标记不进 DOM：img 里只有 data URL，没有 <svg>/<script> 元素', () => {
    const { root } = mount('image-svg')
    expect(root.querySelector('svg')).toBeNull()
    expect(root.querySelector('script')).toBeNull()
  })
})

describe('DshImageBody：解码与回退', () => {
  it('解码完 → data-loaded=true、挂出统一缩放控件、百分比 100%（jsdom 量不到视口宽）', () => {
    const { root, image } = mount()
    expect(root).toHaveAttribute('data-loaded', 'false')
    expect(screen.queryByTestId('dsh-zoom-controls')).toBeNull()

    decode(image)
    expect(root).toHaveAttribute('data-loaded', 'true')
    expect(screen.getByTestId('image-frame')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')
  })

  it('坏图（onError）给人话，不空白', () => {
    const { image } = mount()
    fireEvent.error(image)
    expect(screen.getByTestId('file-preview-image-error')).toHaveTextContent('打不开')
  })

  it('量不出内在尺寸的 SVG 不判坏图：原始尺寸铺开、不给缩放控件', () => {
    const { root, image } = mount('image-svg')
    decode(image, 0, 0)
    expect(root).toHaveAttribute('data-loaded', 'true')
    expect(root.querySelector('.dsh-media-image-native')).not.toBeNull()
    expect(screen.queryByTestId('dsh-zoom-controls')).toBeNull()
    expect(screen.queryByTestId('file-preview-image-error')).toBeNull()
  })

  it('量不出内在尺寸的位图按坏图处理（png/jpeg 这类真坏件走这条）', () => {
    const { image } = mount('image-png')
    decode(image, 0, 0)
    expect(screen.getByTestId('file-preview-image-error')).toHaveTextContent('打不开')
  })
})

describe('DshImageBody：统一缩放（dsh-document 的 ZoomViewport）', () => {
  it('缩放控件常驻：鼠标移开、过了收起的延迟也还在（001 返工：可见的放大 / 缩小按钮）', () => {
    vi.useFakeTimers()
    try {
      const { image } = mount()
      decode(image)
      // 鼠标移到露头区之外：文档 / PDF 那条路会在这里排一个 420ms 的收起定时器
      fireEvent.pointerMove(screen.getByTestId('dsh-zoom-frame'), {
        pointerType: 'mouse',
        clientY: -1000
      })
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(screen.getByTestId('dsh-zoom-controls')).toHaveAttribute(
        'data-dsh-zoom-visible',
        'true'
      )
      expect(screen.getByTestId('dsh-zoom-in')).toBeInTheDocument()
      expect(screen.getByTestId('dsh-zoom-out')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('放大一档 = ×1.25（图片的既有口径，不是文档那套 0.25 栅格），并落到固定倍率模式', () => {
    const { image } = mount()
    decode(image)
    fireEvent.click(screen.getByTestId('dsh-zoom-in'))
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('125%')
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
  })

  it('既有能力不缩水：一路缩到 10%（下限），按钮站住', () => {
    const { image } = mount()
    decode(image)
    const out = screen.getByTestId('dsh-zoom-out')
    for (let step = 0; step < 15; step += 1) fireEvent.click(out)
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('10%')
    expect(out).toBeDisabled()
  })

  it('既有能力不缩水：一路放到 800%（上限），按钮站住', () => {
    const { image } = mount()
    decode(image)
    const zoomIn = screen.getByTestId('dsh-zoom-in')
    for (let step = 0; step < 12; step += 1) fireEvent.click(zoomIn)
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('800%')
    expect(zoomIn).toBeDisabled()
  })

  it('适应宽度 → 固定倍率的切换（双击）', () => {
    const { image } = mount()
    decode(image)
    fireEvent.doubleClick(image)
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
    fireEvent.doubleClick(image)
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
  })

  it('缩放面按适应宽度拿"原始宽"：--dsh-zoom-width 就是它', () => {
    const { image } = mount()
    decode(image)
    expect(screen.getByTestId('image-frame').style.getPropertyValue('--dsh-zoom-width')).toBe(
      '1000px'
    )
  })

  it('Ctrl + 滚轮：当场改倍率并转固定倍率（拦下整页缩放）', () => {
    const { image } = mount()
    decode(image)
    const frame = screen.getByTestId('dsh-zoom-frame')
    const port = frame.querySelector('[data-dsh-zoom-scrollport]') as HTMLElement
    const before = Number(frame.style.getPropertyValue('--dsh-zoom'))

    const dispatched = fireEvent.wheel(port, {
      ctrlKey: true,
      deltaY: -100,
      clientX: 10,
      clientY: 10
    })

    expect(dispatched, 'Ctrl+滚轮必须 preventDefault（不要落到整页缩放）').toBe(false)
    expect(Number(frame.style.getPropertyValue('--dsh-zoom'))).toBeGreaterThan(before)
    expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
  })

  it('非 Ctrl 滚轮不改倍率、也不拦默认行为（只走滚动）', () => {
    const { image } = mount()
    decode(image)
    const frame = screen.getByTestId('dsh-zoom-frame')
    const port = frame.querySelector('[data-dsh-zoom-scrollport]') as HTMLElement
    const before = frame.style.getPropertyValue('--dsh-zoom')

    const dispatched = fireEvent.wheel(port, { deltaY: -100, clientX: 10, clientY: 10 })

    expect(dispatched, '普通滚轮不该被 preventDefault').toBe(true)
    expect(frame.style.getPropertyValue('--dsh-zoom')).toBe(before)
    expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
  })

  it('StrictMode 双跑 effect 后 Ctrl+滚轮仍生效（不复用已 abort 的 controller）', () => {
    render(
      <StrictMode>
        <DshImageBody format="image-jpeg" bytes={new Uint8Array([1, 2, 3])} />
      </StrictMode>
    )
    const image = screen.getByTestId('file-preview-image').querySelector('img') as HTMLImageElement
    decode(image)
    const frame = screen.getByTestId('dsh-zoom-frame')
    const port = frame.querySelector('[data-dsh-zoom-scrollport]') as HTMLElement
    const before = Number(frame.style.getPropertyValue('--dsh-zoom'))

    const dispatched = fireEvent.wheel(port, {
      ctrlKey: true,
      deltaY: -100,
      clientX: 10,
      clientY: 10
    })

    expect(dispatched, 'StrictMode 下也必须拦下默认缩放').toBe(false)
    expect(Number(frame.style.getPropertyValue('--dsh-zoom'))).toBeGreaterThan(before)
  })

  it('手势中真实 ResizeObserver 回调触发渲染，也不回写 fit 倍率', () => {
    vi.useFakeTimers()
    const size = { width: 424, height: 300 }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    FakeResizeObserver.instances = []
    try {
      withViewport(size, () => {
        const { image } = mount('image-jpeg')
        decode(image, 1000, 400)
        const frame = screen.getByTestId('dsh-zoom-frame')
        const port = frame.querySelector('[data-dsh-zoom-scrollport]') as HTMLElement

        fireEvent.wheel(port, { ctrlKey: true, deltaY: -100, clientX: 10, clientY: 10 })
        const gestureZoom = Number(frame.style.getPropertyValue('--dsh-zoom'))
        expect(gestureZoom).toBeGreaterThan(0.392)
        expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fixed')

        // 120ms 的 pinch 还没落盘：真的改 client 尺寸并触发 ZoomViewport 注册的
        // ResizeObserver 回调（setViewportWidth/Height → React 渲染），fit 倍率从 0.392 变 0.268。
        // 如果 React 仍受控写 --dsh-zoom，这里会被缩回 fit 值；修复后应保持手势值。
        const observer = FakeResizeObserver.instances.at(-1)
        expect(observer, 'ZoomViewport 没注册 ResizeObserver').toBeDefined()
        size.width = 300
        size.height = 500
        act(() => {
          observer?.emit()
        })

        expect(Number(frame.style.getPropertyValue('--dsh-zoom'))).toBeCloseTo(gestureZoom, 6)
        expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
        expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent(
          `${String(Math.round(gestureZoom * 100))}%`
        )
      })
      // 让 pinch 的 120ms 定时器在 fake clock 里落地，避免把挂起定时器带出用例
      act(() => {
        vi.runOnlyPendingTimers()
      })
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

describe('DshImageBody：放大后鼠标拖拽平移（001 返工）', () => {
  const METRICS = { width: 400, height: 300, scrollWidth: 1_000, scrollHeight: 700 }

  it('按住左键拖拽 = 滚动位置反向跟手；松开摘掉拖拽态', () => {
    // 视口 400×300、内容 1000×700：两个方向都装不下，拖拽才有意义
    withPanMetrics(METRICS, () => {
      const { image, port, scroll } = setupPannable()

      beginPan(image)
      // 往左上拖 60px：看右下方的局部 → scrollLeft / scrollTop 各 +60
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })

      expect(port).toHaveAttribute('data-dsh-panning')
      expect(scroll).toEqual({ left: 60, top: 60 })

      fireEvent.pointerUp(window, { pointerId: 1 })
      expect(port).not.toHaveAttribute('data-dsh-panning')
    })
  })

  it('buttons=0 的 pointermove 视为丢 pointerup：立即收手，不再无按键平移', () => {
    withPanMetrics(METRICS, () => {
      const { image, port, scroll } = setupPannable()

      beginPan(image)
      // 没收到 pointerup / blur，但下一次 move 已经不带左键：这就是收尾信号
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 140, clientY: 90 })
      expect(port).not.toHaveAttribute('data-dsh-panning')
      expect(scroll).toEqual({ left: 0, top: 0 })

      fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 20, clientY: 20 })
      expect(scroll).toEqual({ left: 0, top: 0 })
    })
  })

  it('非鼠标（touch / pen）不接管拖拽：触屏仍走原生滚动', () => {
    withPanMetrics(METRICS, () => {
      const { image, port, scroll } = setupPannable()
      for (const [index, pointerType] of (['touch', 'pen'] as const).entries()) {
        fireEvent.pointerDown(image, {
          button: 0,
          buttons: 1,
          pointerType,
          pointerId: index + 2,
          clientX: 200,
          clientY: 150
        })
        fireEvent.pointerMove(window, {
          pointerId: index + 2,
          buttons: 1,
          clientX: 140,
          clientY: 90
        })
        expect(port).not.toHaveAttribute('data-dsh-panning')
        expect(scroll).toEqual({ left: 0, top: 0 })
      }
    })
  })

  it('拖拽期间滚轮改过滚动位置：下一次 move 增量跟手，不跳回按下快照', () => {
    withPanMetrics(METRICS, () => {
      const { image, port, scroll } = setupPannable()

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      expect(scroll).toEqual({ left: 60, top: 60 })

      // 模拟拖拽中用户滚轮/触控板滚到 (20,20)
      scroll.left = 20
      scroll.top = 20
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 130, clientY: 80 })

      // 增量 10，不覆盖滚轮的滚动（旧实现会回到 startTop - delta = 70）
      expect(scroll).toEqual({ left: 30, top: 30 })
      fireEvent.pointerUp(window, { pointerId: 1 })
      expect(port).not.toHaveAttribute('data-dsh-panning')
    })
  })

  it('没有拖拽时普通 click 不被吞（不误伤正常点击 / 双击）', () => {
    withPanMetrics(METRICS, () => {
      const { image } = setupPannable()
      expect(fireEvent.click(image)).toBe(true)
      expect(fireEvent.dblClick(image)).toBe(true)
    })
  })

  it('拖拽释放的 click 只在滚动口内吞掉：同 tick 点旋转钮不受影响', () => {
    withPanMetrics(METRICS, () => {
      const { image } = setupPannable()

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      fireEvent.pointerUp(window, { pointerId: 1 })

      // 拖拽释放的那一下 click 落在图片（滚动口内）：组件级 capture 吞掉
      expect(fireEvent.click(image), '拖拽释放的 click 应被组件截住').toBe(false)
      // 同一个同步块里点滚动口外的旋转钮：不在 capture 路径上，照常生效
      fireEvent.click(screen.getByTestId('image-rotate-right'))
      expect(screen.getByTestId('file-preview-image')).toHaveAttribute('data-rotation', '90')
    })
  })

  it('拖拽后的快速点击：缩放 ± 控件在 port 外，点击不被吞', () => {
    withPanMetrics(METRICS, () => {
      const { image } = setupPannable()
      const port = screen
        .getByTestId('dsh-zoom-frame')
        .querySelector('[data-dsh-zoom-scrollport]') as HTMLElement
      const zoomIn = screen.getByTestId('dsh-zoom-in')
      expect(port.contains(zoomIn), '缩放按钮应在滚动口外（兄弟层）').toBe(false)

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      fireEvent.pointerUp(window, { pointerId: 1 })

      const before = screen.getByTestId('dsh-zoom-value').textContent
      fireEvent.click(zoomIn)
      expect(screen.getByTestId('dsh-zoom-value').textContent).not.toBe(before)
      expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
    })
  })

  it('滚动口内的交互元素不被吞：只收拖拽内容面的派生点击', () => {
    withPanMetrics(METRICS, () => {
      const { image } = setupPannable()
      const button = document.createElement('button')
      button.type = 'button'
      const clicks = vi.fn()
      button.addEventListener('click', clicks)
      screen.getByTestId('image-frame').appendChild(button)

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      fireEvent.pointerUp(window, { pointerId: 1 })

      // 交互 target 即使在同一滚动口内也不吞
      expect(fireEvent.click(button)).toBe(true)
      expect(clicks).toHaveBeenCalledTimes(1)
      // 内容面本身的派生 click 仍然收
      expect(fireEvent.click(image)).toBe(false)
    })
  })

  it('拖拽后的 dblclick 不切回适应窗口（被吞 click 产出的双击也收掉）', () => {
    withPanMetrics(METRICS, () => {
      const { image } = setupPannable()
      const frame = screen.getByTestId('dsh-zoom-frame')
      expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      fireEvent.pointerUp(window, { pointerId: 1 })

      expect(fireEvent.click(image)).toBe(false)
      expect(fireEvent.dblClick(image), '拖拽 click 参与的双击也应被收掉').toBe(false)
      expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
    })
  })

  it('拖拽后即使没派发 click，紧随的 dblclick 也不切回适应窗口', () => {
    withPanMetrics(METRICS, () => {
      const { image } = setupPannable()
      const frame = screen.getByTestId('dsh-zoom-frame')
      expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      fireEvent.pointerUp(window, { pointerId: 1 })

      // 合成路径可能只有 dblclick（没有 click）：pointerup 时就要把双击窗口压住
      expect(fireEvent.dblClick(image)).toBe(false)
      expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
    })
  })

  it('拖拽后卸载：没有 window 级 click/dblclick 拦截残留', () => {
    withPanMetrics(METRICS, () => {
      const { image, unmount } = setupPannable()

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      fireEvent.pointerUp(window, { pointerId: 1 })
      unmount()

      // 旧实现这里会装 window capture 的 swallow；修复后只是一个普通 click
      expect(fireEvent.click(window)).toBe(true)
      expect(fireEvent.dblClick(window)).toBe(true)
    })
  })

  it('pointercancel 收掉手势：不再跟手、拖拽态清除', () => {
    withPanMetrics(METRICS, () => {
      const { image, port, scroll } = setupPannable()

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      expect(port).toHaveAttribute('data-dsh-panning')

      fireEvent.pointerCancel(window, { pointerId: 1 })
      expect(port).not.toHaveAttribute('data-dsh-panning')

      // 取消之后再动鼠标：监听已经摘掉，滚动位置不再跟手
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 20, clientY: 20 })
      expect(scroll).toEqual({ left: 60, top: 60 })
    })
  })

  it('窗口失焦收掉手势：pointerup 丢了也不残留', () => {
    withPanMetrics(METRICS, () => {
      const { image, port, scroll } = setupPannable()

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      expect(port).toHaveAttribute('data-dsh-panning')

      fireEvent.blur(window)
      expect(port).not.toHaveAttribute('data-dsh-panning')

      fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 20, clientY: 20 })
      expect(scroll).toEqual({ left: 60, top: 60 })
    })
  })

  it('卸载时收掉手势与 window 监听', () => {
    withPanMetrics(METRICS, () => {
      const { image, port, scroll, unmount } = setupPannable()

      beginPan(image)
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 140, clientY: 90 })
      expect(port).toHaveAttribute('data-dsh-panning')

      unmount()
      expect(port).not.toHaveAttribute('data-dsh-panning')

      // 节点已摘掉：若 window 监听没摘，这一下会继续改滚动位置
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 20, clientY: 20 })
      expect(scroll).toEqual({ left: 60, top: 60 })
    })
  })
})

describe('DshImageBody：旋转（本仓保留的能力）', () => {
  it('未解码前不挂旋转钮（没有可转的内容）', () => {
    mount()
    expect(screen.queryByTestId('image-rotate-right')).toBeNull()
  })

  it('转 90°：外接框宽高对调（--dsh-zoom-width 换成原始高），图片只叠 transform', () => {
    const { root, image } = mount()
    decode(image)
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '90')
    expect(image.style.transform).toContain('rotate(90deg)')
    expect(screen.getByTestId('image-frame').style.getPropertyValue('--dsh-zoom-width')).toBe(
      '400px'
    )
    // 图片元素自己的布局盒按"原始尺寸相对外接框"的百分比铺（1000×400 转成 400×1000 的口袋），
    // 铺 250% × 40% 正好等价于原始 1000×400；转的是 transform
    expect(image.style.width).toBe('250%')
    expect(image.style.height).toBe('40%')
  })

  it('左右各 90° 步进、取模回正，百分比不跟着变', () => {
    const { root, image } = mount()
    decode(image)
    fireEvent.click(screen.getByTestId('image-rotate-left'))
    expect(root).toHaveAttribute('data-rotation', '270')
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '90')
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '0')
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')
  })
})

/* ── 适应窗口（contain）：反馈 001 / 002 的口径 ─────────────────────────────
 * 默认完整 contain（宽高都装得下）、不放大；fit 模式说的就是它；数据面宽按 fit 比例给。 */

describe('DshImageBody：默认"适应窗口"（contain，只缩不放）', () => {
  it('宽图在窄高视口里按受限的宽缩：39%（不是铺满整框）', () => {
    withViewport({ width: 424, height: 300 }, () => {
      const { root, image } = mount('image-jpeg')
      decode(image, 1000, 400)
      expect(root).toHaveAttribute('data-loaded', 'true')
      // fit 口径标在框架上（图片私有 CSS 按它给 surface 宽）
      expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-fit', 'contain')
      // (424−32)/1000 = 0.392 vs (300−32)/400 = 0.67 → 0.392
      expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('39%')
      expect(screen.getByTestId('dsh-zoom-frame').style.getPropertyValue('--dsh-zoom')).toBe(
        '0.392'
      )
      // 面拿的仍是原始宽（宽高比由 aspect-ratio 自己给，fit 只改倍率）
      expect(screen.getByTestId('image-frame').style.getPropertyValue('--dsh-zoom-width')).toBe(
        '1000px'
      )
    })
  })

  it('竖图按高适配：27%（不会因为"宽还装得下"就不缩）', () => {
    withViewport({ width: 424, height: 300 }, () => {
      const { image } = mount('image-jpeg')
      decode(image, 400, 1000)
      // (424−32)/400 = 0.98 vs (300−32)/1000 = 0.268 → 0.268
      expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('27%')
      expect(screen.getByTestId('dsh-zoom-frame').style.getPropertyValue('--dsh-zoom')).toBe(
        '0.268'
      )
    })
  })

  it('小图不放大：装得下就按 100%（不撑成"适应宽度"的放大图）', () => {
    withViewport({ width: 424, height: 300 }, () => {
      const { image } = mount('image-jpeg')
      decode(image, 120, 80)
      expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')
      expect(screen.getByTestId('dsh-zoom-frame').style.getPropertyValue('--dsh-zoom')).toBe('1')
    })
  })

  it('转 90°：contain 按旋转后的外接框重算（竖图转横、改按宽适配）', () => {
    withViewport({ width: 424, height: 300 }, () => {
      const { image } = mount('image-jpeg')
      decode(image, 400, 1000)
      expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('27%')

      fireEvent.click(screen.getByTestId('image-rotate-right'))
      // 外接框换成 1000×400：(424−32)/1000 = 0.392 vs (300−32)/400 = 0.67 → 0.392
      expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('39%')
      expect(screen.getByTestId('image-frame').style.getPropertyValue('--dsh-zoom-width')).toBe(
        '1000px'
      )
      // 图片元素仍按"原始尺寸相对外接框"的百分比铺（400×1000 铺进 1000×400 的口袋）
      expect(image.style.width).toBe('40%')
      expect(image.style.height).toBe('250%')
    })
  })

  it('放大一档从 contain 倍率起走（不跳回 100%），模式转固定倍率', () => {
    withViewport({ width: 424, height: 300 }, () => {
      const { image } = mount('image-jpeg')
      decode(image, 1000, 400)
      fireEvent.click(screen.getByTestId('dsh-zoom-in'))
      // 0.392 × 1.25 = 0.49
      expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('49%')
      expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
    })
  })

  it('菜单里是「适应窗口」（图片这侧的文案；fit 项仍标中）', () => {
    const { image } = mount('image-jpeg')
    decode(image, 1000, 400)
    fireEvent.keyDown(screen.getByTestId('dsh-zoom-percent'), { key: 'ArrowDown' })
    const fit = screen.getByRole('menuitem', { name: '适应窗口' })
    expect(fit).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('menuitem', { name: '适应宽度' })).toBeNull()
  })

  it('视口量不到（jsdom / 面板收起）：fit 退回按原始大小，不硬缩成 0%', () => {
    const { image } = mount('image-jpeg')
    decode(image, 1000, 400)
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-fit', 'contain')
  })
})
