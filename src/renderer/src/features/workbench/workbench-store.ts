import { create } from 'zustand'

/**
 * 工作台右栏的界面状态（只放"右栏自己"的开合，不放业务数据）。
 *
 * round 39 起是**标签页模型**（用户口径：多窗口管理，参考浏览器标签）：
 *   - `tabs`：开着的标签，顺序即显示顺序；每个标签有自己的 id，**同一个工具可以开多个**
 *     （浏览器/终端每次新建都是新窗口；文件/Git 是世界状态，重复点就激活已有的那个）；
 *   - `activeTabId`：当前标签。**在 tabs 里的标签都挂载着**（切走只隐藏、不卸载 —— 终端 PTY
 *     与浏览器页面因此保活）；**关掉才卸载**（终端的 dispose 由 TerminalTool 的收尾做）；
 *   - `title`：浏览器标签的显示标题（页面标题 → 网址主机名），其余三种的标题渲染时算
 *     （文件 = 根目录名、Git = 改动、终端 = 终端）。
 *
 * 为什么不放 shell-store：那是"三栏骨架"的开关，这里是右栏内容自己的状态，改由谁都不用动骨架。
 */
export const WORKBENCH_KINDS = ['browser', 'files', 'git', 'terminal'] as const

export type WorkbenchTabKind = (typeof WORKBENCH_KINDS)[number]

export interface WorkbenchTab {
  /** 标签 id（同 kind 可开多个，所以 id 不复用 kind） */
  id: string
  kind: WorkbenchTabKind
  /** 浏览器标签的显示标题（其它 kind 不用；见上） */
  title?: string
}

export interface WorkbenchState {
  tabs: WorkbenchTab[]
  activeTabId: string
  /** 新建标签：文件/Git 已开就激活它，浏览器/终端每次都新开一个窗口 */
  openTab: (kind: WorkbenchTabKind) => void
  closeTab: (id: string) => void
  selectTab: (id: string) => void
  setTabTitle: (id: string, title: string) => void
  /** 回默认（一个「文件」标签）—— 换会话根时用；全关光的状态不自动兜底，由空态区给新建入口 */
  resetWorkbench: () => void
}

/** 标签 id 计数器（模块级：先 files-1，之后顺序往后；测试用 resetWorkbenchStore 归零） */
let seq = 0

function nextTabId(kind: WorkbenchTabKind): string {
  seq += 1
  return `${kind}-${seq}`
}

function defaultState(): Pick<WorkbenchState, 'tabs' | 'activeTabId'> {
  const tab: WorkbenchTab = { id: nextTabId('files'), kind: 'files' }
  return { tabs: [tab], activeTabId: tab.id }
}

export const useWorkbenchStore = create<WorkbenchState>()((set) => ({
  ...defaultState(),
  openTab: (kind) =>
    set((state) => {
      if (kind === 'files' || kind === 'git') {
        const existing = state.tabs.find((tab) => tab.kind === kind)
        if (existing !== undefined) return { activeTabId: existing.id }
      }
      const tab: WorkbenchTab = { id: nextTabId(kind), kind }
      return { tabs: [...state.tabs, tab], activeTabId: tab.id }
    }),
  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id)
      if (index === -1) return {}
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      if (state.activeTabId !== id) return { tabs }
      // 关掉的是当前标签：接到左边那个（没有就右边）；全关光时 activeTabId 空串 = 空态
      const next = tabs[index - 1] ?? tabs[index] ?? null
      return { tabs, activeTabId: next?.id ?? '' }
    }),
  selectTab: (id) =>
    set((state) => (state.tabs.some((tab) => tab.id === id) ? { activeTabId: id } : {})),
  setTabTitle: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab))
    })),
  resetWorkbench: () => set(defaultState())
}))

/** 浏览器标签的显示标题：页面标题优先，没有就用网址的主机名，再没有才是「浏览器」 */
export function browserTabTitle(title: string, url: string): string {
  const heading = title.trim()
  if (heading !== '') return heading
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    host = ''
  }
  return host === '' ? '浏览器' : host
}

/** 测试用：回到初始状态（模块级 store 与 id 计数器都不随 render 重置） */
export function resetWorkbenchStore(): void {
  seq = 0
  useWorkbenchStore.setState(defaultState())
}
