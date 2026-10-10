import type { ReactNode } from 'react'
import { cn } from '../ui/cn'

/**
 * 左栏（spec §6.2：240px 固定、可折叠）。
 * 折叠 = 覆盖层滑出（`translate(-100%)`，`is-collapsed` 是给测试/E2E 认的状态类）：
 * 它是绝对定位的一层，滑走时主列几何完全不动（不像 flow 里收宽度那样引发重排）。
 * 底色照实测取"侧栏底 = 窗体外框"（浅 #fbfaf9 / 深 #181817）= --bg-canvas —— 与顶栏同属"壳"这一层，
 * 所以**不画右缘描边**：与内容区之间靠底色差 + 内容区左上/左下圆角（R2 D2；round 3 缺口角一对）
 * 自然相接，没有生硬分割线。
 * 导航项是 T5 的事，这里只给容器。
 */
export interface SidebarProps {
  collapsed: boolean
  children?: ReactNode
}

export function Sidebar({ collapsed, children }: SidebarProps): React.JSX.Element {
  return (
    <aside
      data-testid="sidebar"
      // 滑出屏幕后不该还能 Tab 进去/被读屏念到
      inert={collapsed}
      className={cn(
        'absolute inset-y-0 left-0 z-20 flex w-(--sidebar-width) flex-col overflow-hidden bg-canvas transition-transform duration-(--motion-main) ease-main',
        collapsed && 'is-collapsed -translate-x-full'
      )}
    >
      {children}
    </aside>
  )
}
