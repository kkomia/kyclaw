import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DshMarkdownBody } from '../markdown-body'

// 代码块只验"文本有没有被数学定界吃掉"，不需要真加载 Shiki
vi.mock('@renderer/features/chat/parts/CodeBlock', () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <div data-testid="code-block" data-language={language ?? ''}>
      {code}
    </div>
  )
}))

/** 一份文档里数学渲染了几个（KaTeX 输出的根类 `.katex`；块级另有 `.katex-display`）。 */
function katexCount(container: HTMLElement): number {
  return container.querySelectorAll('.katex').length
}

describe('数学定界：$...$ 与 $$...$$（remark-math 原有口径）', () => {
  it('行内 `$a^2$` 渲染成 KaTeX', () => {
    const { container } = render(<DshMarkdownBody text={'前面 $a^2$ 后面'} />)
    expect(katexCount(container)).toBe(1)
    expect(container.textContent).toContain('前面')
    expect(container.textContent).toContain('后面')
  })

  it('块级 `$$...$$` 走 display 模式', () => {
    const { container } = render(<DshMarkdownBody text={'$$\nE = mc^2\n$$'} />)
    expect(katexCount(container)).toBe(1)
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })
})

describe('数学定界：\\(...\\) 与 \\[...\\]（本轮按上游口径补齐）', () => {
  it('行内 `\\(b^2\\)` 渲染成 KaTeX（不再是原样一串反斜杠）', () => {
    const { container } = render(<DshMarkdownBody text={'甲 \\(b^2\\) 乙'} />)
    expect(katexCount(container)).toBe(1)
    expect(container.textContent).toContain('甲')
    expect(container.textContent).toContain('乙')
    // 定界符本身不再出现在正文里
    expect(container.textContent).not.toContain('\\(')
  })

  it('块级 `\\[...\\]` 走 display 模式（可跨行）', () => {
    const { container } = render(<DshMarkdownBody text={'\\[\n\\int_0^1 x\\,dx\n\\]'} />)
    expect(katexCount(container)).toBe(1)
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('同一行的 `$$c$$` 也算块级（上游的 same-line 口径）', () => {
    const { container } = render(<DshMarkdownBody text={'$$c^2$$'} />)
    expect(katexCount(container)).toBe(1)
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('两套定界可以在同一篇里混用', () => {
    const { container } = render(
      <DshMarkdownBody text={'行内 $a$、另一个 \\(b\\)\n\n$$\nd\n$$\n'} />
    )
    expect(katexCount(container)).toBe(3)
  })
})

describe('数学定界不误伤代码（tokenizer 层，不是文本替换）', () => {
  it('围栏代码块里的定界原样保留（不渲染成数学）', () => {
    const code = '\\(x\\)\n$$not-math$$\n'
    const { container } = render(<DshMarkdownBody text={'```ts\n' + code + '```\n'} />)
    expect(katexCount(container)).toBe(0)
    const block = screen.getByTestId('code-block')
    expect(block.textContent).toContain('\\(x\\)')
    expect(block.textContent).toContain('$$not-math$$')
  })

  it('行内代码里的定界原样保留', () => {
    const { container } = render(<DshMarkdownBody text={'写法是 `\\(x\\)` 与 `$$y$$`'} />)
    expect(katexCount(container)).toBe(0)
    const inline = container.querySelectorAll('[data-testid="inline-code"]')
    expect(inline).toHaveLength(2)
    expect(inline[0]?.textContent).toBe('\\(x\\)')
    expect(inline[1]?.textContent).toBe('$$y$$')
  })

  it('代码块与正文混排时，只有正文里的定界被渲染', () => {
    const { container } = render(
      <DshMarkdownBody text={'正文 \\(a\\)\n\n```\n\\(b\\)\n```\n\n又一个 \\(c\\)'} />
    )
    expect(katexCount(container)).toBe(2)
    expect(screen.getByTestId('code-block').textContent).toContain('\\(b\\)')
  })
})
