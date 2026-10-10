import { ChevronsUpDown, Settings } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { Menu, type MenuEntry } from '../ui/menu'
import { navItemClass } from './nav-item'

interface EntrySpec {
  to: string
  label: string
  testId: string
  icon: React.ReactNode
}

/** 二级菜单的条目（雷点 3：能收进二级菜单的一律不铺在首页；round 5 去重后只剩设置一项）。 */
const ENTRIES: EntrySpec[] = [
  { to: '/settings', label: '设置', testId: 'nav-settings', icon: <Settings /> }
]

/**
 * 侧栏底部：**单一入口**（产品标识 + 名称 + 展开指示），点开是二级菜单（round 5 去重后只剩设置一项）。
 * 菜单走既有 Menu 口径（无遮罩、底 Bg-Tertiary、条目高 36、进出场动效）；当前页的条目带选中态。
 * 产品标识是自绘的方块 + 字母（不是 emoji、也不是外部素材）：墨色实心 + 反白字，与"动作靠墨色实心"一致。
 *
 * 无顶线（R2 修复轮 round 4，用户实拍 E1）：此前这里有一条 border-t 的全宽分隔线，与侧栏右缘、
 * 内容卡左下角在整个左下角区域形成 L 形交叉线（"这个线太割裂了"）。Kimi 桌面同区域**没有顶线**，
 * footer/头像行与侧栏浑然一体、和卡片的左下圆角是单一干净曲线 —— 所以去掉分隔线，
 * 入口的分隔感只靠导航项自身的 hover/选中填充（不靠线）。
 */
export function SidebarFooter(): React.JSX.Element {
  const navigate = useNavigate()
  const pathname = useLocation().pathname

  const items: MenuEntry[] = ENTRIES.map((entry) => ({
    id: entry.to,
    label: entry.label,
    icon: entry.icon,
    testId: entry.testId,
    selected: pathname.startsWith(entry.to),
    onSelect: () => navigate(entry.to)
  }))

  return (
    <div data-testid="sidebar-footer" className="shrink-0 p-2">
      <Menu
        side="top"
        align="start"
        sideOffset={6}
        items={items}
        className="min-w-36"
        trigger={
          <button type="button" data-testid="sidebar-menu-trigger" className={navItemClass()}>
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-button-sm bg-(--button-primary-bg) font-mono text-b2 leading-none font-semibold text-(--button-primary-fg) select-none"
            >
              k
            </span>
            <span className="truncate">kyclaw</span>
            <ChevronsUpDown
              aria-hidden="true"
              className="ml-auto size-(--icon-size-sm) shrink-0 text-ink-tertiary"
            />
          </button>
        }
      />
    </div>
  )
}
