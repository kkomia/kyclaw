import { useShellStore } from '@renderer/lib/shell-store'
import { MainColumn } from './MainColumn'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'
import { WorkPanel } from './WorkPanel'

/**
 * 应用壳（spec §6.2 三栏骨架）：顶栏 42 + 左栏 240（覆盖层可折叠）+ 中列 flex-1 + 右栏 400（可收起）。
 * 布局状态只从这里接 store 的分档，往下都是 props —— 组件自身不直接订阅 store，好单测。
 */
export function AppShell(): React.JSX.Element {
  const sidebarCollapsed = useShellStore((state) => state.sidebarCollapsed)
  const workPanelOpen = useShellStore((state) => state.workPanelOpen)
  const toggleSidebar = useShellStore((state) => state.toggleSidebar)
  const toggleWorkPanel = useShellStore((state) => state.toggleWorkPanel)

  return (
    <div data-testid="app-root" className="flex h-full flex-col overflow-hidden bg-canvas text-ink">
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        workPanelOpen={workPanelOpen}
        onToggleWorkPanel={toggleWorkPanel}
      />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar collapsed={sidebarCollapsed} />
        <MainColumn />
        <WorkPanel open={workPanelOpen} />
      </div>
    </div>
  )
}
