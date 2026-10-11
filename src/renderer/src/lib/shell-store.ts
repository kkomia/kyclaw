import { create } from 'zustand'

/**
 * 壳布局状态（只放"三栏骨架"自己的开关，不放业务状态）。
 * 侧栏折叠 = 覆盖层滑出（主列几何不变）；工作台面板开关 = 右栏收放。
 * `setWorkPanelOpen` 给"窄窗自动收工作台"用（AppShell 的 ResizeObserver 直接置位，不走 toggle）。
 *
 * round 39 增补（用户口径）：
 *   - `workPanelWidth`：拖拽调宽的宽度（px，内存态，与 workPanelOpen 同生命周期）；
 *   - `workPanelFullscreen`：面板占满内容区（中列 hidden 但不卸载）；
 *   - 关闭面板一律把全屏一并复位（▯ / 窄窗自动收 / 变根收起，走的都是这两个动作之一）。
 */

/** 默认宽 = 语义 token --work-panel-width 的值（新装/未拖过时就是它） */
export const WORK_PANEL_DEFAULT_WIDTH = 400
/** 拖拽下限（再窄就放不下工具条了） */
export const WORK_PANEL_MIN_WIDTH = 280
/** 拖拽上限（再宽内容列就没得看了） */
export const WORK_PANEL_MAX_WIDTH = 760
/** 拖动时给内容列留的占比：面板不得超过内容区宽的 70% */
const WORK_PANEL_MAX_RATIO = 0.7
/** 内容区宽度上限取整用（避免 0.5px 的宽度让 xterm 反复 fit） */
const WIDTH_STEP = 1

/**
 * 宽度夹取（纯函数，好单测）：
 *   - 上限 = min(760, 容器宽 × 70%)——不挤死内容列，这条优先；
 *   - 下限 = min(280, 上限)——容器极窄（70% < 280）时让位给上限，宁可更窄也不越界；
 *   - 容器宽拿不到（0 / 未传）时只按 280–760 夹。
 */
export function clampWorkPanelWidth(width: number, containerWidth?: number): number {
  const ratioCap =
    containerWidth !== undefined && containerWidth > 0
      ? Math.floor(containerWidth * WORK_PANEL_MAX_RATIO)
      : WORK_PANEL_MAX_WIDTH
  const ceiling = Math.max(WIDTH_STEP, Math.min(WORK_PANEL_MAX_WIDTH, ratioCap))
  const floor = Math.min(WORK_PANEL_MIN_WIDTH, ceiling)
  if (!Number.isFinite(width)) return WORK_PANEL_DEFAULT_WIDTH
  return Math.min(Math.max(Math.round(width), floor), ceiling)
}

export interface ShellState {
  sidebarCollapsed: boolean
  workPanelOpen: boolean
  /** 工作台宽度（px；拖动时改，双击把手回默认） */
  workPanelWidth: number
  /** 工作台全屏（占满内容区，中列让位但不卸载） */
  workPanelFullscreen: boolean
  toggleSidebar: () => void
  toggleWorkPanel: () => void
  setWorkPanelOpen: (open: boolean) => void
  /** containerWidth = 内容区实测宽（拖动时传，用来算 70% 上限） */
  setWorkPanelWidth: (width: number, containerWidth?: number) => void
  toggleWorkPanelFullscreen: () => void
}

export const useShellStore = create<ShellState>()((set) => ({
  sidebarCollapsed: false,
  workPanelOpen: false,
  workPanelWidth: WORK_PANEL_DEFAULT_WIDTH,
  workPanelFullscreen: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleWorkPanel: () =>
    set((state) =>
      state.workPanelOpen
        ? { workPanelOpen: false, workPanelFullscreen: false }
        : { workPanelOpen: true }
    ),
  setWorkPanelOpen: (open) =>
    set(open ? { workPanelOpen: true } : { workPanelOpen: false, workPanelFullscreen: false }),
  setWorkPanelWidth: (width, containerWidth) =>
    set({ workPanelWidth: clampWorkPanelWidth(width, containerWidth) }),
  // 全屏是"面板的一种形态"：没有面板就没有全屏，所以它顺带把面板打开
  toggleWorkPanelFullscreen: () =>
    set((state) => ({
      workPanelOpen: true,
      workPanelFullscreen: !state.workPanelFullscreen
    }))
}))
