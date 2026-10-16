import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagePreview } from '../ImagePreview'
import { MarkdownPreview } from '../MarkdownPreview'

/** markdown 预览：同一套聊天区口径的渲染器（react-markdown + remark-gfm），另加数学与 frontmatter */
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

  it('数学与 frontmatter 是新加的层（$...$ → KaTeX；`---` 块 → 字段框），正文照常', () => {
    render(<MarkdownPreview text={'---\ntitle: 标题\n---\n\n公式 $a^2$ 在行内\n'} />)
    const body = screen.getByTestId('file-preview-markdown')
    // frontmatter：整块不再落进正文（框是同步挂出来的，字段表在懒分块里、加载期间显示原文）
    expect(screen.getByTestId('file-preview-frontmatter')).toBeInTheDocument()
    // 数学：`$...$` 被 KaTeX 接管（`.katex` 是它输出的根类），正文其余照常
    expect(body.querySelector('.katex')).not.toBeNull()
    expect(body.textContent).toContain('在行内')
  })
})

/**
 * 图片预览：原字节 → data URL → `<img>`；坏图解不开给人话。
 *
 * round 52 那套自绘看图器（工具条四钮 / 10%–800% / ×1.25 步进 / 舞台与图片的像素尺寸）的断言
 * 随实现一起作废：缩放改由共用的 `dsh-document/ZoomViewport` 承担（档位口径 25%–400%、0.25 栅格，
 * 由 `dsh-document/__tests__/zoom.spec.ts` 覆盖），SVG/ICO、统一缩放、旋转与双击回位、
 * "无内在尺寸 SVG"的降级路都按新 DOM 在 `dsh-media/__tests__/image.spec.tsx` 里钉住。
 */
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
