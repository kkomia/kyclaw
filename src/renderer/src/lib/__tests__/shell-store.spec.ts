import { beforeEach, describe, expect, it } from 'vitest'
import { clampWorkPanelWidth, useShellStore } from '../shell-store'

beforeEach(() => {
  // store 是模块级单例：每个用例前回到默认态
  useShellStore.setState({
    sidebarCollapsed: false,
    workPanelOpen: false,
    workPanelWidth: 400,
    workPanelFullscreen: false
  })
})

describe('壳布局 store（zustand）', () => {
  it('默认：侧栏展开、工作台面板收起、宽 400、不全屏', () => {
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)
    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(useShellStore.getState().workPanelWidth).toBe(400)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
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

describe('工作台宽度（round 39 拖拽调宽）', () => {
  it('setWorkPanelWidth：夹在 280–760（容器宽未知时）', () => {
    useShellStore.getState().setWorkPanelWidth(100)
    expect(useShellStore.getState().workPanelWidth).toBe(280)

    useShellStore.getState().setWorkPanelWidth(1200)
    expect(useShellStore.getState().workPanelWidth).toBe(760)

    useShellStore.getState().setWorkPanelWidth(520.4)
    expect(useShellStore.getState().workPanelWidth).toBe(520)
  })

  it('拖动时按内容区实测宽再夹一层 70% 上限（这条优先于 280 下限）', () => {
    // 内容区 1000 → 70% = 700（比 760 更紧）
    useShellStore.getState().setWorkPanelWidth(900, 1000)
    expect(useShellStore.getState().workPanelWidth).toBe(700)

    // 内容区 1600 → 70% = 1120，比 760 松 → 取 760
    useShellStore.getState().setWorkPanelWidth(900, 1600)
    expect(useShellStore.getState().workPanelWidth).toBe(760)

    // 极窄内容区 300 → 70% = 210 < 280：宁可更窄，也不越界挤死内容列
    useShellStore.getState().setWorkPanelWidth(500, 300)
    expect(useShellStore.getState().workPanelWidth).toBe(210)
    expect(clampWorkPanelWidth(1200, 0)).toBe(760)
    expect(clampWorkPanelWidth(Number.NaN, 1000)).toBe(400)
  })
})

describe('工作台全屏（round 39）', () => {
  it('toggleWorkPanelFullscreen 翻转并保证面板是开的', () => {
    useShellStore.getState().toggleWorkPanelFullscreen()
    expect(useShellStore.getState().workPanelFullscreen).toBe(true)
    expect(useShellStore.getState().workPanelOpen).toBe(true)

    useShellStore.getState().toggleWorkPanelFullscreen()
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
  })

  it('关面板（▯ / 窄窗自动收 / 变根收起）都把全屏一并复位', () => {
    useShellStore.setState({ workPanelOpen: true, workPanelFullscreen: true })
    useShellStore.getState().setWorkPanelOpen(false)
    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)

    useShellStore.setState({ workPanelOpen: true, workPanelFullscreen: true })
    useShellStore.getState().toggleWorkPanel()
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
  })
})
