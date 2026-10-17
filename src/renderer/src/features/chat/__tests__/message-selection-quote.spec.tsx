import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { publishDraft } from '@renderer/features/chat/composer-inbox'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { installKyclawBridge, clearKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { createMockTransport } from './mock-transport'
import { Message } from '../Message'

/**
 * 0.1.3 / 013：选中 AI 回复的正文 → 右键「引用到输入框」/「复制」。
 *
 * 钉住四件事：
 *   1. 有选区才接管右键（无选区不阻止原生菜单），菜单两项与预览的 ContextMenu 同一形态；
 *   2. 引用把**选中的原文**交给上层（上层写草稿、不发送）；
 *   3. 复制走剪贴板，选中的字一个不差；
 *   4. 左键的表格复制动作不被选文菜单妨碍（选文菜单只在 contextmenu 上工作）。
 *
 * 端到端那条（真 ChatSession + 真 Composer + 假 transport）钉"只写草稿、不发送"。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null })),
  truncateThread: vi.fn(async () => 0),
  createThread: vi.fn(),
  generateThreadTitle: vi.fn()
}))

const THREAD_ID = 'thread-quote'
const REPLY = '这是要先引用的一段回复。'

const assistant: UIMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: REPLY }]
}

function selectNode(node: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

/** 在同一个 message-text 内从第一段选到最后一段（跨段落属于同一正文容器） */
function selectParagraphs(container: HTMLElement): string {
  const paragraphs = container.querySelectorAll('p')
  const first = paragraphs[0]
  const last = paragraphs[paragraphs.length - 1]
  if (first === undefined || last === undefined) throw new Error('没有两段正文')
  const range = document.createRange()
  range.setStart(first.firstChild ?? first, 0)
  range.setEnd(last.lastChild ?? last, last.textContent?.length ?? 0)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return selection?.toString() ?? ''
}

function clipboardSpy(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

/** 真 ChatSession + 真 Composer + 假 transport（历史可按用例给） */
function mountSession(
  history: UIMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '解释一下' }] },
    assistant
  ]
): ReturnType<typeof createMockTransport> {
  const control = createMockTransport()
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={THREAD_ID}
        runtime={{
          transport: control.transport,
          loadHistory: async () => history,
          onTurnEnd: () => {}
        }}
      />
    </MemoryRouter>
  )
  return control
}

beforeEach(() => {
  resetThreadChats()
  installKyclawBridge(defaultSettings())
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
})

afterEach(() => {
  clearKyclawBridge()
  clearSelection()
  vi.restoreAllMocks()
})

describe('013 · 助手正文的选文右键菜单', () => {
  it('有选区：[引用到输入框 / 复制]；引用把选中原文交给上层并关掉菜单', () => {
    const onQuoteSelection = vi.fn()
    render(<Message message={assistant} onQuoteSelection={onQuoteSelection} />)

    selectNode(screen.getByTestId('message-text'))
    fireEvent.contextMenu(screen.getByTestId('message-text'))

    const menu = screen.getByTestId('message-selection-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['引用到输入框', '复制'])

    fireEvent.click(screen.getByTestId('message-selection-menu-quote'))
    expect(onQuoteSelection).toHaveBeenCalledWith(REPLY)
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('没有选区：不接管右键（原生菜单 / 既有复制路径照常）', () => {
    clearSelection()
    render(<Message message={assistant} onQuoteSelection={vi.fn()} />)

    expect(fireEvent.contextMenu(screen.getByTestId('message-text'))).toBe(true)
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('同一个 message-text 内跨两段：允许，两段都交给上层', () => {
    const onQuoteSelection = vi.fn()
    render(
      <Message
        message={{
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'text', text: '第一段正文。\n\n第二段正文。' }]
        }}
        onQuoteSelection={onQuoteSelection}
      />
    )

    const selected = selectParagraphs(screen.getByTestId('message-text'))
    expect(selected).toContain('第一段正文。')
    expect(selected).toContain('第二段正文。')

    fireEvent.contextMenu(screen.getByTestId('message-text'))
    expect(screen.getByTestId('message-selection-menu')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('message-selection-menu-quote'))
    expect(onQuoteSelection).toHaveBeenCalledWith(selected)
  })

  it('跨两个不同 text part（中间没有工具也算不同正文容器）：不接管', () => {
    render(
      <Message
        message={{
          id: 'a2',
          role: 'assistant',
          parts: [
            { type: 'text', text: '第一个 part' },
            { type: 'text', text: '第二个 part' }
          ]
        }}
        onQuoteSelection={vi.fn()}
      />
    )

    const texts = screen.getAllByTestId('message-text')
    const range = document.createRange()
    range.setStart(texts[0]!, 0)
    range.setEnd(texts[1]!, texts[1]!.childNodes.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(fireEvent.contextMenu(texts[1]!)).toBe(true)
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('正文跨到过程块（中间有工具）：不接管（Range.toString 不混工具与隐藏文本）', () => {
    render(
      <Message
        message={{
          id: 'a2',
          role: 'assistant',
          parts: [
            { type: 'text', text: '正文第一段' },
            {
              type: 'tool-read_file',
              toolCallId: 'r1',
              state: 'input-available',
              input: { path: 'a.ts' }
            } as UIMessage['parts'][number],
            { type: 'text', text: '正文第二段' }
          ]
        }}
        onQuoteSelection={vi.fn()}
      />
    )

    const texts = screen.getAllByTestId('message-text')
    const range = document.createRange()
    range.setStart(texts[0]!, 0)
    range.setEnd(texts[1]!, texts[1]!.childNodes.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(fireEvent.contextMenu(texts[1]!)).toBe(true)
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('只在过程块里选：不接管', () => {
    render(
      <Message
        message={{
          id: 'a2',
          role: 'assistant',
          parts: [
            {
              type: 'tool-read_file',
              toolCallId: 'r1',
              state: 'input-available',
              input: { path: 'a.ts' }
            } as UIMessage['parts'][number]
          ]
        }}
        onQuoteSelection={vi.fn()}
      />
    )

    const trace = screen.getByTestId('trace-block')
    const range = document.createRange()
    range.selectNodeContents(trace)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(fireEvent.contextMenu(trace)).toBe(true)
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('第一次展开后再收起的思考内容仍在 DOM：选中也不接管', () => {
    render(
      <Message
        message={{
          id: 'a2',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '折叠后仍在 DOM 的思考' },
            { type: 'text', text: '正文' }
          ]
        }}
        onQuoteSelection={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    const hidden = screen.getByTestId('reasoning-text')
    const range = document.createRange()
    range.selectNodeContents(hidden)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(fireEvent.contextMenu(hidden)).toBe(true)
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('交付卡文件名被选中：不接管', () => {
    render(
      <Message
        message={{
          id: 'a2',
          role: 'assistant',
          parts: [
            { type: 'text', text: '正文' },
            {
              type: 'tool-deliver_file',
              toolCallId: 'd1',
              state: 'output-available',
              input: { path: 'docs/a.md' },
              output: { path: 'docs/a.md', name: 'a.md', size: 10 }
            } as UIMessage['parts'][number]
          ]
        }}
        onQuoteSelection={vi.fn()}
      />
    )

    const name = screen.getByTestId('deliverable-name')
    const range = document.createRange()
    range.selectNodeContents(name)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(fireEvent.contextMenu(name)).toBe(true)
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('有选区时「复制」把选中的字写进剪贴板', async () => {
    const writeText = clipboardSpy()
    render(<Message message={assistant} onQuoteSelection={vi.fn()} />)

    selectNode(screen.getByTestId('message-text'))
    fireEvent.contextMenu(screen.getByTestId('message-text'))
    fireEvent.click(screen.getByTestId('message-selection-menu-copy'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REPLY))
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('打开即聚焦第一项；↑/↓ / Home / End 在菜单项之间导航', () => {
    render(
      <>
        <button type="button" data-testid="invoker">
          invoker
        </button>
        <Message message={assistant} onQuoteSelection={vi.fn()} />
      </>
    )
    screen.getByTestId('invoker').focus()
    selectNode(screen.getByTestId('message-text'))
    fireEvent.contextMenu(screen.getByTestId('message-text'))

    const menu = screen.getByTestId('message-selection-menu')
    const quote = screen.getByTestId('message-selection-menu-quote')
    const copy = screen.getByTestId('message-selection-menu-copy')
    expect(quote).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(copy).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(quote).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(copy).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(quote).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(copy).toHaveFocus()
  })

  it('Esc 关闭后焦点还给 invoker', async () => {
    render(
      <>
        <button type="button" data-testid="invoker">
          invoker
        </button>
        <Message message={assistant} onQuoteSelection={vi.fn()} />
      </>
    )
    const invoker = screen.getByTestId('invoker')
    invoker.focus()
    selectNode(screen.getByTestId('message-text'))
    fireEvent.contextMenu(screen.getByTestId('message-text'))
    expect(screen.getByTestId('message-selection-menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(invoker).toHaveFocus())
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('复制成功关闭后焦点还给 invoker', async () => {
    clipboardSpy()
    render(
      <>
        <button type="button" data-testid="invoker">
          invoker
        </button>
        <Message message={assistant} onQuoteSelection={vi.fn()} />
      </>
    )
    const invoker = screen.getByTestId('invoker')
    invoker.focus()
    selectNode(screen.getByTestId('message-text'))
    fireEvent.contextMenu(screen.getByTestId('message-text'))

    fireEvent.click(screen.getByTestId('message-selection-menu-copy'))
    await waitFor(() => expect(invoker).toHaveFocus())
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })

  it('剪贴板拒绝：捕获并 warn（不产生未处理 rejection），菜单照常关闭', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('clipboard denied')
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<Message message={assistant} onQuoteSelection={vi.fn()} />)

    selectNode(screen.getByTestId('message-text'))
    fireEvent.contextMenu(screen.getByTestId('message-text'))
    fireEvent.click(screen.getByTestId('message-selection-menu-copy'))

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[kyclaw] 复制选文失败', expect.any(Error))
    )
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
    warn.mockRestore()
  })

  it('选区有文本时，表格的复制按钮（左键）照常工作 —— 选文菜单只在右键上', async () => {
    const writeText = clipboardSpy()
    const table = '| 列 |\n| --- |\n| 值 |'
    render(
      <Message
        message={{ id: 'a2', role: 'assistant', parts: [{ type: 'text', text: table }] }}
        onQuoteSelection={vi.fn()}
      />
    )

    selectNode(screen.getByTestId('message-text'))
    fireEvent.click(screen.getByTestId('table-copy'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('| 列 |')))
    // 左键没有打开选文菜单
    expect(screen.queryByTestId('message-selection-menu')).not.toBeInTheDocument()
  })
})

describe('013 返工 · 引用到输入卡（真 Composer）', () => {
  it('引用只进附件卡：输入框零占位、摘要可见、不自动发送；焦点由 Composer 接管', async () => {
    const control = mountSession()

    await screen.findByTestId('message-a1')
    selectNode(within(screen.getByTestId('message-a1')).getByTestId('message-text'))
    fireEvent.contextMenu(screen.getByTestId('message-text'))
    fireEvent.click(screen.getByTestId('message-selection-menu-quote'))

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    expect(input.value).toBe('')
    expect(input).toHaveFocus()
    const card = screen.getByTestId('composer-quote-card')
    expect(card).toHaveTextContent('引用')
    expect(card).toHaveAttribute('title', 'AI 回复（消息 a1）')
    expect(screen.getByTestId('composer-quote-summary')).toHaveTextContent(REPLY)
    // 没有走发送：只写草稿
    expect(control.requests).toHaveLength(0)
  })

  it('同一 tick 连续两次 append：第二次读到同步 truth，不覆盖第一次', async () => {
    const control = mountSession()
    await screen.findByTestId('message-a1')

    act(() => {
      publishDraft({ threadId: THREAD_ID, text: '第一段\n\n', mode: 'append' })
      publishDraft({ threadId: THREAD_ID, text: '第二段\n\n', mode: 'append' })
    })

    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(
      '第一段\n\n第二段\n\n'
    )
    expect(control.requests).toHaveLength(0)
  })
})
