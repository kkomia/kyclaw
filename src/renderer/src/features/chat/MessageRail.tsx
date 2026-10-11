import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { UIMessage } from 'ai'
import { cn } from '@renderer/components/ui/cn'
import { useShellStore } from '@renderer/lib/shell-store'
import { activeUserIdFrom, summarizeMessage } from './message-rail-model'

/**
 * 消息导览轨（round 7；round 17 按用户实拍重做；round 22 行文字左对齐）：
 *   每个用户消息 = **一行** `[摘要文本 flex-1 … 右端横线]`；**收起态只显横线列**（文本收成 0 宽），
 *   hover/聚焦展开——**整块**圆角底把全部横线一起包住（横线是行的子元素，永远在背景里：
 *   不超出、不被圆角裁、不上下露头）。浮窗行内**没有前导横条**；当前项用文字色/字重 +
 *   更长的横线区分。**文本左对齐**（round 22 用户口径："文字做左对齐，不要右对齐"）——
 *   文本容器 flex-1、溢出自带省略号；横线仍固定贴行右端。超高时整块一起滚。
 *   位置：chat 页根右缘 `right-2`（round 21：定位基准是 chat-page 整幅，8px 呼吸位）。
 *   工作台（`useShellStore.workPanelOpen`）打开时**整条轨不渲染**（展开右侧边栏就隐藏摘要条）。
 *
 * 驻留（round 8 用户实拍"鼠标移过去就消失了"）：鼠标移出后延迟关闭（宽限 300ms），
 * 进入轨（整块就是一个命中区）即撤销；点行跳转立即关。
 * 行为：点行 → 平滑滚动定位（reduced-motion 直跳）；键盘聚焦展开、Enter 跳、Esc 关。
 */
export interface MessageRailProps {
  messages: UIMessage[]
  /** 消息列的滚动容器（本组件的兄弟节点）：定位与"当前节点"跟踪都基于它 */
  containerRef: RefObject<HTMLDivElement | null>
}

/** 鼠标移出后的关闭宽限（ms）：够穿过轨道右缘的呼吸位并落回轨道 */
const PANEL_CLOSE_GRACE_MS = 300

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function MessageRail({
  messages,
  containerRef
}: MessageRailProps): React.JSX.Element | null {
  const workPanelOpen = useShellStore((state) => state.workPanelOpen)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = useCallback((): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  /** 立刻展开（进入轨、键盘聚焦都走它）：顺带撤掉还没到点的关闭定时器 */
  const openPanel = useCallback((): void => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])

  /** 延迟关闭：给鼠标留穿过呼吸位的时间；期间重入由 openPanel 撤销 */
  const closePanelSoon = useCallback((): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, PANEL_CLOSE_GRACE_MS)
  }, [cancelClose])

  // 卸载清理：定时器不残留
  useEffect(() => cancelClose, [cancelClose])

  // 依赖数组里要稳定：否则每次滚动引起的 setState → 重渲染 → 重订阅一圈（syncActive 的依赖）
  const users = useMemo(() => messages.filter((message) => message.role === 'user'), [messages])

  const syncActive = useCallback((): void => {
    const container = containerRef.current
    if (!container) return
    const containerTop = container.getBoundingClientRect().top
    const entries = users.flatMap((message) => {
      const element = container.querySelector(`[data-testid="message-${message.id}"]`)
      if (element === null) return []
      return [{ id: message.id, top: element.getBoundingClientRect().top - containerTop }]
    })
    setActiveId(activeUserIdFrom(entries))
  }, [containerRef, users])

  // 滚动跟踪 + 挂载/消息变化时对一次表
  useEffect(() => {
    const container = containerRef.current
    syncActive()
    if (!container) return
    container.addEventListener('scroll', syncActive, { passive: true })
    return () => container.removeEventListener('scroll', syncActive)
  }, [containerRef, syncActive])

  const jump = useCallback(
    (id: string): void => {
      const container = containerRef.current
      const element = container?.querySelector(`[data-testid="message-${id}"]`)
      if (element) {
        const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
        if (typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ behavior, block: 'start' })
        }
      }
      setActiveId(id)
      // 点行跳转：立即关（不等宽限），顺手撤掉待关的定时器
      cancelClose()
      setOpen(false)
    },
    [cancelClose, containerRef]
  )

  if (users.length < 2 || workPanelOpen) return null

  return (
    <nav
      data-testid="message-rail"
      aria-label="消息导览"
      className={cn(
        'absolute top-1/2 right-2 z-10 max-h-[70vh] -translate-y-1/2 overflow-y-auto rounded-overlay [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'transition-[background-color] duration-(--motion-fast) ease-main motion-reduce:transition-none',
        // 展开 = 圆角底把**全部**横线包住（背景画在滚动容器自己的盒子上，滚动时也不脱底）
        open && 'bg-menu shadow-(--shadow-overlay) backdrop-blur-(--blur-glass)'
      )}
      onMouseEnter={openPanel}
      onMouseLeave={closePanelSoon}
      onFocus={openPanel}
      onBlur={(event) => {
        // 键盘路径：焦点移出整个轨才关；轨内换焦点不动
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          cancelClose()
          setOpen(false)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelClose()
          setOpen(false)
        }
      }}
    >
      <div
        data-testid="rail-panel"
        data-open={open ? 'true' : undefined}
        className="flex flex-col p-1"
      >
        {users.map((message) => {
          const active = message.id === activeId
          const summary = summarizeMessage(message)
          return (
            <button
              key={message.id}
              type="button"
              data-testid={`rail-node-${message.id}`}
              aria-label={summary}
              aria-current={active ? 'true' : undefined}
              onClick={() => jump(message.id)}
              className={cn(
                'flex h-7 w-full cursor-pointer items-center gap-3 rounded-(--menu-item-radius) pr-1 pl-3 transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
                open && 'hover:bg-hover'
              )}
            >
              {/* 文本容器（flex-1）：占满剩余宽度、**左对齐**（round 22 用户口径"文字做左对齐"）——
                  横线因此固定贴行右端；摘要文本挂在内层 span 上做 0↔满宽的开合过渡 */}
              <span className="flex min-w-0 flex-1 items-center justify-start">
                <span
                  data-testid={`rail-item-${message.id}`}
                  aria-hidden="true"
                  className={cn(
                    'truncate text-left text-b2 transition-[max-width,opacity] duration-(--motion-fast) ease-main motion-reduce:transition-none',
                    open ? 'max-w-56 opacity-100' : 'max-w-0 opacity-0',
                    active ? 'font-medium text-ink' : 'text-ink-secondary'
                  )}
                >
                  {summary}
                </span>
              </span>
              {/* 行右端的横线（固定位置）：当前项加长加实；所有行靠右对齐成一列 */}
              <span
                aria-hidden="true"
                data-testid={`rail-line-${message.id}`}
                className={cn(
                  'h-0.5 shrink-0 rounded-pill transition-[width,background-color] duration-(--motion-fast) ease-main motion-reduce:transition-none',
                  active ? 'w-4 bg-ink' : 'w-2 bg-ink-tertiary opacity-60'
                )}
              />
            </button>
          )
        })}
      </div>
    </nav>
  )
}
