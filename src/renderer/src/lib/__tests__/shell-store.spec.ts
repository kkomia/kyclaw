import { beforeEach, describe, expect, it } from 'vitest'
import { useShellStore } from '../shell-store'

beforeEach(() => {
  // store 是模块级单例：每个用例前回到默认态
  useShellStore.setState({ sidebarCollapsed: false, workPanelOpen: false })
})

describe('壳布局 store（zustand）', () => {
  it('默认：侧栏展开、工作台面板收起', () => {
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)
    expect(useShellStore.getState().workPanelOpen).toBe(false)
  })

  it('toggleSidebar 翻转侧栏折叠态', () => {
    useShellStore.getState().toggleSidebar()
    expect(useShellStore.getState().sidebarCollapsed).toBe(true)

    useShellStore.getState().toggleSidebar()
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)
  })

  it('toggleWorkPanel 翻转面板态，且不牵动侧栏', () => {
    useShellStore.getState().toggleWorkPanel()
    expect(useShellStore.getState().workPanelOpen).toBe(true)
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)

    useShellStore.getState().toggleWorkPanel()
    expect(useShellStore.getState().workPanelOpen).toBe(false)
  })
})
