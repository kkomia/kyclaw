import { create } from 'zustand'

/**
 * Office 工作区的**界面瞬时状态**（与标签数据分开）。
 *
 * 为什么要有它：顶栏标签栏的「＋」和 Office 空态里的「打开文件」是同一个动作的两个入口，
 * 而弹窗渲染在 OfficePage 里。两者不在同一棵组件树里（TitleBar 常驻、OfficePage 只在 /office
 * 路由上），用一阶 zustand 标志比自定义事件 / 路由 query 都干净：谁打开谁写，页面读到了就渲染。
 *
 * 只放"弹窗开没开"这种可以随便丢的状态；标签、activeTabId 仍在 office-tabs-store。
 */
export interface OfficeUiState {
  /** 「打开文件（示例）」弹窗是否打开 */
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  openPicker: () => void
  closePicker: () => void
}

export const useOfficeUiStore = create<OfficeUiState>()((set) => ({
  pickerOpen: false,
  setPickerOpen: (open) => set({ pickerOpen: open }),
  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false })
}))

/** 测试用：回到初始状态（模块级 store 不随 render 重置） */
export function resetOfficeUiStore(): void {
  useOfficeUiStore.setState({ pickerOpen: false })
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
