import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { UIMessage } from 'ai'
import { cn } from '@renderer/components/ui/cn'
import { activeUserIdFrom, summarizeMessage } from './message-rail-model'

/**
 * 消息导览轨（round 7，用户实拍 #10 图2/图3）：聊天区右缘的细轨，节点 = **用户消息**。
 *   - 默认只显示短横；当前节点（滚过视口上沿的最后一条用户消息）横线加长加实；
 *   - hover（或键盘聚焦）弹出摘要列表：每项 = 用户消息压成一行的文本，当前项横线加长；
 *   - 点节点 / 点摘要项 → 平滑滚动定位（reduced-motion 时直接跳，不动画）。
 * 面板走 opacity/translate 过渡（不硬切）；行为只依赖 DOM 里的消息节点，不碰消息数据。
 *
 * 驻留（round 8 用户实拍："鼠标移过去就消失了"）：鼠标移出后**延迟关闭**（宽限 300ms）——
 * 节点列与浮窗之间有 ~4px 空隙，立即关的话鼠标还没够到浮窗它就没了；进入浮窗（它是本 nav 的
 * 子节点，重入会再触发 onMouseEnter）即撤销关闭。点摘要项跳转仍立即关。
 *
 * 定位：贴右缘 `right-2`（8px 呼吸位；消息区的滚动条已按 round 8 隐藏，不再是让条的理由）。
 */
export interface MessageRailProps {
  messages: UIMessage[]
  /** 消息列的滚动容器（本组件的兄弟节点）：定位与"当前节点"跟踪都基于它 */
  containerRef: RefObject<HTMLDivElement | null>
}

/** 鼠标移出后的关闭宽限（ms）：够穿过节点列与浮窗之间的空隙并落进浮窗 */
const PANEL_CLOSE_GRACE_MS = 300

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function MessageRail({
  messages,
  containerRef
}: MessageRailProps): React.JSX.Element | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = useCallback((): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  /** 立刻展开（进入轨/浮窗、键盘聚焦都走它）：顺带撤掉还没到点的关闭定时器 */
  const openPanel = useCallback((): void => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])

  /** 延迟关闭：给鼠标留穿过空隙的时间；期间重入由 openPanel 撤销 */
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
      // 点项跳转：立即关（不等宽限），顺手撤掉待关的定时器
      cancelClose()
      setOpen(false)
    },
    [cancelClose, containerRef]
  )

  if (users.length < 2) return null

  return (
    <nav
      data-testid="message-rail"
      aria-label="消息导览"
      className="absolute top-1/2 right-2 z-10 -translate-y-1/2"
      onMouseEnter={openPanel}
      onMouseLeave={closePanelSoon}
      onFocus={openPanel}
      onBlur={(event) => {
        // 键盘路径：焦点移出整个轨（含浮窗）才关；轨内换焦点不动
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          cancelClose()
          setOpen(false)
        }
      }}
    >
      <div className="flex flex-col items-end gap-2 py-2 pl-2">
        {users.map((message) => {
          const active = message.id === activeId
          return (
            <button
              key={message.id}
              type="button"
              data-testid={`rail-node-${message.id}`}
              aria-label={summarizeMessage(message)}
              aria-current={active ? 'true' : undefined}
              onClick={() => jump(message.id)}
              className="group flex h-3 w-8 cursor-pointer items-center justify-end"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-0.5 rounded-pill transition-[width,background-color] duration-(--motion-fast) ease-main motion-reduce:transition-none',
                  active ? 'w-4 bg-ink' : 'w-2 bg-ink-tertiary opacity-60 group-hover:opacity-100'
                )}
              />
            </button>
          )
        })}
      </div>

      {/* 摘要列表：hover/聚焦展开；收起时留在 DOM 里做淡出（不硬切），并断开指针 */}
      <div
        data-testid="rail-panel"
        data-open={open ? 'true' : undefined}
        aria-hidden={open ? undefined : true}
        className={cn(
          'absolute top-1/2 right-full mr-1 w-64 -translate-y-1/2 overflow-hidden rounded-overlay bg-menu shadow-(--shadow-overlay) backdrop-blur-(--blur-glass) transition-[opacity,transform] duration-(--motion-fast) ease-main motion-reduce:transition-none',
          open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-1 opacity-0'
        )}
      >
        <ul className="max-h-72 overflow-y-auto p-1">
          {users.map((message) => {
            const active = message.id === activeId
            const summary = summarizeMessage(message)
            return (
              <li key={message.id}>
                <button
                  type="button"
                  data-testid={`rail-item-${message.id}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => jump(message.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-(--menu-item-radius) px-2 py-1.5 text-left transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none hover:bg-hover',
                    active ? 'text-ink' : 'text-ink-secondary'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-0.5 shrink-0 rounded-pill',
                      active ? 'w-4 bg-ink' : 'w-2 bg-ink-tertiary opacity-60'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-b2">{summary}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
