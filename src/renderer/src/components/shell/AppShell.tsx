import { PanelRight, PanelRightOpen } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useShellStore } from '@renderer/lib/shell-store'
import { SettingsNav } from '@renderer/features/settings/SettingsNav'
import { SessionsController } from '@renderer/features/sessions/SessionsController'
import { IconButton } from '../ui/icon-button'
import { ContentRegion } from './ContentRegion'
import { MainColumn } from './MainColumn'
import { Sidebar } from './Sidebar'
import { SidebarFooter } from './SidebarFooter'
import { TitleBar } from './TitleBar'
import { WorkPanel } from './WorkPanel'
import { WorkPanelEmpty } from './WorkPanelEmpty'

/** 窄窗自动收工作台的阈值：语义层 token --work-panel-collapse-width（= 侧栏 240 + 内容列最小可读宽 480 + 工作台 400）。 */
const COLLAPSE_WIDTH_FALLBACK = 1120

function collapseWidthThreshold(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    '--work-panel-collapse-width'
  )
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : COLLAPSE_WIDTH_FALLBACK
}

/**
 * 应用壳（spec §6.2 三栏骨架）：顶栏 42 + 左栏 240（覆盖层可折叠）+ 内容区（中列 + 右栏）。
 * 布局状态只从这里接 store 的分档，往下都是 props —— 组件自身不直接订阅 store，好单测。
 * 侧栏内容 = 会话视图（新建 + 会话列表 + 底部单一入口）或设置视图（设置菜单，由路由决定）；
 * 内容区里的中列渲染当前路由（布局路由的 <Outlet/>）。
 *
 * 两层"面"（R2 D2/D4；round 3 起内容区是四角圆角卡）：壳 = 画布色（--bg-canvas，顶栏与侧栏同一层，
 * 两者之间没有分割线）；内容区 = 抬起来的一块面（--bg-surface，四角圆角 + 右/底留缝）+ 分隔线分出的
 * 工作台 —— 右栏因此不算第三根柱子。
 * data-sidebar 把"侧栏在不在"交给 CSS：内容列（.content-column）据此把可见区左缘推进到侧栏右缘。
 *
 * 窄窗兜底（R2 D4）：窗口窄到"侧栏 + 内容最小可读宽 + 工作台"都放不下时自动收起工作台，
 * 保证内容列始终有可读宽度（720 极窄 + 全开时曾经只剩 79px）。
 */
export function AppShell(): React.JSX.Element {
  const sidebarCollapsed = useShellStore((state) => state.sidebarCollapsed)
  const workPanelOpen = useShellStore((state) => state.workPanelOpen)
  const toggleSidebar = useShellStore((state) => state.toggleSidebar)
  const toggleWorkPanel = useShellStore((state) => state.toggleWorkPanel)
  const setWorkPanelOpen = useShellStore((state) => state.setWorkPanelOpen)
  const pathname = useLocation().pathname
  const inSettings = pathname.startsWith('/settings')
  // round 17（用户实拍）：工作台开关属于**对话区**，只在对话路由出现（设置/插件等页面右上角不再有它）
  const inChat = pathname.startsWith('/chat')
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0 && width < collapseWidthThreshold()) setWorkPanelOpen(false)
    })
    observer.observe(row)
    return () => {
      observer.disconnect()
    }
  }, [setWorkPanelOpen])

  return (
    <div
      data-testid="app-root"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      className="flex h-full flex-col overflow-hidden bg-canvas text-ink"
    >
      <TitleBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      <div ref={rowRef} className="relative flex min-h-0 flex-1">
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
        <ContentRegion>
          <MainColumn>
            <Outlet />
          </MainColumn>
          <WorkPanel open={workPanelOpen}>
            <WorkPanelEmpty />
          </WorkPanel>
          {/* 工作台开关（round 4：从顶栏搬到这里 —— 用户裁决 R2 concern ①"右侧边栏属于 chat 的内容"，
              位置按 Kimi 实况 c828bba8：图标按钮钉在内容卡**内部**的右上角）。面板开时同一位就是
              面板顶右（按钮始终在卡的右上角，不遮挡消息列/输入卡：卡右缘 - 44px，而内容列 800 封顶）。
              形态与顶栏窗控一致（36 图标钮、无外圈、hover 铺 Fills-F1）；testid / 可访问名不变。
              round 17：只在对话路由渲染（用户实拍：设置/插件页不该有"属于对话区"的按钮）。
              round 24：对话页顶部栏（40px）出来之后，按钮就是这条带的右端——上移 6px 与带对齐。 */}
          {inChat ? (
            <IconButton
              data-testid="work-panel-toggle"
              label={workPanelOpen ? '收起工作台' : '展开工作台'}
              icon={workPanelOpen ? <PanelRight /> : <PanelRightOpen />}
              className="absolute top-0.5 right-2 z-10 border-transparent hover:bg-hover"
              onClick={toggleWorkPanel}
            />
          ) : null}
        </ContentRegion>
        {/* 壳上的"凹角"（R2 D2；round 3 起一对）：内容区是四角圆角卡（ContentRegion 的
            rounded-overlay + 右/底 --shell-edge-gap 留缝），铺满整条主列（R13：主列几何不随侧栏变），
            它自己的左上/左下凸圆角在 x=0 被侧栏盖住；所以在可见左缘（--content-safe-left，跟着侧栏
            开合过渡）补两块"画布色 − 圆盘"的小方块（.shell-notch / .shell-notch-bottom：只涂圆弧
            以外），把内容卡的凸圆角露出来 —— 与 Kimi 桌面参考同向。侧栏收起（safe-left = 0）时它们
            正好压在内容卡自己的圆角上，涂的是卡片圆角让出来的那块画布，真正不可见
            （凹凸方向与遮挡面积的判据见 smoke-ui-r2 的 _notch_check / _corners_check）。 */}
        <div
          data-testid="shell-notch"
          aria-hidden="true"
          className="shell-notch pointer-events-none absolute top-0 left-(--content-safe-left) z-10 size-(--radius-overlay)"
        />
        <div
          data-testid="shell-notch-bottom"
          aria-hidden="true"
          className="shell-notch-bottom pointer-events-none absolute bottom-(--shell-edge-gap) left-(--content-safe-left) z-10 size-(--radius-overlay)"
        />
      </div>
    </div>
  )
}
