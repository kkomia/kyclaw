import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode
} from 'react'
import { clampWorkPanelWidth, WORK_PANEL_DEFAULT_WIDTH } from '@renderer/lib/shell-store'
import { cn } from '../ui/cn'

/**
 * 右栏：工作台面板（spec §6.5 刻意偏离：Kimi 没有，kyclaw 加 ~400px；R2 D4 起并入对话区）。
 * 它**不是独立的第三根柱子**：底色跟随内容区（AppShell 的 content-region，--bg-primary），
 * 与消息区之间只有一条分隔线（雷点 7：不出现双层框线），归属同一块面。
 * 可收起：收起时不占宽（w-0 + overflow-hidden），展开才有 --work-panel-width —— 主列因此拿回空间。
 * `is-open` 是给测试/E2E 认的状态类；内层宽度跟外层同一条变量，收放动画时文字不重排。
 *
 * round 39（用户口径）：
 *   - **可拖拽调宽**：左缘 6px 命中区（`work-panel-resizer`，cursor col-resize），宽度写回
 *     shell-store（280–760，且不超过内容区实测宽的 70%）；拖动期间关掉宽度过渡（跟手），
 *     松手恢复；双击把手回默认 400；hover 显灰线、拖动显强调线（都是 150ms 过渡，不硬切）；
 *     内容区变窄时（窗口缩小）把过宽的宽度收回 70% 以内。
 *   - **全屏**：`fullscreen` 时占满内容区（中列的隐藏由 AppShell 做），宽度与把手都让位。
 * 宽度走内联的 `--work-panel-width` 覆盖：token 仍是唯一出口，内层/外层因此永远同值。
 *
 * 内容层是 flex 列、**自己不滚动**（工作台四工具各自管自己的滚动区）：
 * 终端与内嵌浏览器都要一块能真正撑满的容器，外层给它 overflow-y-auto 会把高度算崩。
 */
export interface WorkPanelProps {
  open: boolean
  fullscreen?: boolean
  /** 面板宽度（px）；不传就用 token 的默认档 */
  width?: number
  /** 拖动 / 双击复位的落点（已经在容器 70% 上限内夹过） */
  onWidthChange?: (width: number) => void
  children?: ReactNode
}

export function WorkPanel({
  open,
  fullscreen = false,
  width,
  onWidthChange,
  children
}: WorkPanelProps): React.JSX.Element {
  const asideRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef({ pointerId: -1, startX: 0, startWidth: WORK_PANEL_DEFAULT_WIDTH })
  const [dragging, setDragging] = useState(false)

  /** 内容区实测宽（面板的父元素就是内容卡；拿不到就当未知，只按 280–760 夹） */
  const containerWidth = useCallback(
    (): number => asideRef.current?.parentElement?.clientWidth ?? 0,
    []
  )

  const commitWidth = useCallback(
    (next: number): void => {
      onWidthChange?.(clampWorkPanelWidth(next, containerWidth()))
    },
    [containerWidth, onWidthChange]
  )

  // 窗口变窄后把过宽的宽度收回 70% 以内（拖动上限只在拖的那一刻算过一次；不回收的话
  // 拉宽过再缩窗会把内容列挤没）。拖动中不动它 —— 那会跟手打架。
  const widthRef = useRef(width ?? WORK_PANEL_DEFAULT_WIDTH)
  useEffect(() => {
    widthRef.current = width ?? WORK_PANEL_DEFAULT_WIDTH
  }, [width])
  useEffect(() => {
    const container = asideRef.current?.parentElement
    if (!open || fullscreen || onWidthChange === undefined) return
    if (container == null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (dragRef.current.pointerId !== -1) return
      const current = widthRef.current
      const capped = clampWorkPanelWidth(current, container.clientWidth)
      if (capped !== current) onWidthChange(capped)
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [open, fullscreen, onWidthChange])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width ?? WORK_PANEL_DEFAULT_WIDTH
    }
    // jsdom 没有指针捕获（可选调用）；真浏览器里捕获后，指针移出 6px 命中区也不丢事件
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!dragging || event.pointerId !== drag.pointerId) return
    // 往左拖 = 变宽
    commitWidth(drag.startWidth + (drag.startX - event.clientX))
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    dragRef.current.pointerId = -1
    setDragging(false)
  }

  const resizable = open && !fullscreen && onWidthChange !== undefined

  return (
    <aside
      ref={asideRef}
      data-testid="work-panel"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      style={
        width === undefined ? undefined : ({ '--work-panel-width': `${width}px` } as CSSProperties)
      }
      className={cn(
        'relative flex shrink-0 overflow-hidden border-hairline transition-[width] duration-(--motion-main) ease-main',
        open ? 'is-open border-l' : 'w-0',
        open && (fullscreen ? 'flex-1' : 'w-(--work-panel-width)'),
        dragging && 'transition-none'
      )}
    >
      {resizable ? (
        <div
          data-testid="work-panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整工作台宽度"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => commitWidth(WORK_PANEL_DEFAULT_WIDTH)}
          className="group absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize"
        >
          {/* 高亮线压在分隔线上：hover 灰（Fills-F3）、拖动强调蓝；150ms 过渡，不硬切 */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 left-0 w-px transition-colors duration-(--motion-fast) ease-main',
              dragging ? 'bg-accent' : 'bg-transparent group-hover:bg-active'
            )}
          />
        </div>
      ) : null}
      <div
        className={cn(
          'flex shrink-0 flex-col overflow-hidden',
          fullscreen ? 'w-full' : 'w-(--work-panel-width)'
        )}
      >
        {children}
      </div>
    </aside>
  )
}
