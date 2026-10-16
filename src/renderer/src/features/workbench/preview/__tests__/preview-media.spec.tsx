import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TextPage, TextPageResult, TextVersionResult } from '@shared/workbench-text'
import { PreviewBody } from '../PreviewBody'
import type { LoadedPreview } from '../fetch'
import type { TextPager } from '../dsh-media/text-pager'

/**
 * PreviewBody 本轮新接的两条：HTML（字节通道 → 静态隔离预览）与纯文本（逐行铺开）。
 *
 * HTML 那一支把真正的渲染器换成替身：本 spec 验的是**接线**（哪条通道、给谁、宿主高度），
 * 清洗器与 iframe 的安全口径由 `dsh-media/__tests__/html.spec.tsx` 用真 DOMPurify 钉住。
 */
vi.mock('../dsh-media/html-viewer', () => ({
  DshHtmlViewer: ({ bytes }: { bytes: Uint8Array }) => (
    <div data-testid="html-viewer-stub" data-size={String(bytes.byteLength)} />
  )
}))

// 代码那一支只验"走的是 code 预览"，不需要真加载 Shiki（高亮是聊天区 CodeBlock 自己的事）
vi.mock('@renderer/features/chat/parts/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <div data-testid="code-block">{code}</div>
}))

function bytesState(
  format: 'html' | 'image-svg' | 'image-png',
  bytes: Uint8Array<ArrayBuffer>
): LoadedPreview {
  return {
    mode: format === 'html' ? 'html' : 'image',
    status: 'ready',
    value: { channel: 'bytes', bytes: { kind: 'bytes', format, bytes, size: bytes.byteLength } }
  }
}

function textState(text: string, truncated = false): LoadedPreview {
  const size = new TextEncoder().encode(text).byteLength
  const page: TextPage = {
    kind: 'page',
    text,
    offset: 0,
    nextOffset: size,
    size,
    version: 'test:0',
    eof: !truncated,
    overlongLine: false
  }
  const pager: TextPager = {
    readPage: vi.fn(async (): Promise<TextPageResult> => ({ kind: 'missing' })),
    version: vi.fn(async (): Promise<TextVersionResult> => ({
      kind: 'version',
      version: 'test:0',
      size
    }))
  }
  return {
    mode: 'text',
    status: 'ready',
    value: { channel: 'text-page', textPage: { page, pager } }
  }
}

describe('PreviewBody：HTML 走静态隔离预览', () => {
  it('字节原样交给 DshHtmlViewer，外面套带确定高度的宿主（iframe 要铺满）', () => {
    const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0x3c, 0x2f, 0x70, 0x3e])
    render(<PreviewBody relative="页面.html" mode="html" state={bytesState('html', bytes)} />)

    const host = screen.getByTestId('file-preview-html')
    expect(host).toHaveClass('h-full')
    expect(host).toHaveClass('min-h-0')
    expect(host).toHaveClass('flex')
    expect(screen.getByTestId('html-viewer-stub')).toHaveAttribute('data-size', '7')
    // 不走 markdown / 文本那条路（html 以前是按代码高亮看的）
    expect(screen.queryByTestId('file-preview-markdown')).toBeNull()
    expect(screen.queryByTestId('file-preview-text')).toBeNull()
  })

  it('.htm 与 .html 同一档（后缀大小写不敏感这条在 modes 里已钉）', () => {
    render(
      <PreviewBody
        relative="旧页面.HTM"
        mode="html"
        state={bytesState('html', new Uint8Array([1]))}
      />
    )
    expect(screen.getByTestId('file-preview-html')).toBeInTheDocument()
  })
})

describe('PreviewBody：纯文本逐行铺开', () => {
  it('文本通道的正文交给 DshTextBody（逐行成块），截断提示仍在外层', () => {
    render(
      <PreviewBody relative="note.txt" mode="text" state={textState('第一行\n第二行', true)} />
    )
    const host = screen.getByTestId('file-preview-text')
    const body = screen.getByTestId('dsh-text-body')
    expect(host).toContainElement(body)
    const lines = body.querySelectorAll('[data-dsh-text-line]')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent('第一行')
    expect(screen.getByText(/只显示前面一部分/)).toBeInTheDocument()
  })

  it('代码那一支不受影响（仍是 code 预览，不进纯文本组件）', () => {
    render(<PreviewBody relative="a.ts" mode="code" state={textState('const a = 1')} />)
    expect(screen.getByTestId('file-preview-code')).toBeInTheDocument()
    expect(screen.queryByTestId('dsh-text-body')).toBeNull()
  })
})

describe('PreviewBody：图片的 svg / ico 也走字节分支', () => {
  it('svg 格式进 ImagePreview（data URL + <img>；SVG 不进 DOM 由 image-body 钉住）', () => {
    render(
      <PreviewBody
        relative="图标.svg"
        mode="image"
        state={bytesState('image-svg', new Uint8Array([1, 2, 3]))}
      />
    )
    const root = screen.getByTestId('file-preview-image')
    expect(root).toHaveAttribute('data-format', 'image-svg')
    const image = root.querySelector('img')
    expect(image?.getAttribute('src')).toBe('data:image/svg+xml;base64,AQID')
    // SVG 标记不进应用 DOM（只有 <img> 这个引用）
    expect(root.querySelector('svg')).toBeNull()
  })
})
