import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { cn } from './cn'
import { OVERLAY_SURFACE_CLASS } from './surface'
import { Tooltip } from './tooltip'

/**
 * 菜单/下拉共用原语（task-61 · 对齐 claude-style 紧凑样式）。
 *
 * 规格（用户截图 ref-model-dropdown / ref-slash-menu）：
 *   - 面板宽 `min(360px, calc(100vw - 24px))`、内边距 6、圆角 12、hairline 边 + `--shadow-overlay`；
 *   - 行 = icon(16, tertiary) + 主标题(b2 14) + 可选描述(c1 12 tertiary) + 右侧 meta（mono 11 tabular / badge / chevron）；
 *   - 单行 40、两行（有 description）48–52；分组标题 11/500 tertiary；选中项 Fills-F2 + 右侧对勾；
 *   - 键盘高亮只铺填充（data-[highlighted]:bg-hover），不叠全局焦点环；Arrow/Enter/Esc 由 Radix 负责；
 *   - 溢出滚动 + 最大高度，深浅两套 token（bg-menu / hairline / shadow-overlay 都是语义 token）。
 */
export interface MenuActionItem {
  id: string
  /** 不写就是普通条目；'separator' / 'submenu' 见各自类型 */
  type?: 'item'
  label: ReactNode
  /** 行左侧图标（16px；没有就不占位） */
  icon?: ReactNode
  /** 第二行说明（12px tertiary）；不写 = 单行 40，写了 = 两行 48–52 */
  description?: ReactNode
  disabled?: boolean
  /** 危险动作：红字 + 危险浅底高亮 */
  danger?: boolean
  /** 当前项：Fills-F2 底 + 右侧对勾 + aria-current */
  selected?: boolean
  /** 右侧小标记：纯数字字符串自动 mono/tabular；文字标签保持 sans */
  trailing?: ReactNode
  /** 右侧 badge（倍率/时间/快捷键等真实信息）：mono 11 tabular 小胶囊 */
  badge?: ReactNode
  /** 条目 data-testid */
  testId?: string
  onSelect?: (id: string) => void
}

export interface MenuSeparatorItem {
  id: string
  type: 'separator'
}

/** 子菜单条目（一层就够） */
export interface MenuSubmenuItem {
  id: string
  type: 'submenu'
  label: ReactNode
  description?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  testId?: string
  trailing?: ReactNode
  items: Array<MenuActionItem | MenuSeparatorItem | MenuCustomItem>
}

/** 自定义内容条目（不参与键盘导航：滑块 / 明细块） */
export interface MenuCustomItem {
  id: string
  type: 'custom'
  content: ReactNode
}

/** 分组（圆角菜单里的 11/500 小标题 + 一组条目） */
export interface MenuGroupItem {
  id: string
  type: 'group'
  label: ReactNode
  items: MenuActionItem[]
}

export type MenuEntry =
  MenuActionItem | MenuSeparatorItem | MenuSubmenuItem | MenuCustomItem | MenuGroupItem

export interface MenuProps {
  /** 触发元素：单元素，套 Radix asChild（Button / IconButton 即可） */
  trigger: ReactElement
  items: MenuEntry[]
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
  className?: string
  onOpenChange?: (open: boolean) => void
  tooltip?: string
}

/** 面板：360 上限 / 4px 内边距 / 10px 圆角 / hairline 边 / 最高 min(360px,60vh) 内滚 */
const MENU_PANEL_CLASS = cn(
  OVERLAY_SURFACE_CLASS,
  'w-[min(360px,calc(100vw-24px))] max-h-[min(360px,60vh)] overflow-y-auto rounded-[10px] border-(length:--hairline-width) border-hairline p-1'
)

/** 条目行：单行 32；两行时 min-h-10（40） */
const MENU_ITEM_CLASS =
  'flex min-h-[32px] cursor-default items-center gap-2 rounded-[8px] px-2 py-0.5 text-b2 text-ink outline-none select-none transition-colors duration-(--motion-fast) ease-main data-[disabled]:text-(--text-disabled) focus-visible:shadow-none'

/** 行图标：跟字号一起走 --icon-size-sm（task-69 机制；task-73 收口，不再写死 size-4） */
const MENU_ICON_CLASS =
  'inline-flex size-(--icon-size-sm) shrink-0 items-center justify-center text-ink-tertiary [&>svg]:size-full'

const GROUP_LABEL_CLASS =
  'px-2 pt-1.5 pb-0.5 text-[11px] leading-4 font-medium text-ink-tertiary select-none'

/** 纯数值 trailing 走 code 声部 + tabular；文字标签保持 sans（task-64 字体口径） */
const NUMERIC_TRAILING = /^[\d.,%+\-\s]+[KMB]?$/

function trailingClassOf(trailing: ReactNode): string {
  const numeric = typeof trailing === 'string' && NUMERIC_TRAILING.test(trailing.trim())
  return cn('ml-auto shrink-0 text-c1 text-ink-tertiary', numeric && 'font-mono tabular-nums')
}

function itemContent(entry: {
  icon?: ReactNode
  label: ReactNode
  description?: ReactNode
}): React.JSX.Element {
  return (
    <>
      {entry.icon === undefined ? null : (
        <span aria-hidden="true" className={MENU_ICON_CLASS}>
          {entry.icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{entry.label}</span>
        {entry.description === undefined ? null : (
          <span className="truncate text-[11px] leading-4 font-normal text-ink-tertiary">
            {entry.description}
          </span>
        )}
      </span>
    </>
  )
}

function actionItem(entry: MenuActionItem): React.JSX.Element {
  const twoLine = entry.description !== undefined
  return (
    <DropdownMenu.Item
      key={entry.id}
      data-testid={entry.testId}
      disabled={entry.disabled}
      aria-current={entry.selected === true ? 'page' : undefined}
      onSelect={() => entry.onSelect?.(entry.id)}
      className={cn(
        MENU_ITEM_CLASS,
        twoLine && 'min-h-10 items-start py-1',
        entry.danger
          ? 'text-danger data-[highlighted]:bg-danger-bg'
          : 'data-[highlighted]:bg-hover',
        entry.selected === true && 'bg-selected'
      )}
    >
      {itemContent(entry)}
      {entry.selected === true ? (
        <Check
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink',
            entry.trailing === undefined && entry.badge === undefined && 'ml-auto'
          )}
        />
      ) : null}
      {entry.badge === undefined ? null : (
        <span className="shrink-0 rounded-badge border-(length:--hairline-width) border-hairline px-1 py-0.5 font-mono text-[10px] leading-none text-ink-tertiary tabular-nums">
          {entry.badge}
        </span>
      )}
      {entry.trailing === undefined ? null : (
        <span className={trailingClassOf(entry.trailing)}>{entry.trailing}</span>
      )}
    </DropdownMenu.Item>
  )
}

function submenuItem(entry: MenuSubmenuItem): React.JSX.Element {
  return (
    <DropdownMenu.Sub key={entry.id}>
      <DropdownMenu.SubTrigger
        data-testid={entry.testId}
        disabled={entry.disabled}
        className={cn(
          MENU_ITEM_CLASS,
          entry.description === undefined
            ? 'data-[highlighted]:bg-hover data-[state=open]:bg-hover'
            : 'min-h-10 items-start py-1 data-[highlighted]:bg-hover data-[state=open]:bg-hover'
        )}
      >
        {itemContent(entry)}
        {entry.trailing === undefined ? null : (
          <span className={trailingClassOf(entry.trailing)}>{entry.trailing}</span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-(--icon-size-sm) shrink-0 text-ink-tertiary',
            entry.trailing === undefined && 'ml-auto'
          )}
        />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={4} className={MENU_PANEL_CLASS}>
          {entry.items.map((item) => {
            if (item.type === 'separator') {
              return <DropdownMenu.Separator key={item.id} className="my-1 h-px bg-hairline" />
            }
            if (item.type === 'custom') {
              return (
                <div key={item.id} data-testid={`menu-custom-${item.id}`} className="px-2 py-1">
                  {item.content}
                </div>
              )
            }
            return actionItem(item)
          })}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

/** 顶层条目渲染（普通 / 分组 / 分隔 / 自定义 / 子菜单） */
function renderEntry(entry: MenuEntry): React.JSX.Element | null {
  if (entry.type === 'separator') {
    return <DropdownMenu.Separator key={entry.id} className="my-1 h-px bg-hairline" />
  }
  if (entry.type === 'submenu') return submenuItem(entry)
  if (entry.type === 'custom') {
    return (
      <div key={entry.id} data-testid={`menu-custom-${entry.id}`} className="px-2 py-1">
        {entry.content}
      </div>
    )
  }
  if (entry.type === 'group') {
    return (
      <DropdownMenu.Group key={entry.id} data-testid={`menu-group-${entry.id}`}>
        <DropdownMenu.Label className={GROUP_LABEL_CLASS}>{entry.label}</DropdownMenu.Label>
        {entry.items.map((item) => renderEntry(item))}
      </DropdownMenu.Group>
    )
  }
  return actionItem(entry)
}

/**
 * 下拉菜单（共用原语）：radix DropdownMenu + 上面的紧凑面板/行规格。
 * 键盘：ArrowUp/Down 走条目、Enter 选中、Esc 关闭还焦点；子菜单 ArrowRight/Left；全部由 Radix 提供。
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
          className={cn(MENU_PANEL_CLASS, className)}
        >
          {items.map((entry) => renderEntry(entry))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
