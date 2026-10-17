import type { ReactNode } from 'react'
import { cn } from '../ui/cn'

/**
 * 二级栏（0.2.0 起；2026-10-17 用户拍板参考 Codex 布局改版）：
 * 主对话模块里装会话视图（新建 + 会话列表 + 底部入口），设置页里装设置菜单；
 * 笔记 / 知识库 / Office 不挂二级栏（见 AppShell 的 showSidebar）。
 *
 * **它不再是覆盖层，而是内容区圆角卡（ContentRegion）里的一个 flex 子列**：
 * 卡片是一整块面（会话侧栏 + 对话/工作区同属一张卡），左侧这列与右侧主区之间只靠
 * 1px 的 hairline 竖线（`border-r` + `border-hairline`）分界；底色与卡片一致（`bg-surface`，
 * 即 --bg-primary），不再是壳那层的 --bg-canvas。
 *
 * 折叠（TitleBar 的开合钮，props 语义不变）在卡内做**宽度动画**：外侧 `w-(--sidebar-width)` ↔
 * `w-0` + `overflow-hidden`，内容层固定 `--sidebar-width` 宽（收缩过程中不重排，只是被裁掉）。
 * 折叠态同时去掉竖线与 `inert`（滑走/收没后不该还能 Tab 进去、被读屏念到）。
 * 主区是流式的 flex 兄弟：侧栏在 flow 里收放，主列/工作台会自然跟着重排（不再靠 safe-left 补偏移）。
 *
 * 导航项是 T5 的事，这里只给容器。
 */
export interface SidebarProps {
  collapsed: boolean
  children?: ReactNode
}

export function Sidebar({ collapsed, children }: SidebarProps): React.JSX.Element {
  return (
    <aside
      data-testid="sidebar"
      // 收起后不该还能 Tab 进去/被读屏念到
      inert={collapsed}
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden bg-surface transition-[width] duration-(--motion-main) ease-main',
        collapsed ? 'is-collapsed w-0' : 'w-(--sidebar-width) border-r border-hairline'
      )}
    >
      {/* 内容层宽度写死：宽度动画期间字不被挤着换行；外层收窄只负责裁剪 */}
      <div className="flex h-full w-(--sidebar-width) shrink-0 flex-col">{children}</div>
    </aside>
  )
}
