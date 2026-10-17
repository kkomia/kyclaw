/**
 * 正文里的网页引用角标（0.1.3 → 2026-10-18 返工）：
 * **Claude 风上标纯数字** + 有内容的 hover / focus 卡。
 *
 * 角标：
 *   - 无胶囊底/边框：accent 文本色、10.5px 自然上标（`.citation-chip-face` 只做小数位移）；
 *   - 命中区仍 ≥24×24（inline-flex 盒 24px + 负 margin 吃掉行高影响），touch-action 可点；
 *   - hover/focus 只换颜色/下划线（`markdown.css`），键盘/触摸可点，`aria-label`/`describedby` 保留；
 *   - 点击仍走真实外链 `target="_blank"`（壳既有 shell.openExternal 通路，不新增协议）。
 *
 * 卡（用户返工口径：不能只有网址）：
 *   - 头：站点视觉 + `#序号` + host；正文：标题 + 摘要（工具结果 title/snippet，fetch 也解析）；
 *     工具结果没有 title/snippet 时用**正文引用所在句子的上下文**兜底；再没有就显示来源说明；
 *   - 尾：路径（mono）+「打开网页」外链；纸色、12 圆角、hairline、`--shadow-overlay`；
 *   - `pointer-events-auto`：可悬停/选中/滚动，链接可点；portal 到 body（消息入场 transform 不影响 fixed）。
 *
 * 稳定性（流式重渲染不闪 / 移向卡片不消失）：
 *   - 打开状态提到**模块级单一 hover 管理器**（`citationHoverManager`，useSyncExternalStore 订阅）：
 *     key = citationKey，anchor 可随重挂载更新；同 key 重挂载保留 open，全局同时只有一张卡；
 *   - 关闭有 140ms 宽限 + 卡片外层 8px 内边距安全区（从角标滑到卡片不会闪没）；
 *   - 滚动不再无条件关：卡片内滚动不关；只有锚点离开视口才关；Esc / 窗口失焦立即关。
 */
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import { citationKey, hostOf, type CitationHint } from '../citations'
import { CitationContextsContext, citationHoverManager } from '../citation-hints'
import { SiteMark } from './SiteMark'

/** hover 打开延迟（focus 不延迟，键盘用户不必等）；关闭宽限在 citation-hints 管理器里 */
const CITATION_HOVER_DELAY_MS = 140
const CARD_SAFE_AREA = 8
const VIEWPORT_MARGIN = 8

/** URL → 路径（含 query；根路径显示 /） */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname === '' ? '/' : parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

export interface CitationChipProps {
  label: string
  url: string
  title?: string
  hint?: CitationHint
  /** 正文引用所在句子的上下文（工具结果缺 title/snippet 时兜底） */
  context?: string
}

export function CitationChip({
  label,
  url,
  title,
  hint,
  context
}: CitationChipProps): React.JSX.Element {
  const host = hostOf(url)
  const key = citationKey(url) ?? url

  const chipRef = useRef<HTMLAnchorElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // 渲染期不能读 ref（eslint react-hooks/refs）：用稳定 callback ref 把节点同步进 state。
  // 重挂载恢复也只在这里做：同 key 的多枚角标（fragment 变体）不能互相抢 anchor，
  // 否则两个实例的 layout effect 会 ping-pong 成 React #185（无限更新）。
  const [chipElement, setChipElement] = useState<HTMLAnchorElement | null>(null)
  const setChipNode = useCallback(
    (node: HTMLAnchorElement | null) => {
      chipRef.current = node
      setChipElement(node)
      if (node === null) return
      const state = citationHoverManager.getSnapshot()
      if (state.key !== key || state.anchor === node) return
      // 只有旧 anchor 已断开（重挂载）时才接管；另一个同 key 实例仍连着就让给它。
      if (state.anchor !== null && state.anchor.isConnected) return
      citationHoverManager.updateAnchor(key, node)
    },
    [key]
  )
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const cardId = `citation-card-${generatedId}`

  const hintedContexts = useContext(CitationContextsContext)

  const linkTitle = title?.trim() ?? ''
  const hintTitle = hint?.title?.trim() ?? ''
  const resolvedTitle = linkTitle !== '' ? linkTitle : hintTitle
  const snippet = hint?.snippet?.trim() ?? ''
  const contextText = context?.trim() ?? hintedContexts.get(key)?.trim() ?? ''
  const fallbackNote = resolvedTitle === '' && snippet === '' && contextText === ''

  const hover = useSyncExternalStore(
    citationHoverManager.subscribe,
    citationHoverManager.getSnapshot,
    citationHoverManager.getSnapshot
  )
  const open = hover.key === key && chipElement !== null && hover.anchor === chipElement

  const ariaLabel =
    resolvedTitle === '' ? `来源 ${label}：${host}` : `来源 ${label}：${resolvedTitle}（${host}）`

  // 注：重挂载的 anchor 接管放在 callback ref（见 setChipNode）；不能在 layout effect 里
  // 无条件 updateAnchor —— 同 key 多实例会互相覆盖，触发 React #185 无限更新。

  // 真卸载才安排宽限关闭；同 key 重挂载会由 setChipNode 的 updateAnchor 取消
  useEffect(() => {
    const element = chipRef.current
    return () => {
      const state = citationHoverManager.getSnapshot()
      if (state.key === key && state.anchor === element) {
        citationHoverManager.scheduleHide(key)
      }
    }
  }, [key])

  const positionCard = useCallback((): boolean => {
    const chip = chipRef.current
    const wrapper = wrapperRef.current
    if (chip === null || wrapper === null) return false
    const chipRect = chip.getBoundingClientRect()
    const wrapperRect = wrapper.getBoundingClientRect()
    if (wrapperRect.width === 0 || wrapperRect.height === 0) return false

    // wrapper 自带 CARD_SAFE_AREA 内边距：wrapper 底边贴住角标顶，视觉上卡片与角标留 8px
    const above = chipRect.top - wrapperRect.height
    const below = chipRect.bottom
    const top =
      above >= VIEWPORT_MARGIN
        ? above
        : Math.min(
            below,
            Math.max(VIEWPORT_MARGIN, window.innerHeight - wrapperRect.height - VIEWPORT_MARGIN)
          )
    const centered = chipRect.left + chipRect.width / 2 - wrapperRect.width / 2
    const maxLeft = window.innerWidth - wrapperRect.width - VIEWPORT_MARGIN
    const left = Math.min(Math.max(VIEWPORT_MARGIN, centered), Math.max(VIEWPORT_MARGIN, maxLeft))

    wrapper.style.top = `${Math.max(0, Math.min(top, Math.max(0, window.innerHeight - wrapperRect.height)))}px`
    wrapper.style.left = `${left}px`
    wrapper.dataset.placement = above >= VIEWPORT_MARGIN ? 'top' : 'bottom'
    return true
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    positionCard()
  }, [open, positionCard, resolvedTitle, snippet, contextText])

  // 滚动 / 尺寸变化：只重定位 + 锚点离开视口才关（卡片自身滚动不关）；Esc / 窗口失焦立即关
  useEffect(() => {
    if (!open) return
    const isInsideCard = (target: EventTarget | null): boolean =>
      wrapperRef.current !== null && target instanceof Node && wrapperRef.current.contains(target)

    const anchorVisible = (): boolean => {
      const chip = chipRef.current
      if (chip === null || !chip.isConnected) return false
      const rect = chip.getBoundingClientRect()
      return (
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth
      )
    }
    const onViewportChange = (event: Event): void => {
      if (isInsideCard(event.target)) return
      positionCard()
      if (!anchorVisible()) citationHoverManager.hideNow()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      citationHoverManager.hideNow()
    }
    const onWindowBlur = (): void => citationHoverManager.hideNow()

    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [open, positionCard])

  const scheduleOpen = (): void => {
    citationHoverManager.cancelHide()
    citationHoverManager.show(key, chipRef.current!, CITATION_HOVER_DELAY_MS)
  }
  const openNow = (): void => {
    citationHoverManager.show(key, chipRef.current!)
  }
  const scheduleClose = (): void => {
    citationHoverManager.scheduleHide(key)
  }
  const keepOpen = (): void => {
    citationHoverManager.cancelHide()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLAnchorElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    citationHoverManager.hideNow()
  }

  return (
    <>
      <a
        ref={setChipNode}
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
        onMouseLeave={scheduleClose}
        onFocus={openNow}
        onBlur={scheduleClose}
        onKeyDown={onKeyDown}
      >
        <span data-testid="citation-chip-face" className="citation-chip-face">
          {label}
        </span>
      </a>
      {open
        ? createPortal(
            <div
              ref={wrapperRef}
              data-testid="citation-card-anchor"
              style={{ position: 'fixed', top: 0, left: 0, padding: CARD_SAFE_AREA }}
              className="pointer-events-auto fixed z-40 max-w-[calc(100vw-16px)] rounded-panel"
              onMouseEnter={keepOpen}
              onMouseLeave={scheduleClose}
            >
              <div
                ref={cardRef}
                id={cardId}
                role="tooltip"
                data-testid="citation-card"
                className="max-h-[min(380px,calc(100vh-32px))] w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-panel border-(length:--hairline-width) border-hairline bg-surface shadow-(--shadow-overlay)"
              >
                <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
                  <SiteMark host={host} className="size-4" />
                  <span
                    data-testid="citation-card-label"
                    className="shrink-0 rounded-badge bg-(--fill-selected) px-1.5 py-0.5 font-mono text-c2 font-semibold text-ink-secondary"
                  >
                    #{label}
                  </span>
                  <span
                    data-testid="citation-card-host"
                    className="min-w-0 flex-1 truncate text-c1 text-ink-tertiary"
                  >
                    {host}
                  </span>
                </div>

                <div className="max-h-[min(300px,calc(100vh-140px))] overflow-y-auto px-3 py-2.5">
                  {resolvedTitle === '' ? null : (
                    <div
                      data-testid="citation-card-title"
                      className="line-clamp-2 text-b2 font-semibold break-words text-ink"
                    >
                      {resolvedTitle}
                    </div>
                  )}
                  {snippet === '' ? null : (
                    <p
                      data-testid="citation-card-snippet"
                      className="mt-1.5 line-clamp-3 text-c1 leading-relaxed text-ink-secondary"
                    >
                      {snippet}
                    </p>
                  )}
                  {snippet === '' && contextText !== '' ? (
                    <p
                      data-testid="citation-card-context"
                      className="mt-1.5 line-clamp-3 text-c1 leading-relaxed text-ink-secondary"
                    >
                      <span className="text-ink-tertiary">正文上下文：</span>
                      {contextText}
                    </p>
                  ) : null}
                  {fallbackNote ? (
                    <p
                      data-testid="citation-card-context"
                      className="mt-1 text-c1 leading-relaxed text-ink-secondary"
                    >
                      该来源来自本轮工具结果，正文引用处没有可提取的标题或摘要。
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center gap-2 border-t border-hairline px-3 py-2">
                  <span
                    data-testid="citation-card-path"
                    className="min-w-0 flex-1 truncate font-mono text-c2 tabular-nums text-ink-tertiary"
                  >
                    {pathOf(url)}
                  </span>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="citation-card-open"
                    className="shrink-0 text-c1 font-medium text-(--link) hover:text-(--link-hover) hover:underline"
                  >
                    打开网页 ↗
                  </a>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
