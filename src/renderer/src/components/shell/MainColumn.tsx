import type { ReactNode } from 'react'
import { cn } from '../ui/cn'

/**
 * 中列（主列）：flex-1，宽度只由容器决定 —— 侧栏折叠不动它（spec §6.2 的"覆盖层"口径）。
 * 底色由"内容区"容器给（AppShell 的 content-region：主列 + 工作台同一块面，四角圆角卡，
 * 见 ContentRegion），自己保持透明 —— 这样右栏与消息区是同一块面，靠分隔线分界（R2 D4）。
 * 消息列/输入区的 max 800 / 768 是 T5、T7 的内容层的事。
 */
export interface MainColumnProps {
  /** 追加类：round 39 工作台全屏时给 `hidden`（中列让位但**不卸载**，聊天状态要留） */
  className?: string
  children?: ReactNode
}

export function MainColumn({ className, children }: MainColumnProps): React.JSX.Element {
  return (
    <main data-testid="main-column" className={cn('flex min-w-0 flex-1 flex-col', className)}>
      {children}
    </main>
  )
}
