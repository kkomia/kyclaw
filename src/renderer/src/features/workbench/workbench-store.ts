import { create } from 'zustand'

/**
 * 工作台的界面状态（只放"右栏工具自己"的开合，不放业务数据）：
 *   - `activeTab`：当前选中的工具（四个之一）；**记住上次选的**（内存态，重开应用回到默认）；
 *   - `mounted`：已经挂载过的工具（懒挂载 + 保活）—— 终端切走不能重挂（那会杀掉 PTY），
 *     浏览器切走也不该整页重载，所以挂在列表里的面板只隐藏、不卸载。
 *
 * 为什么不放 shell-store：那是"三栏骨架"的开关，这里是右栏内容自己的状态，改由谁都不用动骨架。
 */
export const WORKBENCH_TABS = ['browser', 'files', 'git', 'terminal'] as const

export type WorkbenchTab = (typeof WORKBENCH_TABS)[number]

export interface WorkbenchState {
  activeTab: WorkbenchTab
  /** 挂载过的工具（顺序无关，只是"挂过没有"的集合语义） */
  mounted: WorkbenchTab[]
  select: (tab: WorkbenchTab) => void
}

export const useWorkbenchStore = create<WorkbenchState>()((set) => ({
  activeTab: 'files',
  mounted: ['files'],
  select: (tab) =>
    set((state) => ({
      activeTab: tab,
      mounted: state.mounted.includes(tab) ? state.mounted : [...state.mounted, tab]
    }))
}))

/** 测试用：回到初始状态（模块级 store 不随 render 重置） */
export function resetWorkbenchStore(): void {
  useWorkbenchStore.setState({ activeTab: 'files', mounted: ['files'] })
}
