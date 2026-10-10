import { Brain, ChartColumn, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { navItemClass } from './nav-item'

interface NavEntry {
  to: string
  label: string
  testId: string
  icon: ReactNode
}

/** 底部三项各管一个页面；对话页不在这里 —— 它是启动页，从会话列表/新建会话进。 */
const NAV_ENTRIES: NavEntry[] = [
  { to: '/settings', label: '设置', testId: 'nav-settings', icon: <Settings /> },
  { to: '/memory', label: '记忆', testId: 'nav-memory', icon: <Brain /> },
  { to: '/usage', label: '用量', testId: 'nav-usage', icon: <ChartColumn /> }
]

/**
 * 侧栏底部导航（设置 / 记忆 / 用量）。
 * NavLink 自己管"当前页"：命中路由时给它 aria-current="page"，样式走同一个 navItemClass。
 */
export function SidebarNav(): React.JSX.Element {
  return (
    <nav
      data-testid="sidebar-nav"
      className="flex shrink-0 flex-col gap-0.5 border-t border-hairline p-2"
    >
      {NAV_ENTRIES.map((entry) => (
        <NavLink
          key={entry.to}
          to={entry.to}
          data-testid={entry.testId}
          className={({ isActive }) => navItemClass({ selected: isActive })}
        >
          <NavItemIcon>{entry.icon}</NavItemIcon>
          {entry.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** 导航项里的图标框：18 档（§4.8），svg 撑满，不进无障碍树 */
function NavItemIcon({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
      {children}
    </span>
  )
}
