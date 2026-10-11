import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronRight } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { cn } from './cn'
import { OVERLAY_SURFACE_CLASS } from './surface'
import { Tooltip } from './tooltip'

export interface MenuActionItem {
  id: string
  /** 不写就是普通条目；'separator' 的分隔条目见 MenuSeparatorItem，'submenu' 见 MenuSubmenuItem */
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

/** 子菜单条目（round 7）：一层就够——子菜单里不再嵌子菜单 */
export interface MenuSubmenuItem {
  id: string
  type: 'submenu'
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  testId?: string
  /** 触发器右侧的当前值（round 18：模型浮窗「思考强度   高 ▸」的"高"） */
  trailing?: ReactNode
  items: Array<MenuActionItem | MenuSeparatorItem | MenuCustomItem>
}

/**
 * 自定义内容条目（round 18）：不参与键盘导航（滑块自己处理方向键），
 * 也不装作 menuitem——给「对话长度」这类控件用。
 */
export interface MenuCustomItem {
  id: string
  type: 'custom'
  content: ReactNode
}

export type MenuEntry = MenuActionItem | MenuSeparatorItem | MenuSubmenuItem

export interface MenuProps {
  /** 触发元素：单元素，套 Radix 的 asChild（用我们的 Button / IconButton 即可） */
  trigger: ReactElement
  items: MenuEntry[]
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 与触发元素的距离，默认 4（= --space-1） */
  sideOffset?: number
  className?: string
  /** 面板开合回调（round 13：引用技能菜单借它做"打开时刷新"；缺省不关心） */
  onOpenChange?: (open: boolean) => void
  /**
   * 触发元素的 hover 提示（round 15，用户实拍：＋ / 权限按钮要有 tooltip）。
   * 两层 asChild 嵌套：Tooltip.Trigger > DropdownMenu.Trigger > 你的按钮，互相不打架。
   */
  tooltip?: string
}

/** 条目行（普通条目与子菜单触发器共用；键盘高亮只铺填充，不叠全局焦点环） */
const MENU_ITEM_CLASS =
  'flex h-(--menu-item-height) cursor-default items-center gap-2 rounded-(--menu-item-radius) px-2 text-b2 text-ink outline-none select-none transition-colors duration-(--motion-fast) ease-main data-[disabled]:text-(--text-disabled) focus-visible:shadow-none'

function itemContent(icon: ReactNode | undefined, label: ReactNode): React.JSX.Element {
  return (
    <>
      {icon === undefined ? null : (
        <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
          {icon}
        </span>
      )}
      <span className="truncate">{label}</span>
    </>
  )
}

function actionItem(entry: MenuActionItem): React.JSX.Element {
  return (
    <DropdownMenu.Item
      key={entry.id}
      data-testid={entry.testId}
      disabled={entry.disabled}
      aria-current={entry.selected === true ? 'page' : undefined}
      onSelect={() => entry.onSelect?.(entry.id)}
      className={cn(
        MENU_ITEM_CLASS,
        entry.danger
          ? 'text-danger data-[highlighted]:bg-danger-bg'
          : 'data-[highlighted]:bg-hover',
        entry.selected === true && 'bg-selected'
      )}
    >
      {itemContent(entry.icon, entry.label)}
    </DropdownMenu.Item>
  )
}

function submenuItem(entry: MenuSubmenuItem): React.JSX.Element {
  return (
    <DropdownMenu.Sub key={entry.id}>
      <DropdownMenu.SubTrigger
        data-testid={entry.testId}
        disabled={entry.disabled}
        className={cn(MENU_ITEM_CLASS, 'data-[highlighted]:bg-hover data-[state=open]:bg-hover')}
      >
        {itemContent(entry.icon, entry.label)}
        {entry.trailing === undefined ? null : (
          <span className="ml-auto shrink-0 text-c1 text-ink-tertiary">{entry.trailing}</span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-ink-tertiary',
            entry.trailing === undefined && 'ml-auto'
          )}
        />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={4}
          className={cn(OVERLAY_SURFACE_CLASS, 'p-(--menu-pad)')}
        >
          {entry.items.map((item) =>
            item.type === 'separator' ? (
              <DropdownMenu.Separator key={item.id} className="my-1 -mx-2 h-px bg-hairline" />
            ) : item.type === 'custom' ? (
              <div key={item.id} data-testid={`menu-custom-${item.id}`} className="px-2 py-1">
                {item.content}
              </div>
            ) : (
              actionItem(item)
            )
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

/**
 * 下拉菜单（UI 参考 §7 的菜单配方）：底 Bg-Tertiary、**无遮罩**、条目高 36、面板内边距 8、
 * 面板圆角 ≈20、条目 hover 用 Fills-F1、条目圆角 10。
 * 键盘：ArrowUp/Down 走条目、Enter 选中、Esc 关闭并还焦点——都由 Radix 提供；
 * 子菜单（round 7）走 Radix 的 Sub：ArrowRight 展开、ArrowLeft 收回。
 * 焦点指示（R2 round 5，用户实拍 #7）：键盘走到哪条**只铺填充**（data-[highlighted]:bg-hover），
 * 不再叠全局焦点环（focus-visible:shadow-none）——填充已经是可见指示，墨色内环正是用户点名的"黑色框线"。
 */
export function Menu({
  trigger,
  items,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
  className,
  onOpenChange,
  tooltip
}: MenuProps): React.JSX.Element {
  const triggerNode =
    tooltip === undefined ? (
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
    ) : (
      // Tooltip.Trigger 与 DropdownMenu.Trigger 两层 asChild 叠在同一个按钮上：
      // 键盘聚焦弹提示、点击/ArrowDown 开菜单，互不干扰
      <Tooltip label={tooltip}>
        <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      </Tooltip>
    )
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      {triggerNode}
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
            if (entry.type === 'submenu') return submenuItem(entry)
            return actionItem(entry)
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
