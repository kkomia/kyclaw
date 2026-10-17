/**
 * 自绘的定点右键菜单（雷点 4：客户端内的右键菜单必须重写，且浏览器自带项一律不出现）。
 *
 * 为什么不用 ui/menu.tsx（Radix 的 DropdownMenu）：那是"挂在触发元素上"的菜单；这里的坐标来自
 * 右键事件（clientX/clientY），用一个受控的浮层自己画更直接，也省掉一个隐藏的触发器元素。
 * 行为照桌面习惯：Esc 关闭、点外面关闭、滚动关闭、窗口失焦关闭；坐标贴边时回收进视口。
 * 进出场走 --animate-overlay-in（与其它浮层同一配方，不硬切）。
 *
 * 键盘：`autoFocus`（默认关，预览的既有右键路径不变）在挂载时把焦点交给第一项；
 * 菜单内 ↑/↓/Home/End 导航，Esc 关闭。关闭原因回传给调用方（点项 / Esc / 点外 / 滚动 / 失焦），
 * 由调用方决定是否把焦点还给 invoker —— 共享件本身不抢焦点，避免影响预览等既有宿主。
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

/** 菜单关闭原因：只有调用方需要区分"Esc / 点项"与"点外 / 滚动 / 失焦"时才用 */
export type ContextMenuCloseReason = 'item' | 'escape' | 'outside' | 'wheel' | 'resize' | 'blur'

export function ContextMenu({
  state,
  onClose,
  autoFocus = false,
  testId = 'workbench-context-menu'
}: {
  state: ContextMenuState
  onClose: (reason?: ContextMenuCloseReason) => void
  /** 挂载时把焦点交给第一项（默认关：预览等既有宿主行为不变） */
  autoFocus?: boolean
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

  // 可选：键盘用户打开菜单时直接进入第一项（预览等宿主不传 autoFocus，行为不变）
  useLayoutEffect(() => {
    if (!autoFocus) return
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [autoFocus, state.items])

  /** 菜单内方向键 / Home / End：焦点在菜单项之间循环走，Enter/Space 仍由原生 button 触发 */
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    ]
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? current < 0
              ? 0
              : (current + 1) % buttons.length
            : current <= 0
              ? buttons.length - 1
              : current - 1
    buttons[next]?.focus()
  }

  useEffect(() => {
    // 点在菜单**自己里面**不关：真机一次点击是 pointerdown →（mouseup）→ click 三次事件，
    // 捕获阶段的 pointerdown 若先把菜单卸掉，后面的 click 就落在空气上——用户实报「点了没反应」。
    // （回归：files-tool.spec 的「真实鼠标路径：pointerdown → click」用例。）
    const closeOutside = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node) === true) return
      onClose('outside')
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose('escape')
    }
    const onWheel = (): void => onClose('wheel')
    const onResize = (): void => onClose('resize')
    const onBlur = (): void => onClose('blur')
    window.addEventListener('pointerdown', closeOutside, true)
    // 用 wheel 而不是 scroll 来"滚动即关"：**程序化的 scroll 事件是异步补发的**——
    // 打开菜单前为把目标行滚进视口触发的那次滚动，会在菜单挂上之后才送达，从而把刚开的
    // 菜单立刻关掉（真机实测：列表需要滚动时右键菜单一闪就没）。滚轮手势没有这个问题。
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
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
      onKeyDown={onMenuKeyDown}
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
            onClose('item')
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
