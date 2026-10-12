import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'
import { subscribeContextItems, type ContextItem } from '@renderer/features/chat/composer-inbox'
import type { WorkbenchRoot } from '../use-workbench-root'
import { PreviewTool } from '../PreviewTool'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

/**
 * 预览标签：与「文件」工具里单击的内联预览是**同一套管线**（同一个 preview/fetch + PreviewBody），
 * 这里按既有 preview specs 的口径挑几个代表验"这个新入口也这么分流"：md / 图片 / 代码 / 二进制人话，
 * 另加"读不了的路径给人话"和"重新读取"。
 *
 * 渲染器本身（markdown / 图片 / PDF / 表格 / 代码高亮）已由 preview/__tests__ 与 files-tool.spec 覆盖。
 */
let bed: Bed

beforeEach(() => {
  bed = setupWorkbench()
})

afterEach(() => {
  teardownWorkbench()
})

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

describe('PreviewTool：按格式分流（与内联预览同一套口径）', () => {
  it('markdown：走文本通道 + markdown 渲染器', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '# 一级标题\n\n- 第一项\n',
      size: 24,
      truncated: false
    })
    render(<PreviewTool root={rootOf()} relative="docs/说明.md" />)

    expect(bed.bridge.workbench.readFile).toHaveBeenCalledWith('thread-1', 'docs/说明.md')
    const body = await screen.findByTestId('file-preview-markdown')
    expect(body.querySelector('h1')?.textContent).toBe('一级标题')
    expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
    // 顶部那行文件名（点它复制绝对路径）
    expect(screen.getByTestId('preview-name')).toHaveTextContent('说明.md')
    expect(screen.getByTestId('preview-tool')).toHaveAttribute('data-relative', 'docs/说明.md')
  })

  it('代码文件：同一份文本过代码高亮（仍是文本通道）', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export const a = 1\n',
      size: 19,
      truncated: false
    })
    render(<PreviewTool root={rootOf()} relative="src/index.ts" />)

    expect(await screen.findByTestId('file-preview-code')).toBeInTheDocument()
    expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
  })

  it('图片：走字节通道并画成 data URL', async () => {
    bed.bridge.workbench.readBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'image-png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      size: 4
    })
    render(<PreviewTool root={rootOf()} relative="资源/图片.png" />)

    await waitFor(() =>
      expect(bed.bridge.workbench.readBytes).toHaveBeenCalledWith('thread-1', '资源/图片.png')
    )
    const image = (await screen.findByTestId('file-preview-image')).querySelector('img')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
    expect(bed.bridge.workbench.readFile).not.toHaveBeenCalled()
  })

  it('二进制 / 太大：给人话，不吐乱码（也不去拉字节）', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({ kind: 'binary', size: 2048 })
    render(<PreviewTool root={rootOf()} relative="logo.ico" />)

    expect(await screen.findByTestId('file-preview-binary')).toHaveTextContent('二进制')
    expect(bed.bridge.workbench.readBytes).not.toHaveBeenCalled()
  })

  it('读不了：把主进程的人话露在预览区里', async () => {
    bed.bridge.workbench.readFile.mockRejectedValue(new Error('这个文件不在磁盘上了'))
    render(<PreviewTool root={rootOf()} relative="gone.txt" />)

    expect(await screen.findByTestId('file-preview-error')).toHaveTextContent(
      '这个文件不在磁盘上了'
    )
  })

  it('「重新读取」再走一次同一条读链（会话 + 相对路径都不变）', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '第一版\n',
      size: 9,
      truncated: false
    })
    render(<PreviewTool root={rootOf()} relative="notes.txt" />)
    await screen.findByTestId('file-preview-text')

    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '第二版\n',
      size: 9,
      truncated: false
    })
    fireEvent.click(screen.getByTestId('preview-refresh'))

    await waitFor(() => expect(screen.getByTestId('file-preview-text')).toHaveTextContent('第二版'))
    expect(bed.bridge.workbench.readFile).toHaveBeenCalledTimes(2)
    expect(bed.bridge.workbench.readFile).toHaveBeenLastCalledWith('thread-1', 'notes.txt')
  })

  /* round 52：头部不再是"一行光文件名"——类型图标块 + 文件名（醒目）+ 相对路径 */
  it('头部：类型图标块 + 文件名 + 相对路径（图标按后缀，与 tab 图标同一张表）', async () => {
    render(<PreviewTool root={rootOf()} relative="docs/说明.md" />)

    const icon = screen.getByTestId('preview-icon')
    expect(icon.querySelector('svg')?.getAttribute('class')).toContain('lucide-book-text')
    expect(screen.getByTestId('preview-name')).toHaveTextContent('说明.md')
    expect(screen.getByTestId('preview-name')).toHaveClass('text-b1')
    expect(screen.getByTestId('preview-path')).toHaveTextContent('docs/说明.md')
  })

  it('头部图标随后缀换：pdf / 图片 / 表格各是各的', async () => {
    const cases: Array<[string, string]> = [
      ['报告.pdf', 'lucide-file-text'],
      ['assets/logo.png', 'lucide-file-image'],
      ['台账.xlsx', 'lucide-file-spreadsheet'],
      ['src/index.ts', 'lucide-file-code']
    ]
    for (const [relative, iconClass] of cases) {
      const { unmount } = render(<PreviewTool root={rootOf()} relative={relative} />)
      expect([
        relative,
        screen.getByTestId('preview-icon').querySelector('svg')?.getAttribute('class')
      ]).toEqual([relative, expect.stringContaining(iconClass)])
      unmount()
    }
  })

  it('「在文件资源管理器中定位」走既有 reveal 通道；失败了把话露在预览区（不静默）', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: '正文\n',
      size: 7,
      truncated: false
    })
    bed.bridge.workbench.reveal.mockRejectedValue(new Error('这个文件不在磁盘上了'))
    render(<PreviewTool root={rootOf()} relative="notes.txt" />)
    await screen.findByTestId('file-preview-text')

    fireEvent.click(screen.getByTestId('preview-reveal'))

    await waitFor(() =>
      expect(bed.bridge.workbench.reveal).toHaveBeenCalledWith('thread-1', 'notes.txt')
    )
    expect(await screen.findByTestId('file-preview-error')).toHaveTextContent(
      '这个文件不在磁盘上了'
    )
  })

  it('判不出工作区：空态给人话，不读盘', () => {
    const root: WorkbenchRoot = {
      ...rootOf(),
      rootPath: null,
      rootName: null,
      ready: false,
      notice: '判不出这个会话的工作区：在设置里添加一个文件夹，或指认默认工作区'
    }
    render(<PreviewTool root={root} relative="notes.txt" />)

    expect(screen.getByTestId('preview-notice')).toHaveTextContent('判不出这个会话的工作区')
    expect(bed.bridge.workbench.readFile).not.toHaveBeenCalled()
  })
})

/**
 * round 53：预览标签里选中文字 → 右键 →「添加到上下文（摘选）」。
 * 菜单与发布口径是**共享件**（preview/SelectionContextMenu，与文件树里单击的内联预览同一份）：
 * 这里只验"新入口确实长在标签这一侧、路径用的是本标签的 relative"。
 */
describe('round 53 · 预览标签里选中文字的自绘右键菜单', () => {
  let published: ContextItem[] = []
  let unsubscribe: (() => void) | null = null

  beforeEach(() => {
    published = []
    unsubscribe = subscribeContextItems((item) => published.push(item))
  })

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  const TEXT = 'export const a = 1\nexport const b = 2\n'

  /** 喂一份文本文件并等正文就绪（文本通道 → `file-preview-text`） */
  async function openText(relative: string): Promise<void> {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: TEXT,
      size: 44,
      truncated: false
    })
    render(<PreviewTool root={rootOf()} relative={relative} />)
    await screen.findByTestId('file-preview-text')
  }

  /** 把正文节点整块选上（真机上是拖选出来的，这里直接落一个 Range） */
  function selectBody(): void {
    const range = document.createRange()
    range.selectNodeContents(screen.getByTestId('file-preview-text'))
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  it('原生右键被拦掉（整块预览区都拦：正文与头部都不漏出浏览器菜单）', async () => {
    await openText('src/notes.txt')

    expect(fireEvent.contextMenu(screen.getByTestId('file-preview-text'))).toBe(false)
    expect(fireEvent.contextMenu(screen.getByTestId('preview-name'))).toBe(false)
  })

  it('没有选区：菜单只有「全选」', async () => {
    await openText('src/notes.txt')
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    const menu = screen.getByTestId('workbench-context-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['全选'])
  })

  it('有选区：[添加到上下文（摘选）/ 复制 / 全选]；点摘选发布的路径就是本标签那份文件', async () => {
    await openText('src/notes.txt')
    selectBody()

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
    expect(event.relative).toBe('src/notes.txt')
    expect(event.name).toBe('notes.txt 摘选')
    expect(event.source === 'selection' ? event.text : '').toContain('export const a = 1')
    // 源文在手：位置在这一侧算好（整块选中的就是第 1–2 行）
    expect(event.source === 'selection' ? event.lines : undefined).toEqual({ start: 1, end: 2 })
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()
  })

  it('「全选」框的是正文（头部那两行文件名 / 路径不算）', async () => {
    await openText('src/notes.txt')
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    fireEvent.click(screen.getByText('全选'))

    const selected = window.getSelection()?.toString() ?? ''
    expect(selected).toContain('export const b = 2')
    expect(selected).not.toContain('notes.txt')

    // 选区就绪 → 再右键出现摘选那两项
    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    expect(screen.getByText('添加到上下文（摘选）')).toBeInTheDocument()
  })

  it('端到端：摘选进输入卡成引用卡（相对路径 + 行号），发送载荷是【引用】文件 + 围栏内容', async () => {
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 10,
      truncated: false
    })
    const onSend = vi.fn()
    render(
      <>
        <PreviewTool root={rootOf()} relative="notes.txt" />
        <Composer threadId="thread-1" onSend={onSend} onStop={vi.fn()} />
      </>
    )
    await screen.findByTestId('file-preview-text')

    // 走**真机那条鼠标路径**：右键 → pointerdown(菜单项) → click
    selectBody()
    fireEvent.contextMenu(screen.getByTestId('file-preview-text'))
    const item = screen.getByText('添加到上下文（摘选）')
    fireEvent.pointerDown(item)
    fireEvent.click(item)

    const card = await screen.findByTestId('composer-attachment-notes.txt 摘选')
    expect(card).toHaveAttribute('data-quote', 'true')
    expect(card).toHaveTextContent('notes.txt')
    expect(screen.getByTestId('composer-quote-lines')).toHaveTextContent('第 1–1 行')
    // 只拉过一次预览的文本通道（发布方没有额外读文件）
    expect(bed.bridge.workbench.readFile).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('composer-send'))
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({
      text: '【引用】文件：notes.txt（第 1–1 行）\n```\nexport {}\n```'
    })
  })
})
