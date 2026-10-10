import type { ReactNode } from 'react'

/**
 * 内容区（R2 D2/D4）：中列 + 右栏共用的一块面。
 *
 * 它是"抬起来的那一层"：底色 --bg-surface（浅 #ffffff / 深 #121212，实测的"主面板底"），
 * 上沿两个圆角（--radius-overlay = 20，按 Kimi 桌面实测：面板左上/右上都是约 20 的曲面），
 * 让顶栏/侧栏那层画布色从角上"绕"进来 —— 顶栏与左栏因此是一整层，与内容区之间没有生硬分割线。
 * 右栏（工作台）就在这块面里面，靠一条分隔线分界，不再自成第三根柱子。
 *
 * overflow-hidden 是为了让两个上圆角真的裁到内容（消息列的滚动区、工作台的滚动区都在里面）。
 */
export interface ContentRegionProps {
  children?: ReactNode
}

export function ContentRegion({ children }: ContentRegionProps): React.JSX.Element {
  return (
    <div
      data-testid="content-region"
      className="flex min-w-0 flex-1 overflow-hidden rounded-t-overlay bg-surface"
    >
      {children}
    </div>
  )
}
