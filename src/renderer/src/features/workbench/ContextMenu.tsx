/**
 * 自绘的定点右键菜单（雷点 4：客户端内的右键菜单必须重写，且浏览器自带项一律不出现）。
 *
 * 为什么不用 ui/menu.tsx（Radix 的 DropdownMenu）：那是"挂在触发元素上"的菜单；这里的坐标来自
 * 右键事件（clientX/clientY），用一个受控的浮层自己画更直接，也省掉一个隐藏的触发器元素。
 * 行为照桌面习惯：Esc 关闭、点外面关闭、滚动关闭、窗口失焦关闭；坐标贴边时回收进视口。
 * 进出场走 --animate-overlay-in（与其它浮层同一配方，不硬切）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { OVERLAY_SURFACE_CLASS } from '@renderer/components/ui/surface'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: ReactNode
  /** 危险动作（红字 + 危险底）：v1 没有这类项，留着给后续（删除等） */
  danger?: boolean
  onSelect: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

export function ContextMenu({
  state,
  onClose,
  testId = 'workbench-context-menu'
}: {
  state: ContextMenuState
  onClose: () => void
  testId?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: state.x, y: state.y })

  // 量一次真实尺寸再贴边回收（浮层宽度随文案变，不能在渲染前算准）
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    const rect = node.getBoundingClientRect()
    const margin = 8
    setOffset({
      x: Math.max(margin, Math.min(state.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(state.y, window.innerHeight - rect.height - margin))
    })
  }, [state.x, state.y, state.items])

  useEffect(() => {
    const close = (): void => {
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close, true)
    // 用 wheel 而不是 scroll 来"滚动即关"：**程序化的 scroll 事件是异步补发的**——
    // 打开菜单前为把目标行滚进视口触发的那次滚动，会在菜单挂上之后才送达，从而把刚开的
    // 菜单立刻关掉（真机实测：列表需要滚动时右键菜单一闪就没）。滚轮手势没有这个问题。
    window.addEventListener('wheel', close, { capture: true, passive: true })
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      data-testid={testId}
      role="menu"
      style={{ left: offset.x, top: offset.y }}
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(OVERLAY_SURFACE_CLASS, 'animate-overlay-in fixed min-w-40 p-(--menu-pad)')}
    >
      {state.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-testid={`${testId}-${item.id}`}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
          className={cn(
            'flex h-(--menu-item-height) w-full cursor-default items-center gap-2 rounded-(--menu-item-radius) px-2 text-left text-b2 outline-none transition-colors duration-(--motion-fast) ease-main hover:bg-hover',
            item.danger === true ? 'text-danger hover:bg-danger-bg' : 'text-ink'
          )}
        >
          {item.icon === undefined ? null : (
            <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
              {item.icon}
            </span>
          )}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  )
}
