import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshPdfViewer } from '../DshPdfViewer'

/* ── 替身：pdfjs 的两条模块（与既有 preview.spec 同路数） ───────────────── */

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => mocks.getDocument(...args)
}))

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    readonly div = document.createElement('div')
    constructor() {
      this.div.className = 'textLayer'
    }
    render(): Promise<void> {
      return Promise.resolve()
    }
    cancel(): void {
      this.div.replaceChildren()
    }
  }
}))

/** 一页替身：getViewport 给固定比例、render 走空动作（cleanup 由渲染层收尾时调）。 */
function fakePage(): Record<string, unknown> {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 800 * scale,
      height: 1000 * scale,
      scale,
      userUnit: 1
    }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    cleanup: () => undefined
  }
}

function fakeDocument(numPages: number): Record<string, unknown> {
  return { numPages, getPage: async () => fakePage() }
}

/** 加载任务替身：promise + destroy（真件就这两个成员被用到）。 */
function taskOf(document: unknown): Record<string, unknown> {
  return { promise: Promise.resolve(document), destroy: async () => undefined }
}

/* ── 观察器替身：jsdom 没有 IntersectionObserver，惰性渲染要自己驱动 ─────── */

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly callback: IntersectionObserverCallback
  observed = 0
  disconnected = false
  /** 被观察的元素（按它认出"这只属于哪一页"；组件在 ready 前后观察的是不同节点）。 */
  target: Element | null = null
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.instances.push(this)
  }
  observe(node: Element): void {
    this.target = node
    this.observed += 1
  }
  unobserve(): void {
    this.observed -= 1
  }
  disconnect(): void {
    this.disconnected = true
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  emit(): void {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never)
  }
}

/**
 * 某一页**当前活着**的那只观察器。
 * 为什么按"观察的元素落在哪一页里"认：组件画好一页之后会把观察目标从占位容器换成画布
 * （effect 依赖里的 `state` 变了），于是同一页会有前后两只；直接按实例数组顺序取会取到
 * 上一代那只（已 disconnect，emit 无效果），断言就不稳。
 */
function liveObserverOf(pageNumber: number): FakeIntersectionObserver | undefined {
  const page = screen.getAllByTestId('dsh-pdf-page')[pageNumber - 1]
  if (page === undefined) return undefined
  return [...FakeIntersectionObserver.instances]
    .reverse()
    .find(
      (observer) =>
        !observer.disconnected && observer.target !== null && page.contains(observer.target)
    )
}

/** 同一份内容的同一个实例（组件按数组身份判断"换文件了"）。 */
const BYTES = new Uint8Array([1, 2, 3])

/** 打开等它到 loaded（人话态由 data-state 表达）。 */
async function opened(): Promise<HTMLElement> {
  render(<DshPdfViewer bytes={BYTES} />)
  const viewer = screen.getByTestId('dsh-pdf-viewer')
  await waitFor(() => expect(viewer).toHaveAttribute('data-state', 'loaded'))
  return viewer
}

beforeEach(() => {
  mocks.getDocument.mockReset()
  FakeIntersectionObserver.instances = []
  // jsdom 没有 2D 上下文：显式给一个只有 drawImage 的替身，页面才能走到 ready
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DshPdfViewer：打开与失败', () => {
  it('打开成功：一页一个壳、一张画布、一层文字；页面画好才摘掉占位块', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(2)))

    const viewer = await opened()

    expect(viewer).toHaveAttribute('data-pages', '2')
    const pages = screen.getAllByTestId('dsh-pdf-page')
    expect(pages).toHaveLength(2)
    expect(pages.map((page) => page.dataset.page)).toEqual(['1', '2'])

    const first = pages[0] as HTMLElement
    expect(within(first).getByTestId('dsh-pdf-page-canvas')).toBeInTheDocument()
    // 文字层（可选中可复制）挂在同一页的画布之上
    expect(within(first).getByTestId('dsh-pdf-page-text')).toBeInTheDocument()

    await waitFor(() =>
      expect(screen.getAllByTestId('dsh-pdf-page-surface')[0]).not.toHaveAttribute('hidden')
    )
    expect(within(first).queryByTestId('dsh-pdf-page-placeholder')).toBeNull()
  })

  it('打开时把本地 CMap / 标准字体的供给交给 pdf.js（没它，缺内嵌字体的 CJK 整页都画不出来）', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))

    render(<DshPdfViewer bytes={BYTES} />)
    await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1))

    const options = mocks.getDocument.mock.calls[0]?.[0] as Record<string, unknown>
    // 完整字节在手上 → worker 不自己 fetch；资源那一问（FetchBinaryData）由主线程的工厂回答
    expect(options.useWorkerFetch).toBe(false)
    expect(options.cMapPacked).toBe(true)
    // 必须是**构造器**（pdf.js 会 `new BinaryDataFactory(...)`；给实例会炸成
    // "BinaryDataFactory is not a constructor" —— R90 探针在真机上抓到的就是这条）
    expect(typeof options.BinaryDataFactory).toBe('function')
    expect(options.data).toBeInstanceOf(Uint8Array)
  })

  it('愿意自己管资源时可以显式关掉（`pdfAssets={{}}` 就是"什么都不给"）', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))

    render(<DshPdfViewer bytes={BYTES} pdfAssets={{}} />)
    await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1))

    const options = mocks.getDocument.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.useWorkerFetch).toBe(false)
    expect(options.BinaryDataFactory).toBeUndefined()
  })

  it('坏文件 / 加密：与主进程同一套人话，重试再开一次', async () => {
    const broken = Object.assign(new Error('bad'), { name: 'InvalidPDFException' })
    mocks.getDocument.mockImplementationOnce(() => ({
      promise: Promise.reject(broken),
      destroy: async () => undefined
    }))

    render(<DshPdfViewer bytes={BYTES} />)

    await waitFor(() =>
      expect(screen.getByTestId('dsh-pdf-error')).toHaveTextContent('读不出这个 PDF')
    )
    expect(screen.getByTestId('dsh-pdf-viewer')).toHaveAttribute('data-state', 'failed')

    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))
    fireEvent.click(screen.getByTestId('dsh-pdf-retry'))

    await waitFor(() =>
      expect(screen.getByTestId('dsh-pdf-viewer')).toHaveAttribute('data-state', 'loaded')
    )
    expect(mocks.getDocument).toHaveBeenCalledTimes(2)
  })

  it('卸载即取消：销毁加载任务；迟到的打开不会往已卸载的树里写', async () => {
    const destroy = vi.fn(async () => undefined)
    let settle: ((document: unknown) => void) | undefined
    const pending = new Promise((resolve) => {
      settle = resolve
    })
    mocks.getDocument.mockReturnValue({ promise: pending, destroy })

    const { unmount } = render(<DshPdfViewer bytes={BYTES} />)
    await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1))

    unmount()
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))

    settle?.(fakeDocument(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByTestId('dsh-pdf-error')).toBeNull()
  })

  it('同一份字节重渲染不重开文档（数组实例身份就是"换文件"的判据）', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))

    const { rerender } = render(<DshPdfViewer bytes={BYTES} />)
    await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1))

    rerender(<DshPdfViewer bytes={BYTES} />)
    await waitFor(() =>
      expect(screen.getByTestId('dsh-pdf-viewer')).toHaveAttribute('data-state', 'loaded')
    )
    expect(mocks.getDocument).toHaveBeenCalledTimes(1)
  })
})

describe('DshPdfViewer：缩放', () => {
  it('默认适应宽度；按一档变固定倍率，模式与数字当场跟上', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))
    render(<DshPdfViewer bytes={BYTES} />)

    // 控件要等第一页量到原始宽才出现（intrinsicWidth）
    const zoomIn = await screen.findByTestId('dsh-zoom-in')
    const frame = screen.getByTestId('dsh-zoom-frame')
    expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
    // jsdom 量不到滚动口宽 → 适应宽度按原始大小（100%），不是 0%
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')

    fireEvent.click(zoomIn)
    expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('125%')
    expect(frame.style.getPropertyValue('--dsh-zoom')).toBe('1.25')

    fireEvent.click(screen.getByTestId('dsh-zoom-out'))
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')
  })

  it('不接管鼠标拖拽：没有图片那侧的 pan 开关（PDF 选文手势不受影响）', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))
    render(<DshPdfViewer bytes={BYTES} />)
    await screen.findByTestId('dsh-zoom-in')

    const scrollport = screen
      .getByTestId('dsh-zoom-frame')
      .querySelector('[data-dsh-zoom-scrollport]') as HTMLElement
    // 拖动平移是图片宿主显式打开的能力；PDF 的滚动口不该带这个标记
    expect(scrollport).not.toHaveAttribute('data-dsh-pan-enabled')

    scrollport.scrollLeft = 12
    scrollport.scrollTop = 34
    const page = screen.getByTestId('dsh-pdf-page')
    fireEvent.pointerDown(page, {
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 100,
      clientY: 100
    })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 40 })
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(scrollport).not.toHaveAttribute('data-dsh-panning')
    expect(scrollport.scrollLeft).toBe(12)
    expect(scrollport.scrollTop).toBe(34)
  })

  it('改缩放报给宿主（onZoomChange 拿的是偏好，不是换算后的数字）', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))
    const onZoomChange = vi.fn()
    render(<DshPdfViewer bytes={BYTES} onZoomChange={onZoomChange} />)

    fireEvent.click(await screen.findByTestId('dsh-zoom-in'))

    expect(onZoomChange).toHaveBeenCalledWith({ kind: 'fixed', scale: 1.25 })
  })

  it('适应宽度不看高度：视口再矮也不参与（contain 是图片那边的事，PDF 口径不变）', async () => {
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(1)))
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 424
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 200
    })
    try {
      render(<DshPdfViewer bytes={BYTES} />)
      await screen.findByTestId('dsh-zoom-in')

      const frame = screen.getByTestId('dsh-zoom-frame')
      expect(frame).toHaveAttribute('data-dsh-zoom-fit', 'width')
      // 页宽按 96/72 折算：800 × 96/72 = 1066.67 → (424−24)/1066.67 = 0.375 → 38%。
      // 只按宽算：真把高度也折进来（contain）会缩到 13% 左右
      expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('38%')
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    }
  })
})

describe('DshPdfViewer：按需页渲染与当前页', () => {
  it('页进视口才画，并把当前页报给宿主（同一页不重复报）', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    mocks.getDocument.mockReturnValue(taskOf(fakeDocument(3)))
    const onPageChange = vi.fn()

    render(<DshPdfViewer bytes={BYTES} onPageChange={onPageChange} />)
    await waitFor(() =>
      expect(screen.getByTestId('dsh-pdf-viewer')).toHaveAttribute('data-state', 'loaded')
    )
    expect(screen.getAllByTestId('dsh-pdf-page')).toHaveLength(3)

    // 观察器一次都没回调之前，第 2/3 页还没画（占位块在、位图不在）—— 这就是"按需渲染"
    const surfaces = screen.getAllByTestId('dsh-pdf-page-surface')
    expect(surfaces[1]).toHaveAttribute('hidden')
    expect(surfaces[2]).toHaveAttribute('hidden')

    // 第 2、3 页进视口：各自报一次给宿主（第 1 页是初始当前页，不重复报）
    liveObserverOf(2)?.emit()
    liveObserverOf(3)?.emit()

    await waitFor(() =>
      expect(screen.getAllByTestId('dsh-pdf-page-surface')[2]).not.toHaveAttribute('hidden')
    )
    const reported = onPageChange.mock.calls.map((call) => (call as [number])[0])
    expect(reported).toEqual([2, 3])

    // 同一页反复进视口不重复报（emit 的是**当前活着**的那只，前一只已 disconnect）
    liveObserverOf(3)?.emit()
    liveObserverOf(3)?.emit()
    expect(onPageChange).toHaveBeenCalledTimes(2)
  })

  it('单页画不出来：这一页给人话 + 重试，不牵连其它页', async () => {
    let failed = false
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (page: number) => {
          if (page === 1 && !failed) {
            failed = true
            throw new Error('这一页坏了')
          }
          return fakePage()
        }
      }),
      destroy: async () => undefined
    })

    render(<DshPdfViewer bytes={BYTES} />)

    const error = await screen.findByTestId('dsh-pdf-page-error')
    expect(error).toHaveAttribute('data-page', '1')
    expect(error).toHaveTextContent('这一页画不出来')

    fireEvent.click(within(error).getByTestId('dsh-pdf-page-retry'))

    // 重试之后这一页画出来了（错误块收掉，占位块也跟着收）
    await waitFor(() => expect(screen.queryByTestId('dsh-pdf-page-error')).toBeNull())
    await waitFor(() =>
      expect(screen.getAllByTestId('dsh-pdf-page-surface')[0]).not.toHaveAttribute('hidden')
    )
  })
})
