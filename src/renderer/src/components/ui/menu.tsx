import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactElement, ReactNode } from 'react'
import { cn } from './cn'
import { OVERLAY_SURFACE_CLASS } from './surface'

export interface MenuActionItem {
  id: string
  /** 不写就是普通条目；'separator' 的分隔条目见 MenuSeparatorItem */
  type?: 'item'
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** 危险动作：红字，高亮时铺危险浅底（§2.7 的红色一对） */
  danger?: boolean
  /** 当前项（菜单里也能是导航入口）：选中底 Fills-F2 + aria-current="page" */
  selected?: boolean
  /** 条目的 data-testid（R4：关键交互节点给 E2E 稳定选择器） */
  testId?: string
  onSelect?: (id: string) => void
}

export interface MenuSeparatorItem {
  id: string
  type: 'separator'
}

export type MenuEntry = MenuActionItem | MenuSeparatorItem

export interface MenuProps {
  /** 触发元素：单元素，套 Radix 的 asChild（用我们的 Button / IconButton 即可） */
  trigger: ReactElement
  items: MenuEntry[]
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 与触发元素的距离，默认 4（= --space-1） */
  sideOffset?: number
  className?: string
}

/**
 * 下拉菜单（UI 参考 §7 的菜单配方）：底 Bg-Tertiary、**无遮罩**、条目高 36、面板内边距 8、
 * 面板圆角 ≈20、条目 hover 用 Fills-F1、条目圆角 10。
 * 键盘：ArrowUp/Down 走条目、Enter 选中、Esc 关闭并还焦点——都由 Radix 提供。
 */
export function Menu({
  trigger,
  items,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
  className
}: MenuProps): React.JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={sideOffset}
          className={cn(OVERLAY_SURFACE_CLASS, 'p-(--menu-pad)', className)}
        >
          {items.map((entry) => {
            if (entry.type === 'separator') {
              return (
                <DropdownMenu.Separator key={entry.id} className="my-1 -mx-2 h-px bg-hairline" />
              )
            }

            return (
              <DropdownMenu.Item
                key={entry.id}
                data-testid={entry.testId}
                disabled={entry.disabled}
                aria-current={entry.selected === true ? 'page' : undefined}
                onSelect={() => entry.onSelect?.(entry.id)}
                className={cn(
                  'flex h-(--menu-item-height) cursor-default items-center gap-2 rounded-(--menu-item-radius) px-2 text-b2 text-ink outline-none select-none transition-colors duration-(--motion-fast) ease-main data-[disabled]:text-(--text-disabled)',
                  entry.danger
                    ? 'text-danger data-[highlighted]:bg-danger-bg'
                    : 'data-[highlighted]:bg-hover',
                  entry.selected === true && 'bg-selected'
                )}
              >
                {entry.icon === undefined ? null : (
                  <span
                    aria-hidden="true"
                    className="size-(--icon-size-md) shrink-0 [&>svg]:size-full"
                  >
                    {entry.icon}
                  </span>
                )}
                <span className="truncate">{entry.label}</span>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
