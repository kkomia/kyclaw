import { create } from 'zustand'

/**
 * 壳布局状态（只放"三栏骨架"自己的开关，不放业务状态）。
 * 侧栏折叠 = 覆盖层滑出（主列几何不变）；工作台面板开关 = 右栏 400 收放。
 */
export interface ShellState {
  sidebarCollapsed: boolean
  workPanelOpen: boolean
  toggleSidebar: () => void
  toggleWorkPanel: () => void
}

export const useShellStore = create<ShellState>()((set) => ({
  sidebarCollapsed: false,
  workPanelOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleWorkPanel: () => set((state) => ({ workPanelOpen: !state.workPanelOpen }))
}))
