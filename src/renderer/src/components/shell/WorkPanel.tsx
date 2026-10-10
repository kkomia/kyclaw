import type { ReactNode } from 'react'
import { cn } from '../ui/cn'

/**
 * 右栏：工作台面板（spec §6.5 刻意偏离：Kimi 没有，kyclaw 加 ~400px；R2 D4 起并入对话区）。
 * 它**不是独立的第三根柱子**：底色跟随内容区（AppShell 的 content-region，--bg-primary），
 * 与消息区之间只有一条分隔线（雷点 7：不出现双层框线），归属同一块面。
 * 可收起：收起时不占宽（w-0 + overflow-hidden），展开才有 400 —— 主列因此拿回空间。
 * `is-open` 是给测试/E2E 认的状态类；内层固定 400 宽，收放动画时文字不重排。
 */
export interface WorkPanelProps {
  open: boolean
  children?: ReactNode
}

export function WorkPanel({ open, children }: WorkPanelProps): React.JSX.Element {
  return (
    <aside
      data-testid="work-panel"
      className={cn(
        'flex shrink-0 overflow-hidden border-hairline transition-[width] duration-(--motion-main) ease-main',
        open ? 'is-open w-(--work-panel-width) border-l' : 'w-0'
      )}
    >
      <div className="flex w-(--work-panel-width) shrink-0 flex-col overflow-y-auto">
        {children}
      </div>
    </aside>
  )
}
