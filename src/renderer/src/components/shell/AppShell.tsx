import { Outlet, useLocation } from 'react-router'
import { useShellStore } from '@renderer/lib/shell-store'
import { SettingsNav } from '@renderer/features/settings/SettingsNav'
import { SessionsController } from '@renderer/features/sessions/SessionsController'
import { MainColumn } from './MainColumn'
import { Sidebar } from './Sidebar'
import { SidebarFooter } from './SidebarFooter'
import { TitleBar } from './TitleBar'
import { WorkPanel } from './WorkPanel'
import { WorkPanelEmpty } from './WorkPanelEmpty'

/**
 * 应用壳（spec §6.2 三栏骨架）：顶栏 42 + 左栏 240（覆盖层可折叠）+ 中列 flex-1 + 右栏 400（可收起）。
 * 布局状态只从这里接 store 的分档，往下都是 props —— 组件自身不直接订阅 store，好单测。
 * 侧栏内容 = 会话视图（新建 + 会话列表 + 底部单一入口）或设置视图（设置菜单，由路由决定）；
 * 主列渲染当前路由（布局路由的 <Outlet/>）。
 *
 * data-sidebar 把"侧栏在不在"交给 CSS：内容列（.content-column）据此把安全左边推进到侧栏右缘，
 * 保证覆盖层展开时压不到内容（主列自身几何不变，R13 仍成立）。
 */
export function AppShell(): React.JSX.Element {
  const sidebarCollapsed = useShellStore((state) => state.sidebarCollapsed)
  const workPanelOpen = useShellStore((state) => state.workPanelOpen)
  const toggleSidebar = useShellStore((state) => state.toggleSidebar)
  const toggleWorkPanel = useShellStore((state) => state.toggleWorkPanel)
  const inSettings = useLocation().pathname.startsWith('/settings')

  return (
    <div
      data-testid="app-root"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      className="flex h-full flex-col overflow-hidden bg-canvas text-ink"
    >
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        workPanelOpen={workPanelOpen}
        onToggleWorkPanel={toggleWorkPanel}
      />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar collapsed={sidebarCollapsed}>
          {inSettings ? (
            <SettingsNav />
          ) : (
            <>
              <SessionsController />
              <SidebarFooter />
            </>
          )}
        </Sidebar>
        <MainColumn>
          <Outlet />
        </MainColumn>
        <WorkPanel open={workPanelOpen}>
          <WorkPanelEmpty />
        </WorkPanel>
      </div>
    </div>
  )
}
