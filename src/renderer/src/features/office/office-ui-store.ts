import { create } from 'zustand'

/**
 * Office 工作区的**界面瞬时状态**（与标签数据分开）。
 *
 * 为什么要有它：顶栏标签栏的「＋」和 Office 空态里的「打开文件」是同一个动作的两个入口，
 * 而弹窗渲染在 OfficePage 里。两者不在同一棵组件树里（TitleBar 常驻、OfficePage 只在 /office
 * 路由上），用一阶 zustand 标志比自定义事件 / 路由 query 都干净：谁打开谁写，页面读到了就渲染。
 *
 * 只放"弹窗开没开""面板开没开"这种可以随便丢的状态；标签、activeTabId 仍在 office-tabs-store。
 *
 * A3（右侧 AI 面板）：状态拆成两层，保证「手动关优先于自动、窗口变宽恢复手动态」：
 *   - `aiPanelOpen`：**用户手动偏好**（默认开），只有用户点收起/展开才改；
 *   - `aiPanelAutoCollapsed`：**环境派生**（内容区可用宽 < 1100），由 OfficePage 的
 *     ResizeObserver 写；宽度恢复后置回 false，此时 effective 重新跟随用户偏好；
 *   - 生效值 = `resolveAiPanelOpen(aiPanelOpen, aiPanelAutoCollapsed)`（纯函数，单测直测）。
 * 这样：用户手动关 → 变宽也不会自己开；窗口变窄 → 自动收（不论用户偏好），变宽 → 回到用户偏好。
 */
export interface OfficeUiState {
  /** 「打开文件（示例）」弹窗是否打开 */
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  openPicker: () => void
  closePicker: () => void
  /** A3：用户手动偏好——右侧 AI 面板是否展开（默认开；自动收起不写这条） */
  aiPanelOpen: boolean
  setAiPanelOpen: (open: boolean) => void
  /** A3：用户点收起/展开按钮（只翻手动偏好） */
  toggleAiPanel: () => void
  /** A3：内容区宽 < OFFICE_AI_PANEL_AUTO_COLLAPSE_WIDTH 时置 true（环境派生，不持久化） */
  aiPanelAutoCollapsed: boolean
  setAiPanelAutoCollapsed: (collapsed: boolean) => void
}

/** AI 面板自动收起阈值：Office 页可用宽低于它就收（1280 窗口 ≈1218 开；1100 窗口 ≈1038 收） */
export const OFFICE_AI_PANEL_AUTO_COLLAPSE_WIDTH = 1100

/** 纯判定：可用宽是否触发自动收起（宽未知/0 视为不触发，避免测试环境/首帧误收） */
export function isAiPanelAutoCollapsed(availableWidth: number): boolean {
  if (!(availableWidth > 0)) return false
  return availableWidth < OFFICE_AI_PANEL_AUTO_COLLAPSE_WIDTH
}

/** 纯派生：生效展开 = 用户想开 且 没被自动收起（手动关优先于自动；变宽后回到用户偏好） */
export function resolveAiPanelOpen(manualOpen: boolean, autoCollapsed: boolean): boolean {
  return manualOpen && !autoCollapsed
}

export const useOfficeUiStore = create<OfficeUiState>()((set, get) => ({
  pickerOpen: false,
  setPickerOpen: (open) => set({ pickerOpen: open }),
  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false }),
  aiPanelOpen: true,
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  toggleAiPanel: () => set({ aiPanelOpen: !get().aiPanelOpen }),
  aiPanelAutoCollapsed: false,
  setAiPanelAutoCollapsed: (collapsed) =>
    // 同值时返回原 state（zustand 用 Object.is 判等 → 不通知订阅者）：ResizeObserver 抖动不重渲
    set((state) =>
      state.aiPanelAutoCollapsed === collapsed ? state : { aiPanelAutoCollapsed: collapsed }
    )
}))

/** 测试用：回到初始状态（模块级 store 不随 render 重置） */
export function resetOfficeUiStore(): void {
  useOfficeUiStore.setState({
    pickerOpen: false,
    aiPanelOpen: true,
    aiPanelAutoCollapsed: false
  })
}

/**
 * 「Office 调试信息」开关（A1）。
 *
 * S2/S3 的临时状态条（隔离面握手/主题/已收字节、保存态徽标）只给开发和探针用，正式视图
 * 不露出。显示条件：**DEV + localStorage `kyclaw:office-debug=1`**（默认关，截图/交付态干净）。
 * 关掉时元素仍在 DOM（testid / data-* 可查，e2e 探针照旧断言），只是 `hidden`。
 * 开关由开发者手动置位后刷新页面生效；隔离面沿用同一个 flag（OfficeSurface 给 URL 加 query）。
 */
export const OFFICE_DEBUG_STORAGE_KEY = 'kyclaw:office-debug'

export function officeDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return window.localStorage.getItem(OFFICE_DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
