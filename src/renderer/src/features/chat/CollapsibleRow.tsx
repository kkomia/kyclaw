import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 初始页那两行（卡片上方的「选择项目」、卡片下方的能力入口 + PPT）的**离场**（round 76）。
 *
 * 为什么要有它（用户点名的雷点 5"禁止闪现"）：这两行原来是 `{hero ? <div/> : null}` —— 第一句
 * 话发出去的那一刻**整块卸载**：进场有动画（跟着宿主的 `animate-message-in`），离场却是硬切。
 * 现在改成**常挂**，离场走 welcome-spacer 同一条路子：高度用容器级 `grid-template-rows`
 * 1fr → 0fr 收合（行自己的 `mb-2`/`mt-2` 被 `overflow-hidden` 一起裁掉，收到底就是 0 高、不留缝），
 * 同时 opacity 淡出。时长取**主档**（`--motion-main`）——与进场同一档，全程不硬切。
 * 与 `.trace-fold`（tailwind.css round 6 那段）是同一种收合手法，只是这里收的是"初始页的装饰行"。
 *
 * 进场不在这里管：宿主那一格（页脚的 `animate-message-in`）已经带着整块淡入上浮，
 * 这里再叠一套动画就是两段动画打架（口径同 CapabilityRow 头注）。所以这里只有"常驻 + 收合"。
 *
 * 出场之后不卸载（要有对象可动，否则又变回硬切）：`inert` + `pointer-events-none` 保证收起来
 * 的那一行既不吃点击、也进不了 Tab 序列。压根没进过初始页的会话（挂载时就有历史）不渲染它。
 */
export interface CollapsibleRowProps {
  /** 这一行该不该在（初始页 = 在；进对话 = 收成 0 高） */
  active: boolean
  /** 行本体的 testid（行自己的配方类名挂在它身上，见调用方） */
  testId: string
  className?: string
  children: React.ReactNode
}

export function CollapsibleRow({
  active,
  testId,
  className,
  children
}: CollapsibleRowProps): React.JSX.Element | null {
  // render 期按 props 调 state（与 WelcomeHero 同一写法；不走 effect 就没有级联渲染）
  const [everActive, setEverActive] = useState(active)
  if (active && !everActive) setEverActive(true)
  if (!everActive) return null

  return (
    <div
      data-testid={`${testId}-collapse`}
      data-active={active ? 'true' : 'false'}
      aria-hidden={active ? undefined : true}
      inert={!active}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-(--motion-main) ease-main motion-reduce:transition-none',
        active ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'
      )}
    >
      {/* `min-h-0` 是收合的关键（grid 项默认 min-height:auto，不收的话顶住不缩）；
          `overflow-hidden` 把行自己的外边距一起裁掉，收合到位 = 0 高、不留缝 */}
      <div className="min-h-0 overflow-hidden">
        <div data-testid={testId} className={className}>
          {children}
        </div>
      </div>
    </div>
  )
}
