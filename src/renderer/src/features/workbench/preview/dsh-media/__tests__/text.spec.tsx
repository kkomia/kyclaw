import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DshTextBody } from '../text-body'

describe('DshTextBody：逐行铺开', () => {
  it('每行一块、行号是数据属性（后续"跳到某行"靠它），文本内容不变', () => {
    render(<DshTextBody text={'第一行\n第二行\n第三行'} />)
    const body = screen.getByTestId('dsh-text-body')
    const lines = body.querySelectorAll('[data-dsh-text-line]')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toHaveAttribute('data-dsh-text-line', '1')
    expect(lines[1]).toHaveTextContent('第二行')
    // 每行自带换行符：整体文本 = 原文（末尾最多多一个换行，复制不受影响）
    expect(body.textContent).toBe('第一行\n第二行\n第三行\n')
  })

  it('末尾换行不额外摊出一整行空行', () => {
    render(<DshTextBody text={'a\nb\n'} />)
    expect(screen.getByTestId('dsh-text-body').textContent).toBe('a\nb\n')
    expect(
      screen.getByTestId('dsh-text-body').querySelectorAll('[data-dsh-text-line]')
    ).toHaveLength(2)
  })

  it('空文本给一行空行（不至于什么都没有）', () => {
    render(<DshTextBody text="" />)
    const lines = screen.getByTestId('dsh-text-body').querySelectorAll('[data-dsh-text-line]')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent('')
  })

  it('缩进与空行原样保留（等宽、`pre` 口径）', () => {
    render(<DshTextBody text={'  indented\n\n\ttab'} />)
    const body = screen.getByTestId('dsh-text-body')
    const lines = body.querySelectorAll('[data-dsh-text-line]')
    expect(lines).toHaveLength(3)
    expect(lines[0].textContent).toBe('  indented\n')
    expect(lines[1].textContent).toBe('\n')
    expect(lines[2].textContent).toBe('\ttab\n')
  })
})
