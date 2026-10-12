import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagePreview } from '../ImagePreview'
import { MarkdownPreview } from '../MarkdownPreview'

/** markdown 预览：直接复用聊天区那套渲染器（react-markdown + remark-gfm） */
describe('MarkdownPreview', () => {
  it('标题 / 列表 / 表格都真渲染出来（不是 <pre> 纯文本）', () => {
    render(
      <MarkdownPreview
        text={'# 标题一\n\n- 第一项\n- 第二项\n\n| 列 | 值 |\n| --- | --- |\n| a | b |\n'}
      />
    )

    const body = screen.getByTestId('file-preview-markdown')
    expect(body.querySelector('h1')?.textContent).toBe('标题一')
    expect(body.querySelectorAll('li')).toHaveLength(2)
    expect(body.querySelectorAll('th')).toHaveLength(2)
    expect(body.querySelector('td')?.textContent).toBe('a')
  })

  it('原始 HTML 不进 DOM（react-markdown 不解析，天然没有 XSS 面）', () => {
    render(<MarkdownPreview text={'<script>window.x=1</script>\n\n正常文字'} />)
    const body = screen.getByTestId('file-preview-markdown')
    expect(body.querySelector('script')).toBeNull()
    expect(body.textContent).toContain('正常文字')
  })
})

/** 图片预览：原字节 → data URL → <img>；坏图解不开给人话 */
describe('ImagePreview', () => {
  it('png 字节编成 data URL（CSP img-src 已放行 data:）', () => {
    render(<ImagePreview format="image-png" bytes={new Uint8Array([0x89, 0x50, 0x4e, 0x47])} />)
    const image = screen.getByTestId('file-preview-image').querySelector('img')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
  })

  it('jpeg / gif / webp / bmp 各自的 MIME 都对得上', () => {
    const mimes: Array<[Parameters<typeof ImagePreview>[0]['format'], string]> = [
      ['image-jpeg', 'data:image/jpeg;base64,'],
      ['image-gif', 'data:image/gif;base64,'],
      ['image-webp', 'data:image/webp;base64,'],
      ['image-bmp', 'data:image/bmp;base64,']
    ]
    for (const [format, prefix] of mimes) {
      const { unmount } = render(<ImagePreview format={format} bytes={new Uint8Array([1, 2, 3])} />)
      const image = screen.getByTestId('file-preview-image').querySelector('img')
      expect(image?.getAttribute('src')?.startsWith(prefix)).toBe(true)
      unmount()
    }
  })

  it('解不开的图（onError）给人话，不留在空白里', () => {
    render(<ImagePreview format="image-png" bytes={new Uint8Array([1])} />)
    const image = screen.getByTestId('file-preview-image').querySelector('img')
    fireEvent.error(image as HTMLElement)

    expect(screen.getByTestId('file-preview-image-error')).toHaveTextContent('打不开')
  })
})

/**
 * round 52 的看图器（缩放 / 旋转 / 居中 / 工具条）。
 * jsdom 不排版，所以几何靠 `stubBox` 显式铺给舞台、像素尺寸铺给 `<img>`；
 * 断言打在三处可断言的落点：百分比文本、`data-*`、`style` 变换。
 */
function stubBox(element: HTMLElement, size: { w: number; h: number }): void {
  Object.defineProperty(element, 'clientWidth', { value: size.w, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: size.h, configurable: true })
}

/** 铺一张"已经解码好"的图：舞台 632×332、原图 1000×400 → 适应窗口 = 60% */
function renderFitted(): {
  root: HTMLElement
  stage: HTMLElement
  image: HTMLImageElement
  value: HTMLElement
} {
  render(<ImagePreview format="image-png" bytes={new Uint8Array([1])} />)
  const root = screen.getByTestId('file-preview-image')
  const stage = screen.getByTestId('image-stage')
  const image = root.querySelector('img') as HTMLImageElement
  stubBox(stage, { w: 632, h: 332 })
  Object.defineProperty(image, 'naturalWidth', { value: 1000, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: 400, configurable: true })
  fireEvent(window, new Event('resize')) // jsdom 没有 ResizeObserver：靠这条兜底重量
  fireEvent.load(image)
  return { root, stage, image, value: screen.getByTestId('image-zoom-value') }
}

describe('ImagePreview：缩放 / 旋转 / 工具条', () => {
  it('工具条：四个图标钮带无障碍名，百分比落在中间（放大镜里带 +/-，零 emoji）', () => {
    render(<ImagePreview format="image-png" bytes={new Uint8Array([1])} />)
    const toolbar = screen.getByTestId('image-toolbar')

    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual(['缩小', '放大', '逆时针旋转', '顺时针旋转'])
    // 文本节点只有百分比这一处（没有解释小字）
    expect(toolbar.textContent).toBe('100%')
    expect(screen.getByTestId('image-zoom-value')).toBe(toolbar.children[1])
  })

  it('按钮缩放：一档 ×1.25、等比累乘，两头都夹住（10% / 800%）', () => {
    const { root, value } = renderFitted()
    // 适应窗口已经算出来了，百分比就是它（不是 100%）
    expect(value).toHaveTextContent('60%')

    fireEvent.click(screen.getByTestId('image-zoom-in'))
    expect(value).toHaveTextContent('75%')
    expect(root).toHaveAttribute('data-zoom', '0.75')

    fireEvent.click(screen.getByTestId('image-zoom-in'))
    expect(value).toHaveTextContent('94%') // 0.9375

    fireEvent.click(screen.getByTestId('image-zoom-out'))
    fireEvent.click(screen.getByTestId('image-zoom-out'))
    expect(value).toHaveTextContent('60%') // 回到适应窗口那一档的数值（此时是显式倍率）

    for (let step = 0; step < 20; step += 1) fireEvent.click(screen.getByTestId('image-zoom-in'))
    expect(value).toHaveTextContent('800%')

    for (let step = 0; step < 30; step += 1) fireEvent.click(screen.getByTestId('image-zoom-out'))
    expect(value).toHaveTextContent('10%')
  })

  it('缩放改的是布局尺寸（100% = 一图一 CSS px），旋转只叠 transform', () => {
    const { image } = renderFitted()
    // 适应窗口 60%：1000×400 的原图 → 600×240
    expect(image.style.width).toBe('600px')
    expect(image.style.height).toBe('240px')
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(0deg)')
    expect(screen.getByTestId('image-frame').style.width).toBe('600px')

    fireEvent.click(screen.getByTestId('image-zoom-in')) // 75%
    expect(image.style.width).toBe('750px')
    expect(image.style.height).toBe('300px')

    // 转 90°：图片的布局尺寸不变，外框（滚动范围）宽高对调
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(image.style.width).toBe('750px')
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(90deg)')
    expect(screen.getByTestId('image-frame').style.width).toBe('300px')
    expect(screen.getByTestId('image-frame').style.height).toBe('750px')
  })

  it('Ctrl+滚轮缩放；普通滚轮不接管（不拦、也不改倍率）', () => {
    const { stage, value } = renderFitted()

    // 没按 Ctrl：默认行为照旧（页面/容器照滚），倍率一点不动
    const plain = new WheelEvent('wheel', { deltaY: -120, cancelable: true })
    expect(fireEvent(stage, plain)).toBe(true)
    expect(plain.defaultPrevented).toBe(false)
    expect(value).toHaveTextContent('60%')

    // 按住 Ctrl：拦掉默认行为 + 进一档
    const zoomIn = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, cancelable: true })
    expect(fireEvent(stage, zoomIn)).toBe(false)
    expect(zoomIn.defaultPrevented).toBe(true)
    expect(value).toHaveTextContent('75%')

    const zoomOut = new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, cancelable: true })
    fireEvent(stage, zoomOut)
    expect(value).toHaveTextContent('60%')
  })

  it('Ctrl+滚轮锚在光标下的点：滚动位置按 k 重算（内容宽变 k 倍、中心不动）', () => {
    const { stage } = renderFitted()
    let left = 100
    let top = 50
    Object.defineProperty(stage, 'scrollLeft', {
      get: () => left,
      set: (value: number) => {
        left = value
      },
      configurable: true
    })
    Object.defineProperty(stage, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = value
      },
      configurable: true
    })

    // k = 1.25、光标离滚动口左缘 300 / 上缘 100 → left' = 1.25·100 + 0.25·300 = 200
    fireEvent(
      stage,
      new WheelEvent('wheel', {
        deltaY: -120,
        ctrlKey: true,
        cancelable: true,
        clientX: 300,
        clientY: 100
      })
    )

    expect(left).toBe(200)
    expect(top).toBe(87.5)
  })

  it('旋转：左右各 90° 步进、取模回正，百分比不跟着变', () => {
    const { root, image, value } = renderFitted()

    fireEvent.click(screen.getByTestId('image-rotate-left'))
    expect(root).toHaveAttribute('data-rotation', '270')
    expect(image.style.transform).toContain('rotate(270deg)')

    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '90')

    // 转满一圈回正（不是四张不同的图，是同一个角度的取模）
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '0')

    expect(value).toHaveTextContent('60%')
  })

  it('双击：适应窗口 ↔ 100%（图比容器小时居中显示的那一档）', () => {
    const { image, value } = renderFitted()
    expect(value).toHaveTextContent('60%')

    fireEvent.doubleClick(image)
    expect(value).toHaveTextContent('100%')

    fireEvent.doubleClick(image)
    expect(value).toHaveTextContent('60%')
  })

  it('尺寸量不出来时不硬缩：按 100%（等真量到了再收）', () => {
    render(<ImagePreview format="image-png" bytes={new Uint8Array([1])} />)
    const image = screen.getByTestId('file-preview-image').querySelector('img') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', { value: 1000, configurable: true })
    Object.defineProperty(image, 'naturalHeight', { value: 400, configurable: true })
    fireEvent.load(image)

    expect(screen.getByTestId('file-preview-image')).toHaveAttribute('data-loaded', 'true')
    expect(screen.getByTestId('image-zoom-value')).toHaveTextContent('100%')
  })
})

/* ── PDF：分派/加载/失败 + round 52 的缩放与侧栏（真渲染由真机取证举证） ──── */

const getDocument = vi.fn()

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => getDocument(...args)
}))

/** 一页的替身：getViewport 给个固定尺寸，render 走空动作 */
function fakePage(): Record<string, unknown> {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale
    }),
    render: () => ({ promise: Promise.resolve() }),
    cleanup: () => undefined
  }
}

/** 文档替身；`extra` 用来塞 outline 那一套（getOutline / getPageIndex） */
function fakeDocument(
  numPages: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { numPages, getPage: async () => fakePage(), getOutline: async () => null, ...extra }
}

/** 加载任务：真件（PDFDocumentLoadingTask）既有 promise 也有 destroy，替身照抄这两个成员 */
function fakeTask(document: Record<string, unknown>): Record<string, unknown> {
  return { promise: Promise.resolve(document), destroy: async () => undefined }
}

function rejectedTask(error: unknown): Record<string, unknown> {
  return { promise: Promise.reject(error), destroy: async () => undefined }
}

/** jsdom 没有 2d context：显式钉成 null（本组件据此跳过真画，仍记账页数） */
beforeEach(() => {
  getDocument.mockReset()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

describe('PdfPreview', () => {
  it('打开成功：逐页建 canvas（上限内全画）', async () => {
    getDocument.mockReturnValue(fakeTask(fakeDocument(2)))

    const { PdfPreview } = await import('../PdfPreview')
    render(<PdfPreview bytes={new Uint8Array([1, 2, 3])} />)

    await waitFor(() =>
      expect(screen.getByTestId('file-preview-pdf')).toHaveAttribute('data-pages', '2')
    )
    const container = screen.getByTestId('file-preview-pdf')
    expect(container.querySelectorAll('canvas')).toHaveLength(2)
    expect(container.querySelector('canvas')?.getAttribute('data-page')).toBe('1')
    expect(screen.queryByTestId('file-preview-pdf-truncated')).toBeNull()
  })

  it('超过 50 页：只画前 50 页并如实说（不假装画全了）', async () => {
    getDocument.mockReturnValue(fakeTask(fakeDocument(80)))

    const { PdfPreview } = await import('../PdfPreview')
    render(<PdfPreview bytes={new Uint8Array([1])} />)

    await waitFor(
      () => expect(screen.getByTestId('file-preview-pdf')).toHaveAttribute('data-pages', '50'),
      { timeout: 5000 }
    )
    expect(screen.getByTestId('file-preview-pdf-truncated')).toHaveTextContent('只显示前 50 页')
  })

  it('坏文件 / 加密：给主进程同一套人话（不吐栈）', async () => {
    const broken = Object.assign(new Error('bad'), { name: 'InvalidPDFException' })
    getDocument.mockReturnValue(rejectedTask(broken))

    const { PdfPreview } = await import('../PdfPreview')
    render(<PdfPreview bytes={new Uint8Array([1])} />)

    await waitFor(() =>
      expect(screen.getByTestId('file-preview-pdf-error')).toHaveTextContent('读不出这个 PDF')
    )
  })

  it('加密的 PDF：人话点明是密码问题', async () => {
    const locked = Object.assign(new Error('locked'), { name: 'PasswordException' })
    getDocument.mockReturnValue(rejectedTask(locked))

    const { PdfPreview } = await import('../PdfPreview')
    render(<PdfPreview bytes={new Uint8Array([1])} />)

    await waitFor(() =>
      expect(screen.getByTestId('file-preview-pdf-error')).toHaveTextContent('有密码')
    )
  })
})

/* ── round 52：缩放（档位 + 点击那一下就把尺寸铺开） ─────────────────────── */

/** 打开一份 n 页的替身文档，等首趟画完 */
async function openPdf(
  numPages: number,
  extra: Record<string, unknown> = {}
): Promise<HTMLElement> {
  getDocument.mockReturnValue(fakeTask(fakeDocument(numPages, extra)))
  const { PdfPreview } = await import('../PdfPreview')
  render(<PdfPreview bytes={new Uint8Array([1])} />)
  const host = screen.getByTestId('file-preview-pdf')
  await waitFor(() => expect(host).toHaveAttribute('data-pages', String(numPages)))
  return host
}

describe('PdfPreview：缩放', () => {
  it('默认档 = 适应宽度（页宽就是容器宽）；放大/缩小各走一档，尺寸当场跟着变', async () => {
    const host = await openPdf(1)
    const canvas = host.querySelector('canvas') as HTMLCanvasElement
    // jsdom 量不到容器宽 → 兜底 600；页 600×800 → 适应宽度就是 600（100%）
    expect(canvas.style.width).toBe('600px')
    expect(canvas.style.height).toBe('800px')
    expect(host).toHaveAttribute('data-zoom', '1')

    fireEvent.click(screen.getByTestId('pdf-zoom-in'))
    // 点击这一下就已经铺开了（位图重画是防抖之后的事）
    expect(canvas.style.width).toBe('750px')
    expect(host).toHaveAttribute('data-zoom', '1.25')

    fireEvent.click(screen.getByTestId('pdf-zoom-out'))
    fireEvent.click(screen.getByTestId('pdf-zoom-out'))
    expect(host).toHaveAttribute('data-zoom', '0.8')
    expect(canvas.style.width).toBe('480px')
    expect(canvas.style.height).toBe('640px')
  })

  it('两端站住：档位一档一档走（×1.25 上下），0.5 禁「缩小」、3 禁「放大」', async () => {
    const host = await openPdf(1)
    const out = screen.getByTestId('pdf-zoom-out')
    const zoomIn = screen.getByTestId('pdf-zoom-in')
    const level = (): string => host.getAttribute('data-zoom') ?? ''

    const down: string[] = []
    for (let step = 0; step < 5; step += 1) {
      fireEvent.click(out)
      down.push(level())
    }
    expect(down).toEqual(['0.8', '0.65', '0.5', '0.5', '0.5'])
    expect(out).toBeDisabled()

    const up: string[] = []
    for (let step = 0; step < 9; step += 1) {
      fireEvent.click(zoomIn)
      up.push(level())
    }
    expect(up).toEqual(['0.65', '0.8', '1', '1.25', '1.5', '2', '3', '3', '3'])
    expect(zoomIn).toBeDisabled()
  })
})

/* ── round 52：缩略图侧栏 + 目录 ─────────────────────────────────────────── */

describe('PdfPreview：缩略图侧栏', () => {
  it('开关滑出/收回；缩略图懒挂（开之前一张都不画）；点一下跳页并高亮', async () => {
    const host = await openPdf(5)
    const sidebar = screen.getByTestId('pdf-sidebar')
    expect(sidebar).toHaveAttribute('data-open', 'false')

    // 列表本身（页码）跟着页数走，但画布一张都还没挂 —— 懒渲染的口径
    const entries = screen.getAllByTestId('pdf-thumb')
    expect(entries.map((entry) => entry.dataset.thumbPage)).toEqual(['1', '2', '3', '4', '5'])
    expect(entries.some((entry) => entry.querySelector('canvas') !== null)).toBe(false)

    fireEvent.click(screen.getByTestId('pdf-sidebar-toggle'))
    expect(sidebar).toHaveAttribute('data-open', 'true')

    // jsdom 没有 IntersectionObserver → 兜底"全都要"，但仍一批一批挂（每批 3 张）
    await waitFor(() =>
      expect(
        screen.getAllByTestId('pdf-thumb').every((entry) => entry.querySelector('canvas') !== null)
      ).toBe(true)
    )
    const thumbs = screen.getAllByTestId('pdf-thumb')
    expect(thumbs[0]).toHaveAttribute('data-current', 'true')

    fireEvent.click(thumbs[3] as HTMLElement)
    expect(thumbs[3]).toHaveAttribute('data-current', 'true')
    expect(thumbs[0]).toHaveAttribute('data-current', 'false')

    fireEvent.click(screen.getByTestId('pdf-sidebar-toggle'))
    expect(sidebar).toHaveAttribute('data-open', 'false')
    // 收回只是宽度过渡 + inert（画布留着，再打开不用重画）
    expect(screen.getAllByTestId('pdf-thumb')).toHaveLength(5)
    expect(host.querySelectorAll('canvas')).toHaveLength(5)
  })

  it('nextThumbBatch：页号升序、跳过已挂的、每批限量（懒渲染的批次口径）', async () => {
    const { nextThumbBatch } = await import('../PdfPreview')
    expect(nextThumbBatch([3, 1, 2], [], 2)).toEqual([1, 2])
    expect(nextThumbBatch([3, 1, 2], [1], 2)).toEqual([2, 3])
    expect(nextThumbBatch([7, 4, 4, 2], [2, 4, 7], 3)).toEqual([])
  })

  it('文档带书签：侧栏多出「目录」一档，点一项跳到那一页；没书签就没有这一档', async () => {
    await openPdf(3, {
      getOutline: async () => [
        {
          title: '第一章',
          dest: [{ num: 2, gen: 0 }],
          items: [{ title: '第一节', dest: [{ num: 3, gen: 0 }], items: [] }]
        },
        { title: '外部链接（没有页码）', dest: null, items: [] }
      ],
      getPageIndex: async (ref: { num: number }) => ref.num - 1
    })
    fireEvent.click(screen.getByTestId('pdf-sidebar-toggle'))
    await waitFor(() => expect(screen.getByTestId('pdf-tab-outline')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('pdf-tab-outline'))
    const items = screen.getAllByTestId('pdf-outline-item')
    // 解析不出页码的那条不进目录（不瞎猜页），子树照走
    expect(items.map((item) => item.textContent)).toEqual(['第一章', '第一节'])
    expect(items[0]).toHaveAttribute('data-page', '2')

    fireEvent.click(items[1] as HTMLElement)
    expect(items[1]).toHaveAttribute('data-current', 'true')
  })

  it('没有书签：只有缩略图，不给一档空的「目录」', async () => {
    await openPdf(2)
    fireEvent.click(screen.getByTestId('pdf-sidebar-toggle'))
    await waitFor(() => expect(screen.getAllByTestId('pdf-thumb')).toHaveLength(2))
    expect(screen.queryByTestId('pdf-tab-outline')).toBeNull()
    expect(screen.queryByTestId('pdf-outline')).toBeNull()
  })
})
