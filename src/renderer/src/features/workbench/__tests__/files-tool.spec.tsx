import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'
import { subscribeContextItems, type ContextItem } from '@renderer/features/chat/composer-inbox'
import type { WorkbenchRoot } from '../use-workbench-root'
import { FilesTool } from '../FilesTool'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

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
  published = []
  unsubscribe = subscribeContextItems((item) => published.push(item))
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
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
        { name: 'logo.ico', kind: 'file', size: 2048 },
        { name: 'huge.bin', kind: 'file', size: 104857600 }
      ],
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('logo.ico')).toBeInTheDocument())

    bed.bridge.workbench.readFile.mockResolvedValueOnce({ kind: 'binary', size: 2048 })
    fireEvent.click(screen.getByText('logo.ico'))
    expect(await screen.findByTestId('file-preview-binary')).toHaveTextContent('二进制')

    bed.bridge.workbench.readFile.mockResolvedValueOnce({ kind: 'too-large', size: 104857600 })
    fireEvent.click(screen.getByText('huge.bin'))
    expect(await screen.findByTestId('file-preview-large')).toHaveTextContent('文件太大')
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
      limit: 8 * 1024 * 1024
    })
    fireEvent.click(screen.getByText('b.jpg'))
    expect(await screen.findByTestId('file-preview-large')).toHaveTextContent('文件太大')

    bed.bridge.workbench.readBytes.mockResolvedValueOnce({ kind: 'unsupported', size: 9 })
    fireEvent.click(screen.getByText('c.gif'))
    expect(await screen.findByTestId('file-preview-binary')).toHaveTextContent('二进制')
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
      '在文件资源管理器中定位',
      '复制路径'
    ])

    const dirMenu = menuOf('src')
    expect(within(dirMenu).queryByText('添加到上下文')).not.toBeInTheDocument()
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

  it('端到端：文本文件进输入卡的附件条；二进制给人话（复用输入卡的附件口径）', async () => {
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

    // 同一个文件换成二进制：不假装收下，把原因说在输入卡那行
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [{ name: 'logo.ico', kind: 'file', size: 2048 }],
      truncated: false
    })
    bed.bridge.workbench.readFile.mockResolvedValue({ kind: 'binary', size: 2048 })
    fireEvent.click(screen.getByTestId('files-refresh'))
    await waitFor(() => expect(screen.getByText('logo.ico')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('logo.ico'))
    fireEvent.click(screen.getByText('添加到上下文'))

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '未附加：logo.ico（这个格式暂不支持加入上下文）'
      )
    )
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
