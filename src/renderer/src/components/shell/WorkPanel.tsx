import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode
} from 'react'
import { clampWorkPanelWidth, WORK_PANEL_DEFAULT_WIDTH } from '@renderer/lib/shell-store'
import { cn } from '../ui/cn'

/** 尽力释放指针捕获；元素已卸载 / 指针已失效时 hasPointerCapture 会说不（捕获随卸载由浏览器隐式释放） */
function releasePointerCapture(element: HTMLElement | null, pointerId: number): void {
  if (pointerId === -1 || element === null) return
  try {
    if (element.hasPointerCapture?.(pointerId) === true) element.releasePointerCapture(pointerId)
  } catch {
    // 指针已经不在 / 节点已卸载：捕获由浏览器隐式释放，这里只是尽力收尾
  }
}

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
 *     round 59 用户实拍：内容区从 x=0 起（左缘垫在侧栏浮层下面），全屏时面板铺满整幅 → 左半边
 *     被会话列表盖住。故全屏态补**可见左缘偏移** `ml-(--content-safe-left)`（侧栏收起时该变量为 0，
 *     自动无偏移），并把 `margin-left` 一起纳入过渡属性表（与侧栏开合同拍，不硬切）。
 *     非全屏 docked 模式不动：它在右缘，跟左缘那条变量无关。
 * 宽度走内联的 `--work-panel-width` 覆盖：token 仍是唯一出口，内层/外层因此永远同值。
 *
 * round 77：`fullscreen` 这一层只管"摆法"，来源有两处 —— 用户偏好（⤢）与**空间不足**的临时形态
 * （AppShell 量出来之后把结论当 fullscreen 传进来）。后者由 `spaceConstrained` 标出来，落成
 * `data-fullscreen-source="auto"`（用户偏好 = "user"，没全屏 = "none"；两者都成立时标 auto ——
 * 铺满的直接原因是空间）：探针/E2E 一眼能分清"是用户开的全屏"还是"窄窗被逼铺满"，
 * 也提醒调用方全屏偏好本身没被改过。
 *
 * round 79（实机边界）：越界转 auto / 切全屏 / 收面板都会**把把手从 DOM 里拿掉**。拖动中途被拿掉时，
 * pointerup 落不到已卸载的节点上 → 残留的 dragging 会让 `transition-none` 与强调蓝线永远挂着。
 * 所以：拖动期间的 move/up/cancel/lostpointercapture 挂在 **window** 上（手柄卸了也收得到），
 * 且"不再 resizable"与卸载时都显式收尾（清拖动标记 + 释放捕获）；正常拖宽行为不变。
 *
 * 内容层是 flex 列、**自己不滚动**（工作台四工具各自管自己的滚动区）：
 * 终端与内嵌浏览器都要一块能真正撑满的容器，外层给它 overflow-y-auto 会把高度算崩。
 */
export interface WorkPanelProps {
  open: boolean
  fullscreen?: boolean
  /** fullscreen 是空间不足导致的（不是用户偏好）—— 只影响标出来的 data 属性 */
  spaceConstrained?: boolean
  /** 面板宽度（px）；不传就用 token 的默认档 */
  width?: number
  /** 拖动 / 双击复位的落点（已经在容器 70% 上限内夹过） */
  onWidthChange?: (width: number) => void
  children?: ReactNode
}

export function WorkPanel({
  open,
  fullscreen = false,
  spaceConstrained = false,
  width,
  onWidthChange,
  children
}: WorkPanelProps): React.JSX.Element {
  const asideRef = useRef<HTMLElement | null>(null)
  const resizerRef = useRef<HTMLDivElement | null>(null)
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

  const resizable = open && !fullscreen && onWidthChange !== undefined

  /** 拖动收尾（幂等）：清标记 + 释放捕获。传了 pointerId 就只认那一个指针，多指同按下不误伤 */
  const endDrag = useCallback((pointerId?: number): void => {
    const drag = dragRef.current
    if (drag.pointerId === -1) return
    if (pointerId !== undefined && pointerId !== drag.pointerId) return
    releasePointerCapture(resizerRef.current, drag.pointerId)
    dragRef.current.pointerId = -1
    setDragging(false)
  }, [])

  // 落点走 ref：拖动期间父组件若给了新的 onWidthChange 标识（内联箭头那种），监听器也不重挂
  // —— 重挂会把 cleanup 跑一遍，反而把正在进行的拖动掐掉
  const commitRef = useRef(commitWidth)
  useEffect(() => {
    commitRef.current = commitWidth
  }, [commitWidth])

  /**
   * 拖动期间把 move/up 挂在 **window** 上，不是手柄自己身上：手柄会在拖动中途被卸载
   * （越界转 auto / 切全屏 / 收面板），那时落不到它的 pointerup 就永远不来 → dragging 残留。
   * 卸载时顺手释放捕获，别把捕获留在已卸载的节点上。
   */
  useLayoutEffect(() => {
    if (!dragging) return
    // 捕获进局部：cleanup 跑的时候 resizerRef 可能已经指向 null（节点被摘了）
    const resizer = resizerRef.current
    const onMove = (event: globalThis.PointerEvent): void => {
      const drag = dragRef.current
      if (drag.pointerId === -1 || event.pointerId !== drag.pointerId) return
      // 往左拖 = 变宽
      commitRef.current(drag.startWidth + (drag.startX - event.clientX))
    }
    const onEnd = (event: globalThis.PointerEvent): void => endDrag(event.pointerId)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    window.addEventListener('lostpointercapture', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('lostpointercapture', onEnd)
      releasePointerCapture(resizer, dragRef.current.pointerId)
      dragRef.current.pointerId = -1
    }
  }, [dragging, endDrag])

  // 手柄没了（不再可拖）就把拖动收干净：不靠"指针迟早会松开"这种运气
  useLayoutEffect(() => {
    if (!resizable) endDrag()
  }, [resizable, endDrag])

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

  return (
    <aside
      ref={asideRef}
      data-testid="work-panel"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      data-fullscreen-source={fullscreen ? (spaceConstrained ? 'auto' : 'user') : 'none'}
      style={
        width === undefined ? undefined : ({ '--work-panel-width': `${width}px` } as CSSProperties)
      }
      className={cn(
        'relative flex shrink-0 overflow-hidden border-hairline transition-[width,margin-left] duration-(--motion-main) ease-main',
        open ? 'is-open border-l' : 'w-0',
        open && (fullscreen ? 'ml-(--content-safe-left) flex-1' : 'w-(--work-panel-width)'),
        dragging && 'transition-none'
      )}
    >
      {resizable ? (
        <div
          ref={resizerRef}
          data-testid="work-panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整工作台宽度"
          onPointerDown={onPointerDown}
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
