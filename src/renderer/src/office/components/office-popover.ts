/**
 * 面内浮层定位（task-76）：ribbon 的自绘 select 菜单 / 色板需要**逃出 `.ofr-band` 的
 * `overflow-x:auto; overflow-y:hidden` 裁切**，所以走 `createPortal(document.body)` +
 * `position:fixed`，按触发器 rect 定位。
 *
 * 为什么不直接在 `.ofr-split`/`.ofr-select` 里放绝对定位浮层：band 为了横滚设了
 * `overflow-y:hidden`，浮层向下展开会被裁掉一半（A2 的色板就有这个问题，只是色板矮没暴露）。
 *
 * 口径：
 *   - 打开时算一次位置；窗口 resize / 任意祖先滚动（capture）时重算，**不关闭**（面内滚动不该打断）；
 *   - 点浮层/触发器之外、或 trigger 断开连接 → 关闭；
 *   - 空间不够时向上翻；左右夹到视口内（窄窗不溢出）；
 *   - maxHeight 不超过视口可用高度（列表内部滚动，见 office-chrome.css 的 `.ofr-select-menu`）。
 * 纯 DOM 测量 + 事件订阅，jsdom 里 rect 全是 0 也能工作（只是位置贴左上，不影响交互断言）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject
} from 'react'

export interface AnchoredPanelOptions {
  /** 与触发器的间距（px） */
  gap?: number
  /** 浮层最小宽度（px；默认跟触发器同宽） */
  minWidth?: number
  /** 浮层最大高度（px；再大就内部滚动） */
  maxHeight?: number
  /** 向上展开所需的「下方最小空间」判断阈值（px） */
  flipThreshold?: number
  /**
   * 浮层宽度是否严格等于触发器宽度（默认 true；色板用）。
   * false = 以触发器宽度为 **min-width**、按内容自然放宽（ribbon select：窄档下触发器可压窄，
   * 但「微软雅黑 / Calibri Light」等长选项要完整显示，不被触发器宽度截断）。
   */
  matchTriggerWidth?: boolean
}

export interface AnchoredPanel {
  /** 浮层的固定定位样式 */
  style: CSSProperties
  /** 当前展开方向（data-* / 动画方向用） */
  placement: 'bottom' | 'top'
  /** 重算位置（选项列表变化/字体加载后调用） */
  reposition(): void
}

const DEFAULT_MAX_HEIGHT = 240
const VIEWPORT_MARGIN = 8

export function useAnchoredPanel(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
  onDismiss: () => void,
  options: AnchoredPanelOptions = {}
): AnchoredPanel {
  const {
    gap = 4,
    minWidth,
    maxHeight = DEFAULT_MAX_HEIGHT,
    flipThreshold = 96,
    matchTriggerWidth = true
  } = options
  const [rect, setRect] = useState<{ top: number; left: number; width: number; up: boolean }>({
    top: 0,
    left: 0,
    width: 0,
    up: false
  })

  const reposition = useCallback((): void => {
    const anchor = anchorRef.current
    if (anchor === null) return
    const box = anchor.getBoundingClientRect()
    const viewportWidth = window.innerWidth || 1024
    const viewportHeight = window.innerHeight || 768
    const width = Math.max(minWidth ?? 0, Math.round(box.width))
    const spaceBelow = viewportHeight - box.bottom - gap - VIEWPORT_MARGIN
    const up = spaceBelow < Math.min(flipThreshold, maxHeight) && box.top > spaceBelow
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(Math.round(box.left), viewportWidth - width - VIEWPORT_MARGIN)
    )
    setRect({
      top: up ? Math.max(VIEWPORT_MARGIN, Math.round(box.top - gap)) : Math.round(box.bottom + gap),
      left,
      width,
      up
    })
  }, [anchorRef, gap, maxHeight, flipThreshold, minWidth])

  // 打开时同步算位置（绘制前），避免先出现在左上角再跳
  useLayoutEffect(() => {
    if (!open) return
    reposition()
  }, [open, reposition])

  // 打开期间：resize / 祖先滚动重算；点外关闭；Escape 关闭
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (anchor?.contains(target) === true) return
      if (panel?.contains(target) === true) return
      onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    const onReflow = (): void => reposition()
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, anchorRef, panelRef, onDismiss, reposition])

  const style: CSSProperties = {
    position: 'fixed',
    left: rect.left,
    width: matchTriggerWidth && rect.width > 0 ? rect.width : undefined,
    minWidth: matchTriggerWidth ? undefined : rect.width > 0 ? rect.width : undefined,
    maxWidth: matchTriggerWidth ? undefined : 'min(360px, calc(100vw - 16px))',
    maxHeight: Math.min(maxHeight, (window.innerHeight || 768) - VIEWPORT_MARGIN * 2),
    ...(rect.up
      ? { bottom: Math.max(VIEWPORT_MARGIN, (window.innerHeight || 768) - rect.top + gap) }
      : { top: rect.top })
  }

  return { style, placement: rect.up ? 'top' : 'bottom', reposition }
}
