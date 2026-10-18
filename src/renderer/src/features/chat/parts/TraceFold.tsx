import { useState, type ReactNode } from 'react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 折叠容器（round 6）：高度走容器级 grid-template-rows 0fr ↔ 1fr 双向过渡，
 * 内容另走 blur + opacity + translateY，不做条件渲染硬切。
 *
 * 内容"开过一次"之后常驻 DOM；`mountContent` 可命令折叠态也挂内容
 * （task-114：纯思考轮完成收起，但保留思考体 DOM，便于选文/量测与既有交互）。
 */
export interface TraceFoldProps {
  open: boolean
  /** 折叠态也挂内容（纯思考轮：完成收起但保留思考体 DOM） */
  mountContent?: boolean
  children: ReactNode
  className?: string
}

export function TraceFold({
  open,
  mountContent = false,
  children,
  className
}: TraceFoldProps): React.JSX.Element {
  const [everOpened, setEverOpened] = useState(open)

  // React 文档认可的"按 props 调整 state"写法：开过一次后收起也保留 DOM。
  if (open && !everOpened) setEverOpened(true)

  return (
    <div
      data-testid="trace-fold"
      data-open={open ? 'true' : 'false'}
      className={cn('trace-fold', className)}
    >
      <div className="trace-fold-in">{everOpened || open || mountContent ? children : null}</div>
    </div>
  )
}
