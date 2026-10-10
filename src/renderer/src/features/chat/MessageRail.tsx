import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
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
 * 定位（T16 小修批）：贴右缘 `right-2` —— 滚动条宽 6px，早先的 `right-1`（4px）会被它压住 2px。
 */
export interface MessageRailProps {
  messages: UIMessage[]
  /** 消息列的滚动容器（本组件的兄弟节点）：定位与"当前节点"跟踪都基于它 */
  containerRef: RefObject<HTMLDivElement | null>
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function MessageRail({
  messages,
  containerRef
}: MessageRailProps): React.JSX.Element | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

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
      setOpen(false)
    },
    [containerRef]
  )

  if (users.length < 2) return null

  return (
    <nav
      data-testid="message-rail"
      aria-label="消息导览"
      className="absolute top-1/2 right-2 z-10 -translate-y-1/2"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
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
