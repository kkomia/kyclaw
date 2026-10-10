import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Input, Textarea } from '../input'

describe('Input', () => {
  it('40 高 / 圆角 12 / .5px Fills-F1 描边（§4.7 .kimi-select）', () => {
    render(<Input aria-label="会话名" />)

    expect(screen.getByLabelText('会话名')).toHaveClass(
      'h-(--field-height)',
      'rounded-field',
      'border-(length:--hairline-width)',
      'border-(--border-field)',
      'bg-(--field-bg)',
      'text-b2',
      'w-full',
      'px-3'
    )
  })

  it('占位文字用达标四级灰（R6），不是 Labels-Quaternary 的原值', () => {
    render(<Input aria-label="会话名" placeholder="起个名字" />)

    const input = screen.getByLabelText('会话名')
    expect(input).toHaveAttribute('placeholder', '起个名字')
    expect(input).toHaveClass('placeholder:text-(--text-quaternary)')
  })

  it('受控输入：value 与 onChange 走原生元素', () => {
    const onChange = vi.fn()
    render(<Input aria-label="会话名" value="旧" onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('会话名'), { target: { value: '新' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('会话名')).toHaveValue('旧')
  })

  it('disabled 与 ref 透传，className 可覆盖默认档', () => {
    const ref = createRef<HTMLInputElement>()
    render(<Input ref={ref} aria-label="会话名" disabled className="h-10" />)

    const input = screen.getByLabelText('会话名')
    expect(input).toBeDisabled()
    expect(ref.current).toBe(input)
    expect(input).toHaveClass('h-10')
    expect(input).not.toHaveClass('h-(--field-height)')
  })
})

describe('Textarea', () => {
  it('同一套字段外观，高度改为最小 40 且不可拖拽（多行自增）', () => {
    render(<Textarea aria-label="提示词" />)

    expect(screen.getByLabelText('提示词')).toHaveClass(
      'min-h-(--field-height)',
      'rounded-field',
      'border-(length:--hairline-width)',
      'border-(--border-field)',
      'bg-(--field-bg)',
      'resize-none',
      'px-3',
      'py-2'
    )
    expect(screen.getByLabelText('提示词')).not.toHaveClass('h-(--field-height)')
  })

  it('多行输入：换行内容原样保留，ref 指向 textarea', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<Textarea ref={ref} aria-label="提示词" defaultValue={'第一行\n第二行'} />)

    const textarea = screen.getByLabelText('提示词')
    expect(textarea).toHaveValue('第一行\n第二行')
    expect(ref.current).toBe(textarea)
  })
})
