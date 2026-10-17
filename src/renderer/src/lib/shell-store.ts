import { create } from 'zustand'

/**
 * 壳布局状态（只放"三栏骨架"自己的开关，不放业务状态）。
 * 一级导航 = 固定图标栏（2026-10-17 起没有展开/折叠两档，故这里不再有相关字段）；
 * 侧栏折叠 = 内容卡**内部**的二级栏宽度收 0（flow，主列/工作台几何跟着重排）；
 * 工作台面板开关 = 右栏收放。
 * `setWorkPanelOpen` 给"关面板"用（▯ / 变根收起 / 路由离开对话区，不走 toggle）。
 *
 * round 39 增补（用户口径）：
 *   - `workPanelWidth`：拖拽调宽的宽度（px，内存态，与 workPanelOpen 同生命周期）；
 *   - `workPanelFullscreen`：面板占满内容区（中列 hidden 但不卸载）——**用户偏好**，
 *     只有用户按 ⤢ / 关面板才变；
 *   - 关闭面板一律把全屏一并复位（▯ / 变根收起 / 路由离开对话区，走的都是这两个动作之一）。
 *
 * round 77 增补（窄窗兜底改成"临时铺满"）：
 *   - `workPanelFit`：AppShell 量到的**布局事实**（内容卡实测宽 / 侧栏占宽 / 面板宽 / 中列最小可读宽），
 *     面板关着或量不到时是 null。空间判定、"恢复并排"、"返回对话"都从这一份读，**不再二次量 DOM**。
 *   - 它是布局结果，不是偏好：宽窗恢复、面板关掉都自动回 null/false，用户的 `workPanelFullscreen`
 *     一个字节都不动。
 *   - 判断与落点用纯函数（`isWorkPanelSpaceConstrained` / `canRestoreSplitLayout` /
 *     `restoredPanelWidth`），所以口径可单测、不依赖 jsdom 的布局。
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

/**
 * 可用宽判定（round 77）的输入：三栏里"抢占"可见宽的那几件。
 * 内容卡内部是一条 flex 行（会话侧栏 | 主列 | 工作台，见 ContentRegion），所以侧栏与面板都是
 * flex 兄弟，各占一段宽：safeLeft = 侧栏占宽（展开 --sidebar-width / 收起 0；无二级栏的模块 0），
 * panelWidth = **拖过的那条**实际宽（不是 token 默认档）——于是"拖宽过再缩窗"也会被判成空间不足。
 * （覆盖层时代 safeLeft 表示"遮住内容区左缘"的宽，2026-10-17 侧栏进卡后变成"卡内 flow 占宽"，
 * 数值口径不变，故公式与用例都沿用。）
 */
export interface WorkbenchFit {
  /** 内容卡实测宽（壳行宽扣掉右缘 --shell-edge-gap 留缝） */
  contentWidth: number
  /** 卡内会话侧栏占掉的宽：展开 = --sidebar-width，收起（宽 0）= 0 */
  safeLeft: number
  /** 工作台 docked 时的宽度（store 的 workPanelWidth，可被拖宽） */
  panelWidth: number
  /** 中列最小可读宽（token --chat-min-readable-width） */
  minChatWidth: number
}

/** 工作台 docked 摆开后，中列还剩多少可见宽（扣侧栏占宽，不会为负） */
export function dockedChatWidth(fit: WorkbenchFit): number {
  return Math.max(0, fit.contentWidth - fit.safeLeft - fit.panelWidth)
}

/**
 * 空间不足：docked 摆开会把中列挤到最小可读宽以下 → 工作台改铺满内容区（不关面板、不挤压聊天）。
 * 判据里侧栏占宽 / 面板宽度 / 内容卡宽都是实测值，所以没有"1120 那种固定阈值"——
 * 收侧栏、拖窄面板、窗口变宽都会立刻改变结论。
 * fit 为 null（面板关着 / 量不到布局）= 没有占用宽的面板，一律当"不铺满"。
 */
export function isWorkPanelSpaceConstrained(fit: WorkbenchFit | null): boolean {
  return fit !== null && dockedChatWidth(fit) < fit.minChatWidth
}

/** 并排回落点留的余量（px）：贴边落点（中列正好 480）会被亚像素/取整推回"放不下"，留一格再落 */
const SPLIT_RESTORE_MARGIN = 8

/** docked 还想让中列守住最小可读宽时，面板最大能有多宽（贴边值，可能小于面板下限） */
export function maxPanelWidthForSplit(fit: WorkbenchFit): number {
  return Math.max(0, fit.contentWidth - fit.safeLeft - fit.minChatWidth)
}

/**
 * 还能靠"收窄面板"回到并排吗：留出余量后仍不低于面板下限 280。
 * 800 这种真窄窗算出来是 false（794 − 240 − 480 = 74），此时唯一出路是关面板回对话。
 */
export function canRestoreSplitLayout(fit: WorkbenchFit): boolean {
  return maxPanelWidthForSplit(fit) - SPLIT_RESTORE_MARGIN >= WORK_PANEL_MIN_WIDTH
}

/**
 * "恢复并排布局"的落点：贴边上限减余量，再夹进 280–760；**只往窄收**（绝不把用户拖的宽度撑大）。
 */
export function restoredPanelWidth(fit: WorkbenchFit, currentWidth: number): number {
  return clampWorkPanelWidth(
    Math.min(currentWidth, maxPanelWidthForSplit(fit) - SPLIT_RESTORE_MARGIN)
  )
}

function sameFit(left: WorkbenchFit | null, right: WorkbenchFit | null): boolean {
  if (left === null || right === null) return left === right
  return (
    left.contentWidth === right.contentWidth &&
    left.safeLeft === right.safeLeft &&
    left.panelWidth === right.panelWidth &&
    left.minChatWidth === right.minChatWidth
  )
}

export interface ShellState {
  sidebarCollapsed: boolean
  workPanelOpen: boolean
  /** 工作台宽度（px；拖动时改，双击把手回默认） */
  workPanelWidth: number
  /** 工作台全屏（占满内容区，中列让位但不卸载）—— 用户偏好 */
  workPanelFullscreen: boolean
  /** 壳的实测布局事实（AppShell 量；面板关着 / 量不到 = null）。空间判定与恢复落点都读它 */
  workPanelFit: WorkbenchFit | null
  toggleSidebar: () => void
  toggleWorkPanel: () => void
  setWorkPanelOpen: (open: boolean) => void
  /** containerWidth = 内容区实测宽（拖动时传，用来算 70% 上限） */
  setWorkPanelWidth: (width: number, containerWidth?: number) => void
  toggleWorkPanelFullscreen: () => void
  /** 只有 AppShell 写它（量到壳宽之后）；facts 没变不通知，避免 resize 期间空转 */
  setWorkPanelFit: (fit: WorkbenchFit | null) => void
  /** auto 形态下的"恢复并排布局"：把面板宽收到能并排的上限（不动 fullscreen 偏好、不关面板） */
  restoreSideBySideLayout: () => boolean
}

export const useShellStore = create<ShellState>()((set, get) => ({
  sidebarCollapsed: false,
  workPanelOpen: false,
  workPanelWidth: WORK_PANEL_DEFAULT_WIDTH,
  workPanelFullscreen: false,
  workPanelFit: null,
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
    })),
  setWorkPanelFit: (fit) =>
    set((state) => (sameFit(state.workPanelFit, fit) ? state : { workPanelFit: fit })),
  restoreSideBySideLayout: () => {
    const state = get()
    const fit = state.workPanelFit
    if (fit === null || !canRestoreSplitLayout(fit)) return false
    set({ workPanelWidth: restoredPanelWidth(fit, state.workPanelWidth) })
    return true
  }
}))
