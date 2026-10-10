import { Puzzle } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { navItemClass } from '@renderer/components/shell/nav-item'

/**
 * 侧栏「插件」入口（R2 round 5，用户实拍 #9）：固定在「新建会话」按钮下方（不进滚动区），
 * 位置照 Kimi 侧栏的插件生态位（新建任务下方）。点击开 /plugins，当前页用 Fills-F2 选中底 + aria-current。
 * 图标 Puzzle（lucide）；导航项外观走 navItemClass（hover Fills-F1 / 选中 Fills-F2，不画描边）。
 */
export function PluginsNavItem(): React.JSX.Element {
  const navigate = useNavigate()
  const selected = useLocation().pathname.startsWith('/plugins')

  return (
    <div className="shrink-0 px-2 pb-1">
      <button
        type="button"
        data-testid="nav-plugins"
        aria-current={selected ? 'page' : undefined}
        className={navItemClass({ selected })}
        onClick={() => navigate('/plugins')}
      >
        <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
          <Puzzle />
        </span>
        插件
      </button>
    </div>
  )
}
