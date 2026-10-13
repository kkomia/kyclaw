import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { commandKeyLabel, matchNewSessionShortcut } from '../session-shortcuts'
import { resetSessionsStore, useSessionsStore } from '../sessions-store'
import { useNewSessionShortcut } from '../use-new-session-shortcut'

/**
 * 全局「新建会话」快捷键（round 64，Ctrl+K / Cmd+K）：
 *   - 判定是纯函数（matchNewSessionShortcut，与 workbench-actions 同一写法）；
 *   - 监听挂在 window 上（useNewSessionShortcut）——所以输入框里按也生效、任何路由都生效。
 * 键帽显示与判定共用 session-shortcuts 这一处（macOS 画 ⌘，其余画 Ctrl）。
 */

function ShortcutHarness(): React.JSX.Element {
  useNewSessionShortcut()
  return (
    <>
      <textarea data-testid="composer" />
      <div data-testid="location">{useLocation().pathname}</div>
    </>
  )
}

function renderHarness(path = '/settings'): { unmount: () => void } {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutHarness />
    </MemoryRouter>
  )
}

/** 真派发一个 KeyboardEvent（能验 preventDefault，不只是"回调被调用"）；act 里派发，路由更新才冲刷 */
function press(options: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...options })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  resetSessionsStore()
})

describe('matchNewSessionShortcut（纯判定）', () => {
  it('Ctrl+K / Cmd+K 都算（左右 Ctrl 与 ⌘ 不分平台）；字母大小写不分', () => {
    expect(matchNewSessionShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBe(
      true
    )
    expect(matchNewSessionShortcut(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true }))).toBe(
      true
    )
    expect(matchNewSessionShortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))).toBe(
      true
    )
  })

  it('多按了 Shift/Alt 不算（那是别的快捷键的地盘）；别的键不算', () => {
    expect(
      matchNewSessionShortcut(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true })
      )
    ).toBe(false)
    expect(
      matchNewSessionShortcut(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true })
      )
    ).toBe(false)
    expect(matchNewSessionShortcut(new KeyboardEvent('keydown', { key: 'k' }))).toBe(false)
    expect(matchNewSessionShortcut(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }))).toBe(
      false
    )
    // 不回抢工作台的 Ctrl+Shift+E/G（本判定本身就不认 e/g）
    expect(
      matchNewSessionShortcut(
        new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, shiftKey: true })
      )
    ).toBe(false)
  })
})

describe('commandKeyLabel（键帽显示）', () => {
  it('macOS 画 ⌘，其余平台（含认不出的环境）画 Ctrl', () => {
    expect(commandKeyLabel('MacIntel')).toBe('⌘')
    expect(commandKeyLabel('Mac OS X')).toBe('⌘')
    expect(commandKeyLabel('Win32')).toBe('Ctrl')
    expect(commandKeyLabel('Linux x86_64')).toBe('Ctrl')
    expect(commandKeyLabel('')).toBe('Ctrl')
  })
})

describe('useNewSessionShortcut（挂在 window 上的真实路径）', () => {
  it('设置页按 Ctrl+K：开一个无项目草稿并回对话页；事件被吞掉（preventDefault）', () => {
    renderHarness('/settings')

    const event = press({ key: 'k', ctrlKey: true })

    expect(useSessionsStore.getState().activeId).not.toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
    expect(event.defaultPrevented).toBe(true)
  })

  it('macOS 上按 Cmd+K 走同一条路（metaKey）', () => {
    renderHarness('/settings')

    press({ key: 'k', metaKey: true })

    expect(useSessionsStore.getState().activeId).not.toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('焦在输入框里按也生效（Ctrl+K 没有默认编辑行为，事件照常冒到 window）', () => {
    renderHarness('/settings')

    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'k', ctrlKey: true })

    expect(useSessionsStore.getState().activeId).not.toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('没命中的键什么都不做（普通 k / Ctrl+Shift+K）', () => {
    renderHarness('/settings')

    press({ key: 'k' })
    press({ key: 'k', ctrlKey: true, shiftKey: true })

    expect(useSessionsStore.getState().activeId).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/settings')
  })

  it('卸载后摘掉监听（不留全局钩子）', () => {
    const view = renderHarness('/settings')
    view.unmount()

    press({ key: 'k', ctrlKey: true })

    expect(useSessionsStore.getState().activeId).toBeNull()
  })

  it('别人先认领了这一下（preventDefault）就不抢：输入框把它用掉时不开新会话', () => {
    renderHarness('/settings')

    // 更内层（textarea 自己）的处理先跑：认领了就轮不到壳上的全局快捷键
    const own = (event: KeyboardEvent): void => event.preventDefault()
    window.addEventListener('keydown', own, { capture: true })
    try {
      press({ key: 'k', ctrlKey: true })
    } finally {
      window.removeEventListener('keydown', own, { capture: true })
    }

    expect(useSessionsStore.getState().activeId).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/settings')
  })

  it('连按两次 = 两个不同的草稿（与点按钮一样，每次都是新会话）', () => {
    renderHarness('/chat')

    press({ key: 'k', ctrlKey: true })
    const first = useSessionsStore.getState().activeId
    press({ key: 'k', ctrlKey: true })

    expect(useSessionsStore.getState().activeId).not.toBe(first)
  })
})
