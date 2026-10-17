import type { KeyboardEvent } from 'react'
import { cn } from './cn'

/**
 * TabStrip 家族规格（task-103 T2）：顶栏 AppTabBar 与右栏 Workbench 共用。
 *
 * | 项 | app（顶栏） | workbench（右栏） |
 * | 行高 | h-8（32） | h-7（28） |
 * | 字号/字重 | b2 14 / medium | b2 14 / regular |
 * | 图标 | --icon-size-sm 16 | 16 |
 * | 关闭钮 | --icon-size-lg 20（图标 sm 16） | size-5 20（图标 14） |
 * | 激活 | bg-surface text-ink（白 pill） | bg-selected text-ink（暖灰条） |
 * | 未激活 | text-ink-secondary + hover:bg-hover | 同 |
 * | 圆角 | rounded-control | rounded-control |
 * | 关闭显隐 | 激活常显 / 未激活 hover+focus-within | 激活常显 / 未激活 group-hover |
 *
 * 形态可不同（pill vs 条），但色阶/圆角/文字/关闭钮/动效全部同源（--motion-fast）。
 */
export type TabStripVariant = 'app' | 'workbench'

const FAMILY =
  'min-w-0 items-center gap-1.5 rounded-control text-b2 transition-colors duration-(--motion-fast) ease-main'

export function tabTriggerClass(variant: TabStripVariant, active: boolean): string {
  if (variant === 'app') {
    return cn(
      'flex h-full w-full text-left font-medium',
      FAMILY,
      active ? 'bg-surface text-ink' : 'text-ink-secondary hover:bg-hover hover:text-ink'
    )
  }
  return cn(
    'flex h-7 max-w-44 cursor-default pr-6 pl-2',
    FAMILY,
    active ? 'bg-selected text-ink' : 'text-ink-secondary hover:bg-hover'
  )
}

export function tabCloseClass(variant: TabStripVariant, active: boolean): string {
  const base = cn(
    'absolute top-1/2 right-1 flex -translate-y-1/2 items-center justify-center rounded-badge text-ink-tertiary transition-[opacity,background-color,color] duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink'
  )
  if (variant === 'app') {
    return cn(
      base,
      'size-(--icon-size-lg)',
      active
        ? 'opacity-100'
        : 'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'
    )
  }
  return cn(base, 'size-5', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')
}

/**
 * tablist 的 roving 键盘：←/→ 移动焦点、Home/End 到首尾、Enter/Space 激活当前 tab。
 * 只操作本 tablist 内 [role=tab]，顶栏与右栏互不串。
 */
export function handleTabListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  if (tabs.length === 0) return
  const index = tabs.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    tabs[index]?.click()
    return
  }
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = tabs.length - 1
  else return
  event.preventDefault()
  tabs[next]?.focus()
}
