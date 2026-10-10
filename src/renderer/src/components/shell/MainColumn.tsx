import type { ReactNode } from 'react'

/**
 * 中列（主列）：flex-1，宽度只由容器决定 —— 侧栏折叠不动它（spec §6.2 的"覆盖层"口径）。
 * 底色照实测取"主面板底"（浅 #ffffff / 深 #121212）= --bg-primary；
 * 消息列/输入区的 max 800 / 768 是 T5、T7 的内容层的事。
 */
export interface MainColumnProps {
  children?: ReactNode
}

export function MainColumn({ children }: MainColumnProps): React.JSX.Element {
  return (
    <main data-testid="main-column" className="flex min-w-0 flex-1 flex-col bg-surface">
      {children}
    </main>
  )
}
