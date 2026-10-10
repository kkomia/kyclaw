import { cn } from '../ui/cn'

/**
 * 导航项外观（spec §6.2 与附录 A 的实测口径）：高 36（--nav-item-height）、
 * hover Fills-F1、选中 Fills-F2（spec §6.5：当前项用中性填充，不用品牌蓝）。
 * 侧栏底部导航（链接）与会话列表（按钮）都套这一串类名 —— 元素语义不同，所以不硬拼成一个组件。
 * 选中项仍带 hover 档：填充是"深浅两个档"，悬停只是回到更浅的那档。
 */
export function navItemClass(options: { selected?: boolean } = {}): string {
  return cn(
    'flex h-(--nav-item-height) w-full items-center gap-2 rounded-control px-2 text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover',
    options.selected === true && 'bg-selected'
  )
}
