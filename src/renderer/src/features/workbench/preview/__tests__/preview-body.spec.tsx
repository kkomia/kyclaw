import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewBody } from '../PreviewBody'
import type { LoadedPreview } from '../fetch'

/* ── 替身：表格只验"接到没接到、参数对不对"（真组件会懒加载 FortuneSheet，不是这套测试要验的） ── */

vi.mock('../dsh-table/ExcelPreview', () => ({
  ExcelPreview: ({ bytes, filename }: { bytes: Uint8Array; filename: string }) => (
    <div
      data-testid="excel-preview-stub"
      data-filename={filename}
      data-size={String(bytes.byteLength)}
    />
  )
}))

/* ── 替身：办公档里嵌着新版 PDF 阅读器（它要 pdfjs 两个模块 + 2D 画布，与 dsh-document 的 spec 同路数） ── */

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

function fakeDocument(numPages = 1): Record<string, unknown> {
  return {
    numPages,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
        scale,
        userUnit: 1
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
      cleanup: () => undefined
    })
  }
}

beforeEach(() => {
  mocks.getDocument.mockReset()
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve(fakeDocument()),
    destroy: async () => undefined
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 办公档那一支的状态：只带转换口（`readPreview` 就是这个形状） */
function officeState(load: (signal: AbortSignal) => Promise<Uint8Array>): LoadedPreview {
  return { mode: 'office', status: 'ready', office: { load, revision: 7 } }
}

describe('PreviewBody：办公档走新版页式阅读器', () => {
  it('转换成功 → 页式阅读器就位；宿主给了确定高度（滚动口在里面才有得滚）', async () => {
    const load = vi.fn(async () => new Uint8Array([1, 2, 3]))

    render(<PreviewBody relative="方案.docx" state={officeState(load)} mode="office" />)

    const host = screen.getByTestId('file-preview-office')
    // 确定高度：预览标签（flex-1 正文）与内联预览（BottomSheet 的 70% 上限）两边都成立
    expect(host).toHaveClass('h-full')
    expect(host).toHaveClass('min-h-0')
    expect(host).toHaveClass('flex')

    await waitFor(() =>
      expect(screen.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'ready')
    )
    expect(screen.getByTestId('dsh-pdf-viewer')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
    // 办公档**不再**走"docx 转 markdown"那条老路
    expect(screen.queryByTestId('file-preview-markdown')).toBeNull()
  })

  it('转换中：先说"正在加载预览…"，不空着（拿到的仍是一个有高度的宿主）', () => {
    // 永不落地的转换：停在加载态
    const load = vi.fn(() => new Promise<Uint8Array>(() => undefined))

    render(<PreviewBody relative="方案.docx" state={officeState(load)} mode="office" />)

    expect(screen.getByTestId('file-preview-office')).toBeInTheDocument()
    expect(screen.getByTestId('dsh-office-loading')).toBeInTheDocument()
  })

  it('ready 但没拿到转换口（不该发生）：如实报，不静默留白', () => {
    render(
      <PreviewBody relative="方案.docx" state={{ mode: 'office', status: 'ready' }} mode="office" />
    )

    expect(screen.getByTestId('file-preview-error')).toHaveTextContent('没拿到转换口')
  })
})

describe('PreviewBody：表格走原始字节 + ExcelPreview', () => {
  it('字节与文件名原样交给 ExcelPreview（后缀由它自己认）', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])

    render(
      <PreviewBody
        relative="台账.xlsx"
        mode="table"
        state={{
          mode: 'table',
          status: 'ready',
          value: { channel: 'table', table: { bytes, format: 'xlsx', size: 5 } }
        }}
      />
    )

    const host = screen.getByTestId('file-preview-table')
    expect(host).toHaveClass('h-full')

    const stub = screen.getByTestId('excel-preview-stub')
    expect(stub).toHaveAttribute('data-filename', '台账.xlsx')
    expect(stub).toHaveAttribute('data-size', '5')
    // 表格**不**走 PDF 阅读器那条路
    expect(screen.queryByTestId('dsh-pdf-viewer')).toBeNull()
  })
})

describe('PreviewBody：独立 PDF 仍是既有入口（缩略图 / 大纲不丢）', () => {
  it('.pdf 交给既有 PdfPreview（不是新版页式阅读器）', async () => {
    render(
      <PreviewBody
        relative="报告.pdf"
        mode="pdf"
        state={{
          mode: 'pdf',
          status: 'ready',
          value: {
            channel: 'bytes',
            bytes: { kind: 'bytes', format: 'pdf', bytes: new Uint8Array([0x25, 0x50]), size: 2 }
          }
        }}
      />
    )

    expect(await screen.findByTestId('pdf-viewer')).toBeInTheDocument()
    // 既有组件自己的侧栏开关与缩放两个落点都在（缩略图/大纲是它那套能力）
    expect(await screen.findByTestId('pdf-sidebar-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('dsh-pdf-viewer')).toBeNull()
  })
})

describe('PreviewBody：加载与失败两态没变', () => {
  it('加载中给 spinner；失败给人话（走既有 ToolError 那个落点）', () => {
    const { unmount } = render(
      <PreviewBody relative="a.pdf" mode="pdf" state={{ mode: 'pdf', status: 'loading' }} />
    )
    expect(screen.getByLabelText('加载中')).toBeInTheDocument()
    unmount()

    render(
      <PreviewBody
        relative="a.pdf"
        mode="pdf"
        state={{ mode: 'pdf', status: 'error', error: '读不出这个 PDF 的内容' }}
      />
    )
    expect(screen.getByTestId('file-preview-error')).toHaveTextContent('读不出这个 PDF')
  })
})
