import type { ReactNode } from 'react'

/**
 * 中列（主列）：flex-1，宽度只由容器决定 —— 侧栏折叠不动它（spec §6.2 的"覆盖层"口径）。
 * 底色由"内容区"容器给（AppShell 的 content-region：主列 + 工作台同一块面，圆角在上沿），
 * 自己保持透明 —— 这样右栏与消息区是同一块面，靠分隔线分界（R2 D4）。
 * 消息列/输入区的 max 800 / 768 是 T5、T7 的内容层的事。
 */
export interface MainColumnProps {
  children?: ReactNode
}

export function MainColumn({ children }: MainColumnProps): React.JSX.Element {
  return (
    <main data-testid="main-column" className="flex min-w-0 flex-1 flex-col">
      {children}
    </main>
  )
}
