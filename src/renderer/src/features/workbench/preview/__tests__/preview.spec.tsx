import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

/* ── PDF：只验分派/加载/失败（真渲染由 B2 冒烟举证） ─────────────────────── */

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

function fakeDocument(numPages: number): Record<string, unknown> {
  return { numPages, getPage: async () => fakePage() }
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
