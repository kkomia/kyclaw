/**
 * 工作台的四工具动作表与快捷键口径（纯数据 + 纯函数，独立成 .ts 是因为 React 组件文件只许导出组件）。
 *
 * 空态那一列（EmptyActions）与 Workbench 的窗口级快捷键**共用这一张表**：显示了就必须能用，
 * 也不会有"改了键帽忘了改监听"的漂移。
 */
import { FolderTree, GitBranch, Globe, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { WorkbenchTabKind } from './workbench-store'

export interface WorkbenchAction {
  kind: WorkbenchTabKind
  /** 行的用词（Git 行沿用标签标题那套「改动」） */
  label: string
  /** 图标沿用标签页那套（Workbench 的 TAB_ICON 是同四个） */
  icon: LucideIcon
  /** 键帽：逐个单键，顺序就是按法 */
  keys: readonly string[]
}

/** 空态四行：顺序即显示顺序 */
export const WORKBENCH_ACTIONS: readonly WorkbenchAction[] = [
  { kind: 'browser', label: '浏览器', icon: Globe, keys: ['Ctrl', 'T'] },
  { kind: 'files', label: '文件', icon: FolderTree, keys: ['Ctrl', 'Shift', 'E'] },
  { kind: 'git', label: '改动', icon: GitBranch, keys: ['Ctrl', 'Shift', 'G'] },
  { kind: 'terminal', label: '终端', icon: SquareTerminal, keys: ['Ctrl', '`'] }
]

/**
 * 键盘事件 → 要开的标签（没命中给 null）。
 * 宽容口径：左右 Ctrl 不分、字母大小写不分（Ctrl+Shift+E 在多数布局下 event.key 是 'E'）、
 * 反引号同时认 '`' 与 'Backquote'（不同布局/实现给的键名不一）。多按了 Alt/Meta 不算 ——
 * 那是别的快捷键的地盘。只认键帽上写着的那四个组合，Ctrl+E 之类不顺手多开。
 */
export function matchWorkbenchShortcut(event: KeyboardEvent): WorkbenchTabKind | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (!event.shiftKey && key === 't') return 'browser'
  if (event.shiftKey && key === 'e') return 'files'
  if (event.shiftKey && key === 'g') return 'git'
  if (!event.shiftKey && (key === '`' || key === 'backquote')) return 'terminal'
  return null
}
