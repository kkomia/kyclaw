import { ChevronLeft } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { navItemClass } from '@renderer/components/shell/nav-item'
import { SETTINGS_SECTIONS, settingsSectionFromPath } from './sections'

/**
 * 设置页的左列（取代会话视图，参考 Kimi 设置页实测）：顶部「返回」+ 栏目菜单。
 * 「返回」回到会话视图（/chat）；栏目项切换 /settings/:section，当前栏用 Fills-F2 选中底 + aria-current。
 * 数据与行为都在路由上（可深链、可后退），这里不存状态。
 */
export function SettingsNav(): React.JSX.Element {
  const navigate = useNavigate()
  const current = settingsSectionFromPath(useLocation().pathname)

  return (
    <div
      data-testid="settings-nav"
      className="scrollbar-auto-hide flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
    >
      <button
        type="button"
        data-testid="settings-back"
        className={navItemClass()}
        onClick={() => navigate('/chat')}
      >
        <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
          <ChevronLeft />
        </span>
        返回
      </button>

      <nav aria-label="设置" className="flex flex-col gap-0.5">
        {SETTINGS_SECTIONS.map((section) => {
          const selected = section.id === current
          const Icon = section.icon
          return (
            <button
              key={section.id}
              type="button"
              data-testid={section.navTestId}
              aria-current={selected ? 'page' : undefined}
              className={navItemClass({ selected })}
              onClick={() => navigate(`/settings/${section.id}`)}
            >
              <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
                <Icon />
              </span>
              {section.label}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
