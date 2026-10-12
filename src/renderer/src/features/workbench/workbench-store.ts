import { create } from 'zustand'
import { baseNameOf } from './preview/fetch'

/**
 * 工作台右栏的界面状态（只放"右栏自己"的开合，不放业务数据）。
 *
 * round 39 起是**标签页模型**（用户口径：多窗口管理，参考浏览器标签）：
 *   - `tabs`：开着的标签，顺序即显示顺序；每个标签有自己的 id，**同一个工具可以开多个**
 *     （浏览器/终端每次新建都是新窗口；文件/Git 是世界状态，重复点就激活已有的那个）；
 *   - `activeTabId`：当前标签。**在 tabs 里的标签都挂载着**（切走只隐藏、不卸载 —— 终端 PTY
 *     与浏览器页面因此保活）；**关掉才卸载**（终端的 dispose 由 TerminalTool 的收尾做）；
 *   - `title`：浏览器标签的显示标题（页面标题 → 网址主机名）、预览标签的**文件名**，
 *     其余三种的标题渲染时算（文件 = 根目录名、Git = 改动、终端 = 终端）。
 *
 * round 49（用户补充口径）：
 *   - **启动是空态**：不再默认开一个「文件」标签（原话"保持什么都没有得状态就可以了"；
 *     空态区自己给四个新建入口）。`closeTab` 关到最后一个就已经是空态，不需要兜底标签；
 *   - **标签按根记忆**：换根（切项目 / 移至项目 / 默认工作区变化）时把当前标签存进**旧根的存根**、
 *     装上新根上次离开时的样子（没有存根 = 空态）——"打开了一个网页一个终端，切走再切回来还要有"。
 *     存根只在内存里：**重启不恢复**（启动一律空态，与上一条同一个口径）。
 *
 * round 50：第四种"内容型"标签 —— `preview`（文件预览）。它与上面四种工具不同：**开哪个标签
 * 由内容（相对路径）决定**，所以只有 `openPreviewTab(relPath)` 这一个入口（**按 path 去重**：
 * 同一份文件只开一个标签，重复打开就激活已有的那个）。文件名存在 `title` 里（标签显示名用它），
 * 路径存在 `path` 里（去重键）。开面板不在这里做（那是 shell-store 的事，调用方自己开）。
 *
 * 为什么不放 shell-store：那是"三栏骨架"的开关，这里是右栏内容自己的状态，改由谁都不用动骨架。
 */
export const WORKBENCH_KINDS = ['browser', 'files', 'git', 'terminal', 'preview'] as const

export type WorkbenchTabKind = (typeof WORKBENCH_KINDS)[number]

export interface WorkbenchTab {
  /** 标签 id（同 kind 可开多个，所以 id 不复用 kind） */
  id: string
  kind: WorkbenchTabKind
  /** 浏览器标签的显示标题（其它 kind 不用；见上）；预览标签存**文件名** */
  title?: string
  /** 预览标签看的**工作区相对路径**（同时是去重键；其它 kind 没有） */
  path?: string
}

/** 一个根"上次离开时"的标签样子（内存态；见头注的 round 49 口径） */
interface WorkbenchSnapshot {
  tabs: WorkbenchTab[]
  activeTabId: string
}

export interface WorkbenchState {
  tabs: WorkbenchTab[]
  activeTabId: string
  /** 当前根（`''` = 还没有根/判不出）——switchRoot 据此存旧、取新 */
  currentRoot: string
  /** 每个根上次离开时的存根（不持久化；重启即空） */
  stash: Record<string, WorkbenchSnapshot>
  /** 新建标签：文件/Git 已开就激活它，浏览器/终端每次都新开一个窗口 */
  openTab: (kind: WorkbenchTabKind) => void
  /**
   * round 50：开一个文件预览标签（`relPath` = 工作区相对路径）。**按 path 去重** ——
   * 同一份文件已经开着就只激活它（不重复开），否则新开一个（`title` = 文件名）。
   * **不开面板**：那是 shell-store 的开关，由调用方自己开（store 不越界）。
   */
  openPreviewTab: (relPath: string) => void
  closeTab: (id: string) => void
  selectTab: (id: string) => void
  setTabTitle: (id: string, title: string) => void
  /**
   * 换根：把当前标签存进旧根、装上新根上次的样子（没有 = 空态）；同根调用是空操作。
   * `null`（判不出根）按空键处理——"没有会话"也是一档状态，一样记住。
   * 面板收起不在这里（那是 shell-store 的事，Workbench 的变根 effect 一并做）。
   */
  switchRoot: (nextRoot: string | null) => void
}

/** 标签 id 计数器（模块级：先 files-1，之后顺序往后；测试用 resetWorkbenchStore 归零） */
let seq = 0

function nextTabId(kind: WorkbenchTabKind): string {
  seq += 1
  return `${kind}-${seq}`
}

function emptySnapshot(): WorkbenchSnapshot {
  return { tabs: [], activeTabId: '' }
}

export const useWorkbenchStore = create<WorkbenchState>()((set) => ({
  ...emptySnapshot(),
  currentRoot: '',
  stash: {},
  openTab: (kind) =>
    set((state) => {
      if (kind === 'files' || kind === 'git') {
        const existing = state.tabs.find((tab) => tab.kind === kind)
        if (existing !== undefined) return { activeTabId: existing.id }
      }
      const tab: WorkbenchTab = { id: nextTabId(kind), kind }
      return { tabs: [...state.tabs, tab], activeTabId: tab.id }
    }),
  openPreviewTab: (relPath) =>
    set((state) => {
      const existing = state.tabs.find((tab) => tab.kind === 'preview' && tab.path === relPath)
      if (existing !== undefined) return { activeTabId: existing.id }
      const tab: WorkbenchTab = {
        id: nextTabId('preview'),
        kind: 'preview',
        path: relPath,
        title: previewTitleOf(relPath)
      }
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
  switchRoot: (nextRoot) =>
    set((state) => {
      const key = nextRoot ?? ''
      if (state.currentRoot === key) return {}
      const stash = {
        ...state.stash,
        [state.currentRoot]: { tabs: state.tabs, activeTabId: state.activeTabId }
      }
      const restored = stash[key] ?? emptySnapshot()
      return { ...restored, stash, currentRoot: key }
    })
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

/** 相对路径的**文件名**（正反斜杠都认；没有就是整串）——与 preview/fetch 的 baseNameOf 同一口径 */
export function previewTitleOf(relPath: string): string {
  return baseNameOf(relPath)
}

/** 测试用：回到初始状态（模块级 store 与 id 计数器都不随 render 重置） */
export function resetWorkbenchStore(): void {
  seq = 0
  useWorkbenchStore.setState({ ...emptySnapshot(), currentRoot: '', stash: {} })
}
