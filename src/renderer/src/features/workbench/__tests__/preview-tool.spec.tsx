import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
