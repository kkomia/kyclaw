import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '@renderer/features/chat/MessageList'

/**
 * markdown 渲染（Step 2）：react-markdown + remark-gfm + Shiki（css-variables 主题 → --Syntax-*）。
 * 高亮是异步的（JS 引擎懒加载），断言用 findBy / waitFor；页面结构（标题/表格/行内 code/代码块）是同步的。
 */
const MARKDOWN = [
  '# 标题',
  '',
  '行内 `const` 与一张表：',
  '',
  '| 甲 | 乙 |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer: number = 42',
  '```'
].join('\n')

function renderAssistant(text: string): void {
  render(
    <MessageList
      messages={[{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] }]}
      status="ready"
    />
  )
}

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('markdown 基础结构（gfm）', () => {
  it('标题、表格、行内 code 都按 markdown 结构渲染', () => {
    renderAssistant(MARKDOWN)

    expect(screen.getByRole('heading', { level: 1, name: '标题' })).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getByText('甲')).toBeInTheDocument()
    expect(within(table).getByText('2')).toBeInTheDocument()

    const inline = screen.getByTestId('inline-code')
    expect(inline.tagName).toBe('CODE')
    expect(inline).toHaveTextContent('const')
  })
})

describe('代码块（Shiki css-variables）', () => {
  it('语言标注 + 高亮结构：shiki 的 pre/code 与 --shiki-token-* 内联色', async () => {
    renderAssistant(MARKDOWN)

    const block = await screen.findByTestId('code-block')
    expect(block).toHaveAttribute('data-language', 'ts')
    expect(await screen.findByTestId('code-language')).toHaveTextContent('ts')

    await waitFor(() => {
      expect(block).toHaveAttribute('data-highlighted', 'true')
    })

    const pre = block.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.className).toContain('shiki')
    // 主题是 css-variables：token 颜色写成 var(--shiki-token-*)（真配色在 styles/markdown.css 映到 --Syntax-*）
    expect(pre?.innerHTML).toContain('var(--shiki-token-keyword)')
    expect(pre?.innerHTML).toContain('const')
    expect(pre?.textContent).toContain('const answer: number = 42')
  })

  it('未知语言不硬套高亮，按纯文本出（仍然有复制按钮）', async () => {
    renderAssistant('```nolang\nplain text\n```')

    const block = await screen.findByTestId('code-block')
    expect(block).toHaveAttribute('data-language', 'nolang')
    expect(block).toHaveAttribute('data-highlighted', 'false')
    expect(block.querySelector('pre.shiki')).toBeNull()
    expect(block).toHaveTextContent('plain text')
    expect(within(block).getByTestId('code-copy')).toBeInTheDocument()
  })

  it('复制按钮把代码写进剪贴板，并给出"已复制"反馈', async () => {
    renderAssistant(MARKDOWN)

    const copy = await screen.findByTestId('code-copy')
    fireEvent.click(copy)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const answer: number = 42')
    })
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })
})
