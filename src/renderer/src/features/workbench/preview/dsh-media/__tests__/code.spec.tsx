import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// 高亮器不在本 spec 的验证面内（那一层是聊天区 CodeBlock 自己的事，且真加载 Shiki 很慢）：
// 这里只钉文档体这一层（行号槽宽、换行开关、透传参数），代码块换成轻替身。
vi.mock('@renderer/features/chat/parts/CodeBlock', () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <div data-testid="code-block" data-language={language ?? ''}>
      {code}
    </div>
  )
}))

import { DshCodeBody } from '../code-body'

describe('DshCodeBody：行号槽宽与透传', () => {
  it('行号槽宽按总行数给（最少 2ch）', () => {
    render(<DshCodeBody text={'a\nb\nc'} language="typescript" />)
    const body = screen.getByTestId('dsh-code-body')
    expect(body.style.getPropertyValue('--dsh-code-line-number-width')).toBe('2ch')

    const many = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')
    const second = render(<DshCodeBody text={many} language="typescript" />)
    expect(
      second.container.querySelector('[data-testid="dsh-code-body"]')?.getAttribute('style')
    ).toContain('--dsh-code-line-number-width: 3ch')
  })

  it('代码与语言原样交给既有 CodeBlock（高亮/复制仍然只有一份实现）', () => {
    render(<DshCodeBody text={'const a = 1'} language="typescript" />)
    const block = screen.getByTestId('code-block')
    expect(block).toHaveAttribute('data-language', 'typescript')
    expect(block).toHaveTextContent('const a = 1')
  })

  it('末尾换行不摊出多余行（100 行就是 100）', () => {
    const text = `${Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')}\n`
    render(<DshCodeBody text={text} language="typescript" />)
    expect(
      screen.getByTestId('dsh-code-body').style.getPropertyValue('--dsh-code-line-number-width')
    ).toBe('3ch')
  })
})

describe('DshCodeBody：换行开关', () => {
  it('缺省开（上游文档侧口径），按钮是按压态', () => {
    render(<DshCodeBody text={'long line'} language="typescript" />)
    expect(screen.getByTestId('dsh-code-body')).toHaveAttribute('data-wrap', 'true')
    expect(screen.getByTestId('dsh-code-wrap')).toHaveAttribute('aria-pressed', 'true')
  })

  it('点一下关掉：只改数据属性（换行是 CSS 的事，不动文本）', () => {
    render(<DshCodeBody text={'long line'} language="typescript" />)
    fireEvent.click(screen.getByTestId('dsh-code-wrap'))
    expect(screen.getByTestId('dsh-code-body')).toHaveAttribute('data-wrap', 'false')
    expect(screen.getByTestId('dsh-code-wrap')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('code-block')).toHaveTextContent('long line')
    fireEvent.click(screen.getByTestId('dsh-code-wrap'))
    expect(screen.getByTestId('dsh-code-body')).toHaveAttribute('data-wrap', 'true')
  })
})
