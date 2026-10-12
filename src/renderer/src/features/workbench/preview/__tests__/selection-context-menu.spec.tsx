import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeContextItems, type ContextItem } from '@renderer/features/chat/composer-inbox'
import { SelectionContextMenu } from '../SelectionContextMenu'

/**
 * 选区右键菜单共享件：内联预览（FilesTool）与预览标签（PreviewTool）都套它。
 * 三项的形态、发布口径（路径 + 行号 + 文字）与 round 42 的既有行为逐字一致 —— 这里按那套口径搬。
 */
let published: ContextItem[]
let unsubscribe: (() => void) | null = null

beforeEach(() => {
  published = []
  unsubscribe = subscribeContextItems((item) => published.push(item))
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
})

/** 把某个节点整块选上（jsdom 与真机同一个 Selection API） */
function selectNode(node: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const SOURCE = '# 一级标题\n\n正文第一段\n'

function renderMenu(
  props: { threadId?: string | null; relative?: string; sourceText?: string | null } = {}
): void {
  render(
    <SelectionContextMenu
      threadId={props.threadId === undefined ? 'thread-1' : props.threadId}
      relative={props.relative ?? 'docs/说明.md'}
      sourceText={props.sourceText === undefined ? SOURCE : props.sourceText}
    >
      <div data-testid="body">正文第一段</div>
    </SelectionContextMenu>
  )
}

describe('SelectionContextMenu：菜单形态', () => {
  it('原生右键被拦掉（整块区域，不只是文字那一小块）', () => {
    renderMenu()

    expect(fireEvent.contextMenu(screen.getByTestId('body'))).toBe(false)
  })

  it('没有选区：只有「全选」（不摆点了没用的项）', () => {
    renderMenu()
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(screen.getByTestId('body'))
    const menu = screen.getByTestId('workbench-context-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['全选'])
  })

  it('有选区：[添加到上下文（摘选）/ 复制 / 全选]', () => {
    renderMenu()
    selectNode(screen.getByTestId('body'))

    fireEvent.contextMenu(screen.getByTestId('body'))
    const menu = screen.getByTestId('workbench-context-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['添加到上下文（摘选）', '复制', '全选'])
  })

  it('「全选」把内容整体选上（再右键就是"有选区"那一档）', () => {
    renderMenu()
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(screen.getByTestId('body'))
    fireEvent.click(screen.getByText('全选'))

    expect(window.getSelection()?.toString()).toBe('正文第一段')

    fireEvent.contextMenu(screen.getByTestId('body'))
    expect(screen.getByText('添加到上下文（摘选）')).toBeInTheDocument()
  })

  it('给了 bodyRef：「全选」只框那块（包装层里别的内容不算 —— 内联预览的标题条）', () => {
    function Host(): React.JSX.Element {
      const ref = useRef<HTMLDivElement>(null)
      return (
        <SelectionContextMenu
          threadId="thread-1"
          relative="docs/说明.md"
          sourceText={SOURCE}
          bodyRef={ref}
        >
          <p>标题条的文字</p>
          <div ref={ref} data-testid="body">
            正文第一段
          </div>
        </SelectionContextMenu>
      )
    }
    render(<Host />)
    window.getSelection()?.removeAllRanges()

    fireEvent.contextMenu(screen.getByTestId('body'))
    fireEvent.click(screen.getByText('全选'))

    expect(window.getSelection()?.toString()).toBe('正文第一段')
  })

  it('有选区时「复制」把选中的文字写进剪贴板', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderMenu()
    selectNode(screen.getByTestId('body'))

    fireEvent.contextMenu(screen.getByTestId('body'))
    fireEvent.click(screen.getByText('复制'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('正文第一段'))
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()
  })
})

describe('SelectionContextMenu：摘选的发布口径', () => {
  it('点摘选：发布 selection 事件（路径 / 名称 / 文字 / 源文里的行号区间）', () => {
    renderMenu()
    selectNode(screen.getByTestId('body'))

    fireEvent.contextMenu(screen.getByTestId('body'))
    fireEvent.click(screen.getByText('添加到上下文（摘选）'))

    expect(published).toEqual([
      {
        source: 'selection',
        threadId: 'thread-1',
        relative: 'docs/说明.md',
        name: '说明.md 摘选',
        text: '正文第一段',
        // 源文在手：位置在这一侧算好（'正文第一段' 落在第 3 行）
        lines: { start: 3, end: 3 }
      }
    ])
    expect(screen.queryByTestId('workbench-context-menu')).not.toBeInTheDocument()
  })

  it('没有源文（字节通道 / 拿不到）：照发，但不带位置', () => {
    renderMenu({ sourceText: null })
    selectNode(screen.getByTestId('body'))

    fireEvent.contextMenu(screen.getByTestId('body'))
    fireEvent.click(screen.getByText('添加到上下文（摘选）'))

    expect(published).toHaveLength(1)
    expect('lines' in (published[0] as object)).toBe(false)
  })

  it('没有会话：不发布（事件挂不到任何输入卡上）', () => {
    renderMenu({ threadId: null })
    selectNode(screen.getByTestId('body'))

    fireEvent.contextMenu(screen.getByTestId('body'))
    fireEvent.click(screen.getByText('添加到上下文（摘选）'))

    expect(published).toEqual([])
  })
})
