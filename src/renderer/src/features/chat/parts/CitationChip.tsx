/**
 * 正文里的网页引用角标（0.1.3）：紧凑的上标数字 + hover / focus 摘要卡。
 *
 * 交互口径：
 *   - 角标本身是**真实外链**（`target="_blank"`），点击走主进程既有的 `shell.openExternal`；
 *   - hover 延迟一拍打开（避免扫过时闪卡），键盘 focus 立即打开；Escape / 失焦 / 滚动收起；
 *   - 卡片 portal 到 `document.body`：消息入场动画的 `transform` 会改变 fixed 定位祖先，
 *     挂 body 才稳；z-index 40，低于 Dialog 的 50；
 *   - 站点视觉用本地 `SiteMark`（host 首字母 / Globe 降级），不加载远程 favicon
 *     （CSP `img-src 'self' data:` 也不放宽；真实 favicon 要走主进程代理，另立）。
 *   - 命中区至少 24×24：外链本体撑到 24px，可见的小胶囊放在内层 face 上。
 *
 * 定位用 `useLayoutEffect` 直接写 style（不 setState）：卡片挂载后量一次真实尺寸再贴边，
 * 翻转到下方 / 水平 clamp 都在这一拍完成，不会多画一帧错误位置。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import { hostOf, type CitationHint } from '../citations'
import { SiteMark } from './SiteMark'

/** hover 打开延迟（focus 不延迟，键盘用户不必等） */
const CITATION_HOVER_DELAY_MS = 140

const CARD_GAP = 8
const VIEWPORT_MARGIN = 8

export interface CitationChipProps {
  label: string
  url: string
  title?: string
  hint?: CitationHint
}

export function CitationChip({ label, url, title, hint }: CitationChipProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const chipRef = useRef<HTMLAnchorElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const cardId = `citation-card-${generatedId}`

  const host = hostOf(url)
  const linkTitle = title?.trim() ?? ''
  const hintTitle = hint?.title?.trim() ?? ''
  const resolvedTitle = linkTitle !== '' ? linkTitle : hintTitle !== '' ? hintTitle : host
  const snippet = hint?.snippet?.trim() ?? ''
  const ariaLabel =
    resolvedTitle === host ? `来源 ${label}：${host}` : `来源 ${label}：${resolvedTitle}（${host}）`

  const clearHoverTimer = useCallback((): void => {
    if (hoverTimer.current === null) return
    clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }, [])

  const close = useCallback((): void => {
    clearHoverTimer()
    setOpen(false)
  }, [clearHoverTimer])

  const openNow = useCallback((): void => {
    clearHoverTimer()
    setOpen(true)
  }, [clearHoverTimer])

  const scheduleOpen = useCallback((): void => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null
      setOpen(true)
    }, CITATION_HOVER_DELAY_MS)
  }, [clearHoverTimer])

  useEffect(() => clearHoverTimer, [clearHoverTimer])

  // 滚动 / 滚轮 / 窗口尺寸变化 / 窗口失焦都收起：卡片是 fixed 的，锚点或整个窗口一走就会悬空
  useEffect(() => {
    if (!open) return
    const onViewportChange = (): void => close()
    const onWindowKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('wheel', onViewportChange, { capture: true, passive: true })
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('blur', onViewportChange)
    window.addEventListener('keydown', onWindowKeyDown)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('wheel', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('blur', onViewportChange)
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  }, [open, close])

  useLayoutEffect(() => {
    if (!open) return
    const chip = chipRef.current
    const card = cardRef.current
    if (chip === null || card === null) return

    const chipRect = chip.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const above = chipRect.top - cardRect.height - CARD_GAP
    const below = chipRect.bottom + CARD_GAP
    const top = above >= VIEWPORT_MARGIN ? above : below
    const maxTop = window.innerHeight - cardRect.height - VIEWPORT_MARGIN
    const centered = chipRect.left + chipRect.width / 2 - cardRect.width / 2
    const maxLeft = window.innerWidth - cardRect.width - VIEWPORT_MARGIN
    const left = Math.min(Math.max(VIEWPORT_MARGIN, centered), Math.max(VIEWPORT_MARGIN, maxLeft))

    card.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop))}px`
    card.style.left = `${left}px`
  }, [open, resolvedTitle, host, snippet])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLAnchorElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  return (
    <>
      <a
        ref={chipRef}
        data-testid="citation-chip"
        data-citation-label={label}
        data-citation-host={host}
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={ariaLabel}
        aria-describedby={open ? cardId : undefined}
        className="citation-chip"
        onMouseEnter={scheduleOpen}
        onMouseLeave={close}
        onFocus={openNow}
        onBlur={close}
        onKeyDown={onKeyDown}
      >
        <span data-testid="citation-chip-face" className="citation-chip-face">
          {label}
        </span>
      </a>
      {open
        ? createPortal(
            <div
              ref={cardRef}
              id={cardId}
              role="tooltip"
              data-testid="citation-card"
              style={{ position: 'fixed', top: 0, left: 0 }}
              className="pointer-events-none fixed z-40 max-h-[calc(100vh-16px)] w-[340px] max-w-[calc(100vw-16px)] overflow-hidden rounded-panel border-(length:--hairline-width) border-hairline bg-surface p-3 shadow-(--shadow-overlay)"
            >
              <div className="flex items-start gap-2">
                <SiteMark host={host} className="mt-0.5 size-4" />
                <div className="min-w-0">
                  <div
                    data-testid="citation-card-host"
                    className="truncate text-c1 text-ink-tertiary"
                  >
                    {host}
                  </div>
                  {resolvedTitle === host ? null : (
                    <div
                      data-testid="citation-card-title"
                      className="mt-0.5 line-clamp-2 text-b2 font-medium break-words text-ink"
                    >
                      {resolvedTitle}
                    </div>
                  )}
                  {snippet === '' ? null : (
                    <p
                      data-testid="citation-card-snippet"
                      className="mt-1.5 line-clamp-2 text-c1 text-ink-secondary"
                    >
                      {snippet}
                    </p>
                  )}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
