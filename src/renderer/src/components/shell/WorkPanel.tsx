import type { ReactNode } from 'react'
import { cn } from '../ui/cn'

/**
 * 右栏：工作台面板（spec §6.5 刻意偏离：Kimi 没有，kyclaw 加 ~400px）。
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
        'flex shrink-0 overflow-hidden border-hairline bg-canvas transition-[width] duration-(--motion-main) ease-main',
        open ? 'is-open w-(--work-panel-width) border-l' : 'w-0'
      )}
    >
      <div className="flex w-(--work-panel-width) shrink-0 flex-col overflow-y-auto">
        {children}
      </div>
    </aside>
  )
}
