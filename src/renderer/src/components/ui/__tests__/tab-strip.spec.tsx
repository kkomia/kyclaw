import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { handleTabListKeyDown, tabCloseClass, tabTriggerClass } from '../tab-strip'

function mountTabs(onPick = vi.fn()): void {
  render(
    <div role="tablist" onKeyDown={handleTabListKeyDown}>
      {['a', 'b', 'c'].map((id) => (
        <button
          key={id}
          role="tab"
          data-testid={`tab-${id}`}
          aria-selected={id === 'a'}
          tabIndex={id === 'a' ? 0 : -1}
          onClick={() => onPick(id)}
        >
          {id}
        </button>
      ))}
    </div>
  )
}

describe('TabStrip 家族规格 + roving（task-103）', () => {
  it('顶栏/右栏共用文字、圆角、动效 token；形态可不同', () => {
    for (const className of [tabTriggerClass('app', true), tabTriggerClass('workbench', true)]) {
      expect(className).toContain('text-b2')
      expect(className).toContain('rounded-control')
      expect(className).toContain('duration-(--motion-fast)')
      expect(className).toContain('gap-1.5')
    }
    expect(tabTriggerClass('app', true)).toContain('bg-surface')
    expect(tabTriggerClass('workbench', true)).toContain('bg-selected')
    expect(tabTriggerClass('app', true)).toContain('h-full')
    expect(tabTriggerClass('workbench', true)).toContain('h-7')
  })

  it('关闭钮同族：同定位/圆角/动效；顶栏 20 右栏 20（icon-lg vs size-5）', () => {
    const app = tabCloseClass('app', false)
    const wb = tabCloseClass('workbench', false)
    for (const className of [app, wb]) {
      expect(className).toContain('absolute top-1/2 right-1')
      expect(className).toContain('rounded-badge')
      expect(className).toContain('duration-(--motion-fast)')
    }
    expect(app).toContain('size-(--icon-size-lg)')
    expect(wb).toContain('size-5')
  })

  it('roving：←/→ 移动焦点、Home/End 到首尾、Enter 激活（只在当前 tablist）', () => {
    const onPick = vi.fn()
    mountTabs(onPick)
    const first = screen.getByTestId('tab-a')
    const second = screen.getByTestId('tab-b')
    const third = screen.getByTestId('tab-c')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'End' })
    expect(third).toHaveFocus()
    fireEvent.keyDown(third, { key: 'ArrowRight' })
    expect(first).toHaveFocus() // 环回
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(third).toHaveFocus()
    fireEvent.keyDown(third, { key: 'Home' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('a')
  })

  it('roving 不跨 tablist：空的/别人的 tablist 不参与', () => {
    const onPick = vi.fn()
    mountTabs(onPick)
    const other = document.createElement('div')
    other.setAttribute('role', 'tablist')
    const tab = document.createElement('button')
    tab.setAttribute('role', 'tab')
    other.appendChild(tab)
    document.body.appendChild(other)
    tab.focus()
    fireEvent.keyDown(tab, { key: 'ArrowRight' })
    expect(tab).toHaveFocus()
    other.remove()
  })
})
