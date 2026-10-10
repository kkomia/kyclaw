import { useState, type ReactNode } from 'react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 折叠容器（round 6，对照《对话UI-工具链与显示口径 v0.1》§4.1 / 雷点 3）：
 * 高度走容器级 `grid-template-rows: 0fr ↔ 1fr` **双向过渡**（样式在 styles/tailwind.css 的
 * `.trace-fold`，时长/缓动全部走 token），内容另走 blur + opacity + translateY；
 * **不做条件渲染硬切** —— 收起时内容仍在 DOM 里参与过渡。
 *
 * 内容"开过一次"（everOpened）之后常驻 DOM：之后每次开合都有完整过渡可跑；
 * 在此之前不上 DOM（没展开过就不占文档）。
 *
 * 开合状态不持久化：只活在组件的内存态里（文档 §1.3「localStorage / store 持久化：无」）。
 */
export interface TraceFoldProps {
  open: boolean
  children: ReactNode
  className?: string
}

export function TraceFold({ open, children, className }: TraceFoldProps): React.JSX.Element {
  const [everOpened, setEverOpened] = useState(open)

  // 开过一次就记下（此后收起也保留 DOM，过渡才有对象可动）。
  // 这是 React 文档认可的"按 props 调整 state"写法（render 期间条件 setState，
  // React 会在提交前用新值重渲染这一次；不走 effect 就没有级联渲染）。
  if (open && !everOpened) setEverOpened(true)

  return (
    <div
      data-testid="trace-fold"
      data-open={open ? 'true' : 'false'}
      className={cn('trace-fold', className)}
    >
      <div className="trace-fold-in">{everOpened || open ? children : null}</div>
    </div>
  )
}
