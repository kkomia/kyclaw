import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'
import { subscribeContextItems, type ContextItem } from '@renderer/features/chat/composer-inbox'
import { useShellStore } from '@renderer/lib/shell-store'
import type { WorkbenchRoot } from '../use-workbench-root'
import { useWorkbenchStore } from '../workbench-store'
import { FilesTool } from '../FilesTool'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

/**
 * 表格那一支：真组件会懒加载 FortuneSheet（jsdom 里不是这套测试要验的东西）——
 * 这里只验"接线接到了没、参数对不对"（C 的组件自己有规格）。
 * 注意路径是从**本文件**算的：`preview/dsh-table/ExcelPreview`。
 */
vi.mock('../preview/dsh-table/ExcelPreview', () => ({
  ExcelPreview: ({ bytes, filename }: { bytes: Uint8Array; filename: string }) => (
    <div
      data-testid="excel-preview-stub"
      data-filename={filename}
      data-size={String(bytes.byteLength)}
    />
  )
}))

/**
 * 办公档那一支里嵌着新版页式阅读器，而它要 pdfjs 的两个模块（与 dsh-document 的 spec 同路数）：
 * 不真起 pdfjs、也不真画（jsdom 没有 2D 上下文），只验接线与调用参数。
 */
const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn() }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => pdfjs.getDocument(...args)
}))

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    readonly div = document.createElement('div')
    render(): Promise<void> {
      return Promise.resolve()
    }
    cancel(): void {
      this.div.replaceChildren()
    }
  }
}))

/**
 * 文件工具：懒加载目录树（点开才列子层）、单击预览、自绘右键菜单（打开 / 复制路径）。
 * 主进程通道用桥的桩顶掉：这里只验渲染端的行为与调用参数（containment 在主进程侧已单测）。
 *
 * round 42 追加：右键「添加到上下文」与预览选中的「添加到上下文（摘选）」——
 * 走 composer-inbox 的事件通道，端到端那两条用真 Composer 一起渲染（附件 chip / 人话）。
 */
let bed: Bed

/** 本文件里发布出去的事件（each 用例自己订阅、用例结束退订） */
let published: ContextItem[]
let unsubscribe: (() => void) | null = null

function rootOf(): WorkbenchRoot {
  return {
    threadId: 'thread-1',
    rootPath: 'D:\\工作区',
    rootName: '工作区',
    ready: true,
    settling: false,
    notice: null,
    workbench: bed.bridge.workbench,
    terminal: bed.bridge.terminal
  }
}

beforeEach(() => {
  bed = setupWorkbench()
  bed.bridge.workbench.listDir.mockResolvedValue({
    entries: [
      { name: 'src', kind: 'dir', size: 0 },
      { name: 'README.md', kind: 'file', size: 9 }
    ],
    truncated: false
  })
  // 办公档：默认给一份"转好了"的回包（用例要失败态自己 mockResolvedValue 覆盖）
  pdfjs.getDocument.mockReset()
  pdfjs.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
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
    }),
    destroy: async () => undefined
  })
  bed.bridge.workbench.officePdf.mockResolvedValue({
    kind: 'pdf',
    path: '方案.docx',
    version: 'v1',
    pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    size: 4,
    missingFonts: [],
    generation: 'g1'
  })
  // jsdom 没有 2D 上下文：显式钉成 null（既有 PdfPreview 据此跳过真画、仍记账页数；
  // 新版阅读器会按"这一页画不出来"收场 —— 两边的断言都只看接线，不看像素）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  published = []
  unsubscribe = subscribeContextItems((item) => published.push(item))
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
  vi.restoreAllMocks()
  teardownWorkbench()
})

describe('FilesTool：目录树', () => {
  it('挂载即列根目录，目录与文件各一行（目录不显示体积）', async () => {
    render(<FilesTool root={rootOf()} />)

    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument())
    expect(bed.bridge.workbench.listDir).toHaveBeenCalledWith('thread-1', '')

    const rows = screen.getAllByTestId('file-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-kind', 'dir')
    expect(rows[0]).toHaveAttribute('data-relative', 'src')
    expect(rows[1]).toHaveAttribute('data-kind', 'file')
    expect(within(rows[1] as HTMLElement).getByText('9 B')).toBeInTheDocument()
    // round 56：文件行按文件类型给彩色图标（`data-file-icon` 是档）；目录行原样不动
    // （展开箭头 + lucide 文件夹，两个都不是 data-file-icon）
    expect(rows[1].querySelector('svg')?.getAttribute('data-file-icon')).toBe('markdown')
    expect(rows[0].querySelectorAll('[data-file-icon]')).toHaveLength(0)
    expect(rows[0].querySelectorAll('svg')[1]?.getAttribute('class')).toContain('lucide-folder')
  })

  it('展开目录才列子层（懒加载），收起不改状态', async () => {
    bed.bridge.workbench.listDir.mockImplementation(async (_threadId, relative) =>
      relative === ''
        ? { entries: [{ name: 'src', kind: 'dir', size: 0 }], truncated: false }
        : { entries: [{ name: 'index.ts', kind: 'file', size: 10 }], truncated: false }
    )
    render(<FilesTool root={rootOf()} />)

    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument())
    expect(bed.bridge.workbench.listDir).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('src'))
    await waitFor(() =>
      expect(bed.bridge.workbench.listDir).toHaveBeenCalledWith('thread-1', 'src')
    )
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())

    fireEvent.click(screen.getByText('src'))
    expect(screen.getAllByTestId('file-row')[0]).toHaveAttribute('data-open', 'false')
    expect(bed.bridge.workbench.listDir).toHaveBeenCalledTimes(2)
  })

  it('刷新按钮重列根目录', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(bed.bridge.workbench.listDir).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('files-refresh'))
    await waitFor(() => expect(bed.bridge.workbench.listDir).toHaveBeenCalledTimes(2))
  })

  it('列目录失败：把主进程的人话露出来（不静默空树）', async () => {
    bed.bridge.workbench.listDir.mockRejectedValue(
      new Error(
        "Error invoking remote method 'workbench:list-dir': Error: 路径不可用：目标路径在工作区之外"
      )
    )
    render(<FilesTool root={rootOf()} />)

    await waitFor(() =>
      expect(screen.getByTestId('files-error')).toHaveTextContent(
        '路径不可用：目标路径在工作区之外'
      )
    )
  })
})

describe('FilesTool：单击预览', () => {
  it('单击文件读回文本并内联显示（含截断提示）', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'notes.txt', kind: 'file', size: 4096 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 4096,
      truncated: true
    })
    render(<FilesTool root={rootOf()} />)

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('notes.txt'))

    await waitFor(() =>
      expect(bed.bridge.workbench.readFile).toHaveBeenCalledWith('thread-1', 'notes.txt')
    )
    const preview = await screen.findByTestId('file-preview')
    expect(within(preview).getByTestId('file-preview-text')).toHaveTextContent('export {}')
    expect(within(preview).getByText(/只显示前面一部分/)).toBeInTheDocument()
  })

  it('二进制 / 超大文件给人话，不吐乱码', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [
        { name: 'blob.bin', kind: 'file', size: 2048 },
        { name: 'huge.bin', kind: 'file', size: 104857600 }
      ],
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('blob.bin')).toBeInTheDocument())

    bed.bridge.workbench.readFile.mockResolvedValueOnce({ kind: 'binary', size: 2048 })
    fireEvent.click(screen.getByText('blob.bin'))
    // 文本分页通道把"二进制"翻成人话走错误落点（与表格那条同一口径）
    expect(await screen.findByTestId('file-preview-error')).toHaveTextContent('二进制')

    bed.bridge.workbench.readFile.mockResolvedValueOnce({ kind: 'too-large', size: 104857600 })
    fireEvent.click(screen.getByText('huge.bin'))
    expect(await screen.findByTestId('file-preview-error')).toHaveTextContent('文件太大')
  })

  it('读不了的文件：把错误露在预览层里', async () => {
    bed.bridge.workbench.readFile.mockRejectedValue(new Error('这个文件不在磁盘上了'))
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.click(screen.getByText('README.md'))
    expect(await screen.findByTestId('file-preview-error')).toHaveTextContent(
      '这个文件不在磁盘上了'
    )
  })
})

describe('round 50 · 在新标签页中查看（双击 / 右键）', () => {
  it('双击文件：开预览标签并开面板；单击那一档原样不动（内联预览照旧）', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'notes.txt', kind: 'file', size: 12 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '正文\n',
      size: 12,
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument())

    // 用户实报路径：真机双击 = 两次 click 之后再来一次 dblclick；单击本身照旧只走内联预览
    const row = screen.getByText('notes.txt')
    fireEvent.click(row)
    expect(await screen.findByTestId('file-preview-text')).toHaveTextContent('正文')

    // 面板先收着：双击要把它打开（否则新标签在收起的面板里看不见）
    useShellStore.setState({ workPanelOpen: false })
    fireEvent.doubleClick(row)

    const tabs = useWorkbenchStore.getState().tabs
    expect(tabs.map((tab) => tab.kind)).toEqual(['preview'])
    expect(tabs[0]?.path).toBe('notes.txt')
    expect(tabs[0]?.title).toBe('notes.txt')
    expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[0]?.id)
    expect(useShellStore.getState().workPanelOpen).toBe(true)
    // 单击那条链没被顶掉：内联预览还开着
    expect(screen.getByTestId('file-preview')).toBeInTheDocument()
  })

  it('右键文件的菜单里有「在新标签页中查看」，点了就开；目录的那份没有这一项', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('README.md'))
    const item = screen.getByTestId('workbench-context-menu-preview')
    expect(item).toHaveTextContent('在新标签页中查看')
    fireEvent.click(item)

    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.kind)).toEqual(['preview'])
    expect(useWorkbenchStore.getState().tabs[0]?.path).toBe('README.md')

    // 目录：菜单里没有这一项（标签看的是文件内容）
    fireEvent.contextMenu(screen.getByText('src'))
    expect(screen.queryByTestId('workbench-context-menu-preview')).not.toBeInTheDocument()
  })
})

describe('FilesTool：按格式路由', () => {
  it('.md 走 markdown 渲染器（内容仍来自文本通道）', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '# 一级标题\n\n- 第一项\n',
      size: 24,
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.click(screen.getByText('README.md'))
    const body = await screen.findByTestId('file-preview-markdown')
    expect(body.querySelector('h1')?.textContent).toBe('一级标题')
    expect(body.querySelectorAll('li')).toHaveLength(1)
    // markdown 走的是文本通道，不该去拉字节
    expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
  })

  it('图片走字节通道并画成 data URL', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: '图片.png', kind: 'file', size: 4 }],
      truncated: false
    })
    bed.bridge.workbench.readBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'image-png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      size: 4
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('图片.png')).toBeInTheDocument())

    fireEvent.click(screen.getByText('图片.png'))
    await waitFor(() =>
      expect(bed.bridge.workbench.readBytes).toHaveBeenCalledWith('thread-1', '图片.png')
    )
    const image = (await screen.findByTestId('file-preview-image')).querySelector('img')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
    expect(bed.bridge.workbench.readFile).not.toHaveBeenCalled()
    // 图片这一档也要确定高度（"适应窗口"要吃视口高）：BottomSheet 走 sized 口径（55vh），
    // 不能是"内容撑高 + 70% 上限"（那样子层 h-full 退化成 auto，量到的视口高就是内容自己的高）
    expect(screen.getByTestId('file-preview')).toHaveClass('h-[55vh]')
  })

  it('PDF 走字节通道（渲染交给 PdfPreview）', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: '报告.pdf', kind: 'file', size: 5 }],
      truncated: false
    })
    bed.bridge.workbench.readBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      size: 5
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('报告.pdf')).toBeInTheDocument())

    fireEvent.click(screen.getByText('报告.pdf'))
    await waitFor(() =>
      expect(bed.bridge.workbench.readBytes).toHaveBeenCalledWith('thread-1', '报告.pdf')
    )
    expect(await screen.findByTestId('file-preview-pdf')).toBeInTheDocument()
  })

  it('字节通道的三个人话态：没了 / 太大 / 认不出', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [
        { name: 'a.png', kind: 'file', size: 1 },
        { name: 'b.jpg', kind: 'file', size: 1 },
        { name: 'c.gif', kind: 'file', size: 1 }
      ],
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('a.png')).toBeInTheDocument())

    bed.bridge.workbench.readBytes.mockResolvedValueOnce({ kind: 'missing' })
    fireEvent.click(screen.getByText('a.png'))
    expect(await screen.findByTestId('file-preview-missing')).toHaveTextContent('不在磁盘上')

    bed.bridge.workbench.readBytes.mockResolvedValueOnce({
      kind: 'too-large',
      size: 40 * 1024 * 1024,
      limit: 30 * 1024 * 1024
    })
    fireEvent.click(screen.getByText('b.jpg'))
    expect(await screen.findByTestId('file-preview-large')).toHaveTextContent('文件太大')

    bed.bridge.workbench.readBytes.mockResolvedValueOnce({ kind: 'unsupported', size: 9 })
    fireEvent.click(screen.getByText('c.gif'))
    expect(await screen.findByTestId('file-preview-binary')).toHaveTextContent('二进制')
  })
})

describe('round 43 · 办公与代码场景的路由', () => {
  /** 只列一个文件并点开它（各用例自己喂 readFile / readBytes 的返回值） */
  async function openOnly(name: string): Promise<void> {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name, kind: 'file', size: 1234 }],
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument())
    fireEvent.click(screen.getByText(name))
  }

  it('代码文件走高亮（仍是文本通道：截断提示与位置定位都还在）', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'const answer: number = 42\n',
      size: 4096,
      truncated: true
    })
    await openOnly('index.ts')

    const body = await screen.findByTestId('file-preview-code')
    const block = await within(body).findByTestId('code-block')
    expect(block).toHaveAttribute('data-language', 'typescript')
    // 截断提示仍在外层（文本通道那一套，原样复用）
    expect(screen.getByText(/只显示前面一部分/)).toBeInTheDocument()
    expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
  })

  it('没打包语法的扩展名（.log）回落 <pre> 纯文本：行为与以前一致', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '2026-10-12 一条日志\n',
      size: 32,
      truncated: false
    })
    await openOnly('run.log')

    expect(await screen.findByTestId('file-preview-text')).toHaveTextContent('一条日志')
    expect(screen.queryByTestId('file-preview-code')).toBeNull()
  })

  it('docx 走办公档页式预览（主进程转 PDF，不再抽 markdown）', async () => {
    await openOnly('方案.docx')

    await waitFor(() => expect(bed.bridge.workbench.officePdf).toHaveBeenCalledTimes(1))
    const [threadId, relative, priority, requestId] =
      bed.bridge.workbench.officePdf.mock.calls[0] ?? []
    expect([threadId, relative, priority]).toEqual(['thread-1', '方案.docx', 'foreground'])
    expect(typeof requestId).toBe('string')

    expect(await screen.findByTestId('dsh-office-viewer')).toBeInTheDocument()
    expect(await screen.findByTestId('dsh-pdf-viewer')).toBeInTheDocument()
    // 老那两条通道都不该被碰，markdown 结构档也不该再出现
    expect(bed.bridge.workbench.readFile).not.toHaveBeenCalled()
    expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
    expect(screen.queryByTestId('file-preview-markdown')).toBeNull()
  })

  it('xlsx：整份原始字节交给渲染端的 ExcelPreview（不走办公档 PDF 管线）', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x05])
    bed.bridge.workbench.tableBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'xlsx',
      bytes,
      size: bytes.byteLength
    })
    await openOnly('台账.xlsx')

    const host = await screen.findByTestId('file-preview-table')
    expect(host).toHaveClass('h-full')

    const stub = within(host).getByTestId('excel-preview-stub')
    expect(stub).toHaveAttribute('data-filename', '台账.xlsx')
    expect(stub).toHaveAttribute('data-size', '5')
    expect(bed.bridge.workbench.tableBytes).toHaveBeenCalledWith('thread-1', '台账.xlsx')
    expect(bed.bridge.workbench.officePdf).not.toHaveBeenCalled()
    expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
  })

  it('csv 走同一条表格通道（格式由主进程按文件头认定）', async () => {
    const bytes = new Uint8Array([0x61, 0x2c, 0x62])
    bed.bridge.workbench.tableBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'csv',
      bytes,
      size: bytes.byteLength
    })
    await openOnly('名单.csv')

    const stub = await screen.findByTestId('excel-preview-stub')
    expect(stub).toHaveAttribute('data-filename', '名单.csv')
    expect(bed.bridge.workbench.tableBytes).toHaveBeenCalledWith('thread-1', '名单.csv')
  })

  it('pptx 也走办公档页式预览（不再只给逐页文字提要）', async () => {
    bed.bridge.workbench.officePdf.mockResolvedValue({
      kind: 'pdf',
      path: '汇报.pptx',
      version: 'v2',
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      size: 4,
      missingFonts: ['方正兰亭黑'],
      generation: 'g1'
    })
    await openOnly('汇报.pptx')

    expect(await screen.findByTestId('dsh-office-viewer')).toBeInTheDocument()
    // 缺字体如实提示一句（不假装和原稿一致）
    expect(await screen.findByTestId('dsh-office-font-notice')).toHaveTextContent('方正兰亭黑')
    expect(screen.queryByTestId('file-preview-pptx')).toBeNull()
  })

  it('旧版 .doc / .ppt 也走办公档（不再给"另存为"的人话）；旧版 .xls 走表格通道', async () => {
    for (const name of ['旧方案.doc', '旧汇报.ppt']) {
      bed.bridge.workbench.listDir.mockResolvedValue({
        entries: [{ name, kind: 'file', size: 4096 }],
        truncated: false
      })
      const { unmount } = render(<FilesTool root={rootOf()} />)
      await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument())
      fireEvent.click(screen.getByText(name))

      expect(await screen.findByTestId('dsh-office-viewer')).toBeInTheDocument()
      expect(screen.queryByTestId('file-preview-legacy')).toBeNull()
      expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
      unmount()
    }

    bed.bridge.workbench.tableBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'xls',
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      size: 4
    })
    await openOnly('旧台账.xls')
    expect(await screen.findByTestId('excel-preview-stub')).toHaveAttribute(
      'data-filename',
      '旧台账.xls'
    )
    expect(bed.bridge.workbench.tableBytes).toHaveBeenCalledWith('thread-1', '旧台账.xls')
  })
})

describe('round 44 · 搜索', () => {
  /** 点开搜索行（面板是常驻 DOM 的，靠 data-open 判开关） */
  function openSearch(): HTMLElement {
    fireEvent.click(screen.getByTestId('files-search'))
    return screen.getByTestId('files-search-input')
  }

  it('搜索钮展开搜索行；查询不够长就还是树；关掉回树', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    const panel = screen.getByTestId('files-search-panel')
    expect(panel).toHaveAttribute('data-open', 'false')

    const input = openSearch()
    expect(panel).toHaveAttribute('data-open', 'true')

    // 一个字（trim 后）不够：不发请求、内容区仍然是树
    fireEvent.change(input, { target: { value: ' a ' } })
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    expect(bed.bridge.workbench.search).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('files-search-close'))
    expect(panel).toHaveAttribute('data-open', 'false')
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('防抖：打字期间一个请求都不发，停下来才用最后的词发一次', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    const input = openSearch()
    fireEvent.change(input, { target: { value: 'in' } })
    fireEvent.change(input, { target: { value: 'inde' } })
    expect(bed.bridge.workbench.search).not.toHaveBeenCalled()

    await waitFor(() => expect(bed.bridge.workbench.search).toHaveBeenCalledTimes(1))
    expect(bed.bridge.workbench.search).toHaveBeenCalledWith('thread-1', 'inde', 'name')
  })

  it('文件名命中：名字 + 相对路径；点击打开该文件的预览', async () => {
    bed.bridge.workbench.search.mockResolvedValue({
      results: [{ path: 'src/deep/中文名.txt', name: '中文名.txt' }],
      truncated: false,
      scanned: 12
    })
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '这里有一段中文\n',
      size: 21,
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.change(openSearch(), { target: { value: '中文' } })

    const hit = await screen.findByTestId('file-search-hit')
    expect(within(hit).getByText('中文名.txt')).toBeInTheDocument()
    expect(within(hit).getByTestId('file-search-path')).toHaveTextContent('src/deep/中文名.txt')
    // 命中行的图标也按文件类型（`hit.path` 就是相对路径）
    expect(hit.querySelector('svg')?.getAttribute('data-file-icon')).toBe('txt')

    fireEvent.click(hit)
    await waitFor(() =>
      expect(bed.bridge.workbench.readFile).toHaveBeenCalledWith('thread-1', 'src/deep/中文名.txt')
    )
    expect(await screen.findByTestId('file-preview-text')).toHaveTextContent('这里有一段中文')
  })

  it('内容命中：行号 + 该行预览 + 截断标注；回车打开第一条', async () => {
    bed.bridge.workbench.search.mockResolvedValue({
      results: [
        { path: 'src/index.ts', name: 'index.ts', line: 2, preview: '// TODO 搜索我' },
        { path: 'src/other.ts', name: 'other.ts', line: 9, preview: '// TODO 另一处' }
      ],
      truncated: true,
      scanned: 30
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    const input = openSearch()
    fireEvent.click(screen.getByTestId('files-search-mode-content'))
    expect(screen.getByTestId('files-search-mode-content')).toHaveAttribute('data-active', 'true')
    fireEvent.change(input, { target: { value: 'todo' } })
    await waitFor(() =>
      expect(bed.bridge.workbench.search).toHaveBeenCalledWith('thread-1', 'todo', 'content')
    )
    const hits = await screen.findAllByTestId('file-search-hit')
    expect(hits).toHaveLength(2)
    expect(hits[0]).toHaveAttribute('data-line', '2')
    expect(within(hits[0] as HTMLElement).getByText('第 2 行')).toBeInTheDocument()
    expect(within(hits[0] as HTMLElement).getByTestId('file-search-preview')).toHaveTextContent(
      '// TODO 搜索我'
    )
    expect(screen.getByTestId('files-search-truncated')).toHaveTextContent('只搜了一部分')

    // 回车 = 打开第一条命中
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(bed.bridge.workbench.readFile).toHaveBeenCalledWith('thread-1', 'src/index.ts')
    )

    // Esc（焦点这时在输入框）关掉搜索回树
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByTestId('files-search-panel')).toHaveAttribute('data-open', 'false')
    expect(screen.queryByTestId('file-search-hit')).not.toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()

    // 再来一次：这回焦点在结果行上，Esc 同样关掉
    fireEvent.change(openSearch(), { target: { value: 'todo' } })
    const again = await screen.findAllByTestId('file-search-hit')
    fireEvent.keyDown(again[0] as HTMLElement, { key: 'Escape' })
    expect(screen.getByTestId('files-search-panel')).toHaveAttribute('data-open', 'false')
    expect(screen.queryByTestId('file-search-hit')).not.toBeInTheDocument()
  })

  it('空结果与通道失败都给人话', async () => {
    bed.bridge.workbench.search.mockResolvedValue({ results: [], truncated: false, scanned: 8 })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.change(openSearch(), { target: { value: '没有这个' } })
    expect(await screen.findByTestId('files-search-empty')).toHaveTextContent(
      '没有找到匹配的文件名'
    )

    bed.bridge.workbench.search.mockRejectedValue(
      new Error(
        "Error invoking remote method 'workbench:search': Error: 路径不可用：目标路径在工作区之外"
      )
    )
    fireEvent.change(screen.getByTestId('files-search-input'), { target: { value: '再来一次' } })
    expect(await screen.findByTestId('files-search-error')).toHaveTextContent(
      '路径不可用：目标路径在工作区之外'
    )
  })

  it('搜索中给加载态；Esc 关掉搜索回树（查询也清掉）', async () => {
    let release: (value: { results: never[]; truncated: boolean; scanned: number }) => void = () =>
      undefined
    bed.bridge.workbench.search.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    const input = openSearch()
    fireEvent.change(input, { target: { value: '慢慢来' } })
    await waitFor(() => expect(bed.bridge.workbench.search).toHaveBeenCalledTimes(1))
    // 还没回：结果区给加载态（树不再顶上来）
    await waitFor(() => expect(screen.queryByText('README.md')).not.toBeInTheDocument())

    release({ results: [], truncated: false, scanned: 1 })
    await screen.findByTestId('files-search-empty')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByTestId('files-search-panel')).toHaveAttribute('data-open', 'false')
    expect((screen.getByTestId('files-search-input') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })
})

describe('FilesTool：自绘右键菜单', () => {
  it('右键出菜单：在文件资源管理器中定位 / 复制路径', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('README.md'))
    const menu = screen.getByTestId('workbench-context-menu')
    expect(within(menu).getByText('在文件资源管理器中定位')).toBeInTheDocument()

    fireEvent.click(within(menu).getByText('复制路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('D:\\工作区\\README.md'))
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()
  })

  it('目录的那条是「打开」，点了走 reveal 通道', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('src'))
    fireEvent.click(screen.getByText('在文件资源管理器中打开'))

    await waitFor(() => expect(bed.bridge.workbench.reveal).toHaveBeenCalledWith('thread-1', 'src'))
  })

  /* round 77：把文件交给本机默认应用 */
  it('「用本地应用打开」走 workbench:open；目录没有这一项（打开文件夹是 reveal 的事）', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('README.md'))
    fireEvent.click(screen.getByText('用本地应用打开'))

    await waitFor(() =>
      expect(bed.bridge.workbench.open).toHaveBeenCalledWith('thread-1', 'README.md')
    )
    // 与 reveal 是两条通道：打开文件不该顺手去定位
    expect(bed.bridge.workbench.reveal).not.toHaveBeenCalled()

    fireEvent.contextMenu(screen.getByText('src'))
    expect(screen.queryByText('用本地应用打开')).not.toBeInTheDocument()
  })

  it('打开失败：把主进程的人话露在预览层里（与读不了同一档，不假装打开）', async () => {
    bed.bridge.workbench.open.mockRejectedValue(
      new Error(
        "Error invoking remote method 'workbench:open': Error: 打不开这个文件（系统没能用默认应用打开它）：没有与此文件关联的应用"
      )
    )
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('README.md'))
    fireEvent.click(screen.getByText('用本地应用打开'))

    expect(await screen.findByTestId('file-preview-error')).toHaveTextContent(
      '打不开这个文件（系统没能用默认应用打开它）'
    )
  })

  it('Esc 关掉菜单；滚轮与外面点击也关；程序化的 scroll（不是用户手势）不关', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    const open = (): void => {
      fireEvent.contextMenu(screen.getByText('README.md'))
      expect(screen.getByTestId('workbench-context-menu')).toBeInTheDocument()
    }

    // 打开菜单前为把目标行滚进视口触发的那次滚动是**异步补发**的，不能把刚开的菜单关掉
    open()
    fireEvent.scroll(window)
    expect(screen.getByTestId('workbench-context-menu')).toBeInTheDocument()

    fireEvent.wheel(window)
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()

    open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()

    open()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()
  })
})

describe('round 42 · 右键「添加到上下文」', () => {
  function menuOf(label: string): HTMLElement {
    fireEvent.contextMenu(screen.getByText(label))
    return screen.getByTestId('workbench-context-menu')
  }

  it('文件的那份菜单**首项**是「添加到上下文」；目录的菜单里没有这一项', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    const fileMenu = menuOf('README.md')
    const items = within(fileMenu).getAllByRole('menuitem')
    expect(items[0]).toHaveTextContent('添加到上下文')
    expect(items.map((item) => item.textContent)).toEqual([
      '添加到上下文',
      // round 50：文件的菜单里多一项「在新标签页中查看」（目录没有，见下）
      '在新标签页中查看',
      // round 77：用本机装的 Word / WPS / Excel 打开（目录没有这一项）
      '用本地应用打开',
      '在文件资源管理器中定位',
      '复制路径'
    ])

    const dirMenu = menuOf('src')
    expect(within(dirMenu).queryByText('添加到上下文')).not.toBeInTheDocument()
    expect(within(dirMenu).queryByText('在新标签页中查看')).not.toBeInTheDocument()
    expect(within(dirMenu).queryByText('用本地应用打开')).not.toBeInTheDocument()
    expect(within(dirMenu).getAllByRole('menuitem')).toHaveLength(2)
  })

  it('点它：发布一条 file 事件（只报会话 + 相对路径 + 名字，不读文件）', async () => {
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('README.md'))
    fireEvent.click(screen.getByText('添加到上下文'))

    expect(published).toEqual([
      { source: 'file', threadId: 'thread-1', relative: 'README.md', name: 'README.md' }
    ])
    expect(bed.bridge.workbench.readFile).not.toHaveBeenCalled()
  })

  it('真实鼠标路径：pointerdown → click 才落到菜单项上（用户实报"点了没反应"）', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 10,
      truncated: false
    })
    render(
      <>
        <FilesTool root={rootOf()} />
        <Composer threadId="thread-1" onSend={vi.fn()} onStop={vi.fn()} />
      </>
    )
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('README.md'))
    const item = screen.getByText('添加到上下文')

    // 真机顺序：先 pointerdown 落在菜单项上，松手之后才有 click。
    // 捕获阶段的 pointerdown 若先把菜单卸掉，click 就落在空气上 → 输入框不会有任何反应。
    fireEvent.pointerDown(item)
    fireEvent.click(item)

    expect(published).toHaveLength(1)
    expect(await screen.findByTestId('composer-attachment-README.md')).toBeInTheDocument()

    // 既有条目同一条路（同一根因，不是「添加到上下文」独有）：复制路径 = 关掉菜单 + 写剪贴板
    fireEvent.contextMenu(within(screen.getByTestId('files-tool')).getByText('README.md'))
    const copyItem = screen.getByText('复制路径')
    fireEvent.pointerDown(copyItem)
    fireEvent.click(copyItem)
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()
  })

  it('端到端：文本文件进输入卡的附件条；二进制（round 53）退回路径引用、不再拒收', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 10,
      truncated: false
    })
    render(
      <>
        <FilesTool root={rootOf()} />
        <Composer threadId="thread-1" onSend={vi.fn()} onStop={vi.fn()} />
      </>
    )
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('README.md'))
    fireEvent.click(screen.getByText('添加到上下文'))

    const chip = await screen.findByTestId('composer-attachment-README.md')
    expect(chip).toHaveTextContent('10 B')

    // 同一个文件换成二进制：round 53 起不拒收——载荷退回**相对路径引用**（chip 照常进附件条，无 notice）
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'blob.bin', kind: 'file', size: 2048 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({ kind: 'binary', size: 2048 })
    fireEvent.click(screen.getByTestId('files-refresh'))
    await waitFor(() => expect(screen.getByText('blob.bin')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('blob.bin'))
    fireEvent.click(screen.getByText('添加到上下文'))

    const binaryChip = await screen.findByTestId('composer-attachment-blob.bin')
    expect(binaryChip).toHaveTextContent('2.0 KB')
    expect(binaryChip).toHaveAttribute('title', 'blob.bin')
    expect(screen.queryByTestId('composer-notice')).not.toBeInTheDocument()
  })
})

describe('round 42 · 预览区选中文字的自绘右键菜单', () => {
  /** 预览体的文本节点（右键与选区都打在它身上） */
  function selectAllInPreview(): void {
    const body = screen.getByTestId('file-preview-body')
    const range = document.createRange()
    range.selectNodeContents(body)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  async function openTextPreview(): Promise<void> {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'notes.txt', kind: 'file', size: 10 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 10,
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('notes.txt'))
    await screen.findByTestId('file-preview-text')
  }

  it('原生菜单被拦掉（整块预览区都拦，不只是选中文字那一小块）', async () => {
    await openTextPreview()

    // fireEvent 返回 false = 组件的 preventDefault 生效了
    expect(fireEvent.contextMenu(screen.getByTestId('file-preview-text'))).toBe(false)
    // 标题条那块也拦（右键不会漏出浏览器的自带菜单）
    expect(fireEvent.contextMenu(screen.getByTestId('file-preview'))).toBe(false)
  })

  it('没有选区：菜单只有「全选」（不摆点了没用的项）', async () => {
    await openTextPreview()
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    const menu = screen.getByTestId('workbench-context-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['全选'])
  })

  it('有选区：[添加到上下文（摘选）/ 复制 / 全选]；点摘选发布 selection 事件', async () => {
    await openTextPreview()
    selectAllInPreview()

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    const menu = screen.getByTestId('workbench-context-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['添加到上下文（摘选）', '复制', '全选'])

    fireEvent.click(within(menu).getByText('添加到上下文（摘选）'))

    expect(published).toHaveLength(1)
    const event = published[0]
    expect(event.source).toBe('selection')
    expect(event.threadId).toBe('thread-1')
    expect(event.relative).toBe('notes.txt')
    expect(event.name).toBe('notes.txt 摘选')
    expect(event.source === 'selection' && event.text).toContain('export {}')
    // round 42 二轮：发布方在源文在手时把**位置**算好（文本预览是源文保真）
    expect(event.source === 'selection' && event.lines).toEqual({ start: 1, end: 1 })
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()
  })

  it('markdown 预览：选区形状变了也能尽力定位（首行/末行各自在源文里找）', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'README.md', kind: 'file', size: 24 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '# 一级标题\n\n- 第一项\n',
      size: 24,
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    fireEvent.click(screen.getByText('README.md'))
    await screen.findByTestId('file-preview-markdown')

    selectAllInPreview()
    fireEvent.contextMenu(screen.getByTestId('file-preview-markdown'))
    fireEvent.click(screen.getByText('添加到上下文（摘选）'))

    expect(published).toHaveLength(1)
    const event = published[0]
    expect(event.source).toBe('selection')
    expect(event.source === 'selection' ? event.text : '').toContain('一级标题')
    // 渲染后没有 `#` / `- `，整段对不上：首行（源文第 1 行）与末行（源文第 3 行）各自定位
    expect(event.source === 'selection' ? event.lines : undefined).toEqual({ start: 1, end: 3 })
  })

  it('选区落在源文里没有的文字上（截断提示那一行）：**不带位置**', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'big.txt', kind: 'file', size: 12288 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 12288,
      truncated: true
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('big.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('big.txt'))
    await screen.findByTestId('file-preview-text')

    // 只选"只显示前面一部分（共 …）"那行——它是预览加的，源文里没有
    const note = screen.getByText(/只显示前面一部分/)
    const range = document.createRange()
    range.selectNodeContents(note)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    fireEvent.click(screen.getByText('添加到上下文（摘选）'))

    expect(published).toHaveLength(1)
    const event = published[0]
    expect(event.source === 'selection' ? event.text : '').toContain('只显示前面一部分')
    expect('lines' in event).toBe(false)
  })

  it('有选区时「复制」把选中的文字写进剪贴板', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await openTextPreview()
    selectAllInPreview()

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    fireEvent.click(screen.getByText('复制'))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('export {}'))
    )
  })

  it('「全选」把预览内容选上（选区就绪 → 再右键出现摘选那两项）', async () => {
    await openTextPreview()
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    fireEvent.click(screen.getByText('全选'))

    expect(window.getSelection()?.toString()).toContain('export {}')

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    expect(
      within(screen.getByTestId('workbench-context-menu')).getByText('添加到上下文（摘选）')
    ).toBeInTheDocument()
  })

  it('端到端：摘选进输入卡成引用卡（路径 + 行号）；发送载荷是【引用】文件 + 围栏内容', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'notes.txt', kind: 'file', size: 10 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 10,
      truncated: false
    })
    const onSend = vi.fn()
    render(
      <>
        <FilesTool root={rootOf()} />
        <Composer threadId="thread-1" onSend={onSend} onStop={vi.fn()} />
      </>
    )
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('notes.txt'))
    await screen.findByTestId('file-preview-text')

    // 走**真机那条鼠标路径**：右键 → pointerdown(菜单项) → click
    selectAllInPreview()
    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    const item = screen.getByText('添加到上下文（摘选）')
    fireEvent.pointerDown(item)
    fireEvent.click(item)

    const card = await screen.findByTestId('composer-attachment-notes.txt 摘选')
    expect(card).toHaveAttribute('data-quote', 'true')
    expect(card).toHaveTextContent('引用')
    // 卡上是**相对路径**（不是裸文件名）+ 行号
    expect(card).toHaveTextContent('notes.txt')
    expect(screen.getByTestId('composer-quote-lines')).toHaveTextContent('第 1–1 行')
    // 只拉过一次预览的文本通道，发布方没有额外读文件
    expect(bed.bridge.workbench.readFile).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('composer-send'))
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({
      text: '【引用】文件：notes.txt（第 1–1 行）\n```\nexport {}\n```'
    })
  })
})
