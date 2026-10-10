import { describe, expect, it } from 'vitest'
import { cn } from '../cn'

describe('cn', () => {
  it('clsx 那半：条件与 falsy 值', () => {
    const enabled = false
    expect(cn('a', enabled ? 'b' : undefined, undefined, 'c')).toBe('a c')
  })

  it('同组冲突时后写的赢（tailwind-merge）', () => {
    expect(cn('h-8', 'h-4')).toBe('h-4')
    expect(cn('bg-menu', 'bg-hover')).toBe('bg-hover')
  })

  it('字阶与文字颜色是两组，互不顶掉（t1/t2/b1/b2/c1/c2 已在 extend 里声明）', () => {
    expect(cn('text-b2', 'text-ink')).toBe('text-b2 text-ink')
    expect(cn('text-b2', 'text-(--tooltip-fg)')).toBe('text-b2 text-(--tooltip-fg)')
    expect(cn('text-b2 text-(--tooltip-fg)', 'text-c2')).toBe('text-(--tooltip-fg) text-c2')
  })

  it('组件默认档能被调用方按组覆盖（圆角档名 / 主题色 / var 简写 / 缓动）', () => {
    expect(cn('rounded-icon-button', 'rounded-control')).toBe('rounded-control')
    expect(cn('rounded-(--menu-item-radius)', 'rounded-control')).toBe('rounded-control')
    expect(cn('h-(--control-height-md)', 'h-8')).toBe('h-8')
    expect(cn('bg-(--button-primary-bg)', 'bg-menu')).toBe('bg-menu')
    expect(cn('ease-main', 'ease-linear')).toBe('ease-linear')
  })

  it('不同组各管各的：高度、内边距、字号、颜色可以并存', () => {
    expect(cn('h-8 px-2 text-b2 text-ink')).toBe('h-8 px-2 text-b2 text-ink')
  })
})
