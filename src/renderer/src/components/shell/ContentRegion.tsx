import type { ReactNode } from 'react'

/**
 * 内容区（R2 D2/D4；R2 修复轮 round 3 改四角圆角卡）。
 *
 * 它是"抬起来的那一层"：底色 --bg-surface（浅 #ffffff / 深 #121212，实测的"主面板底"），
 * **四角都有 --radius-overlay = 20 的圆角**（Kimi 桌面实测：整卡四角圆角），并且在右缘、底缘
 * 各留一条 --shell-edge-gap（6，Kimi 实测 12 设备像素 @2x）的画布缝 —— 四角因此完整可见；
 * 顶栏/侧栏那层画布色从角上"绕"进来，顶栏与左栏仍是一整层。
 * 左缘的两个角在可见左缘（侧栏右缘）由 AppShell 的 shell-notch / shell-notch-bottom 补出
 * （侧栏收起时它们正好落在卡片自己的圆角上）。
 * 右栏（工作台）就在这块面里面，靠一条分隔线分界，不再自成第三根柱子。
 *
 * overflow-hidden 是为了让四个圆角真的裁到内容（消息列的滚动区、工作台的滚动区都在里面）。
 * relative 是给 round 4 搬来的工作台开关（AppShell 里钉在本卡右上角的图标钮）做定位基准。
 */
export interface ContentRegionProps {
  children?: ReactNode
}

export function ContentRegion({ children }: ContentRegionProps): React.JSX.Element {
  return (
    <div
      data-testid="content-region"
      className="relative mr-(--shell-edge-gap) mb-(--shell-edge-gap) flex min-w-0 flex-1 overflow-hidden rounded-overlay bg-surface"
    >
      {children}
    </div>
  )
}
