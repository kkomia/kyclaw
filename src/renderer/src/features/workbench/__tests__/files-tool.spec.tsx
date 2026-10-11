import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchRoot } from '../use-workbench-root'
import { FilesTool } from '../FilesTool'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

/**
 * 文件工具：懒加载目录树（点开才列子层）、单击预览、自绘右键菜单（打开 / 复制路径）。
 * 主进程通道用桥的桩顶掉：这里只验渲染端的行为与调用参数（containment 在主进程侧已单测）。
 */
let bed: Bed

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
})

afterEach(() => {
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
    bed.bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export {}\n',
      size: 4096,
      truncated: true
    })
    render(<FilesTool root={rootOf()} />)

    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    fireEvent.click(screen.getByText('README.md'))

    await waitFor(() =>
      expect(bed.bridge.workbench.readFile).toHaveBeenCalledWith('thread-1', 'README.md')
    )
    const preview = await screen.findByTestId('file-preview')
    expect(within(preview).getByTestId('file-preview-text')).toHaveTextContent('export {}')
    expect(within(preview).getByText(/只显示前面一部分/)).toBeInTheDocument()
  })

  it('二进制 / 超大文件给人话，不吐乱码', async () => {
    bed.bridge.workbench.listDir.mockResolvedValue({
      entries: [
        { name: 'logo.png', kind: 'file', size: 2048 },
        { name: 'huge.bin', kind: 'file', size: 104857600 }
      ],
      truncated: false
    })
    render(<FilesTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByText('logo.png')).toBeInTheDocument())

    bed.bridge.workbench.readFile.mockResolvedValueOnce({ kind: 'binary', size: 2048 })
    fireEvent.click(screen.getByText('logo.png'))
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
