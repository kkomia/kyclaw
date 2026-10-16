/**
 * 缩放视口：滚动口 + "适应宽度"测量 + 指针锚定的缩放 + 漂在底部的控件。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.tsx`，改动四处：
 *   1) 去掉 DSH 的 `signal`（标签记录生命周期）那一层座位：本仓没有标签记录，改成组件自己的
 *      生命周期信号（卸载即中止手势里的挂起状态），对外接口不变；
 *   2) 类名换成 `dsh-*`（样式在 `dsh-document.css`）并引入 kyclaw 的 `ZoomControls`；
 *   3) CSS 变量 `--document-zoom*` → `--dsh-zoom*`；
 *   4) `fitWidthUpscale` 开关：默认"铺满可用宽"（本仓与浏览器/阅读器的口径），
 *      传 false 就是 DSH 的"只缩不放"；
 *   5) 控件**起始露着**（挂出来就是第一印象），之后才走 DSH 的"底部露头 / 移开收起"那一套。
 *
 * 为什么不把倍率交给 React state：捏合/滚轮一帧一档，重挂整份文档树的代价是可见的卡顿与闪；
 * 所以手势期间**同步改 CSS 变量**（`--dsh-zoom`），布局与滚动条当场跟上，位图等手势停下来
 * （`PINCH_SETTLE_DELAY_MS`）才落成偏好、由页面自己重画。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { ZoomControls, type ZoomControlsHandle } from './ZoomControls'
import {
  clampZoom,
  fitWidthZoom,
  resolveZoom,
  DEFAULT_ZOOM_BOUNDS,
  type ZoomBounds,
  type ZoomLabels,
  type ZoomPreference
} from './zoom'
import './dsh-document.css'

/** 捏合停下来多久算一手势结束（结束后才落成固定倍率偏好）。 */
const PINCH_SETTLE_DELAY_MS = 120
/** 鼠标离开控件多久后收起。 */
const CONTROLS_HIDE_DELAY_MS = 420
/** 底部这条高度里出现鼠标就把控件请出来。 */
const CONTROLS_REVEAL_HEIGHT_PX = 72

interface PointerAnchor {
  readonly surface: HTMLElement
  readonly x: number
  readonly y: number
  readonly clientX: number
  readonly clientY: number
}

/** 光标下面那一页（锚定缩放要它）：命中不到就不锚定，退回"围绕视口中心"。 */
function pointerAnchor(clientX: number, clientY: number): PointerAnchor | undefined {
  if (typeof document.elementFromPoint !== 'function') return undefined
  const hit = document.elementFromPoint(clientX, clientY)
  const surface =
    hit instanceof Element ? hit.closest<HTMLElement>('[data-dsh-zoom-surface]') : null
  if (surface === null) return undefined
  const bounds = surface.getBoundingClientRect()
  return { surface, x: clientX - bounds.left, y: clientY - bounds.top, clientX, clientY }
}

export interface ZoomViewportProps {
  /** 当前缩放偏好（受控：状态由阅读器持有，换文件时随重挂归位）。 */
  readonly preference: ZoomPreference
  /**
   * 内容原始宽（第一页量到的 CSS 像素）。未量到时按原始大小铺、也不画控件；
   * 适应宽度的"原始宽"就是它 —— 与倍率无关，所以不会自我循环。
   */
  readonly intrinsicWidth: number | undefined
  /** 适应宽度时扣掉的左右留白（页列的内边距）。 */
  readonly horizontalInset?: number
  /** 适应宽度是否允许放大（默认 true；false = DSH 的只缩不放，见文件头注）。 */
  readonly fitWidthUpscale?: boolean
  /**
   * 缩放边界（缺省 = 文档阅读器那套 25%–400%/0.25 栅格，**行为与本次改造前逐值相同**）。
   * 图片那侧传 `IMAGE_ZOOM_BOUNDS`（10%–800%、一档 ×1.25、下限跟随适应宽度）。
   */
  readonly bounds?: ZoomBounds
  readonly labels: ZoomLabels
  /** 解析出来的实际倍率（手势停下来后才上报）：页面据此重排位图。 */
  readonly onRenderZoom?: (zoom: number) => void
  readonly onPreference: (preference: ZoomPreference) => void
  /** 宿主想拿同一个滚动口做定位（回到顶部 / 滚到某页）时用。 */
  readonly scrollportRef?: (node: HTMLElement | null) => void
  readonly children: ReactNode
}

/**
 * @param props 内容、原始宽、偏好与文案。
 * @returns 自带滚动口与浮动控件的缩放视口。
 */
export function ZoomViewport(props: ZoomViewportProps): React.JSX.Element {
  const {
    intrinsicWidth,
    horizontalInset = 0,
    labels,
    onPreference,
    onRenderZoom,
    scrollportRef
  } = props
  const fitWidthUpscale = props.fitWidthUpscale ?? true
  const [viewportWidth, setViewportWidth] = useState(0)
  // 起始**露着**：控件要等第一页量到原始宽才挂出来，那一挂就是"缩放在这儿"的第一印象；
  // 之后鼠标一动就按露头/收起那套走（DSH 是进来就收着，全靠鼠标摸到右下角才发现）。
  const [controlsVisible, setControlsVisible] = useState(true)
  /** 组件生命周期信号：手势里的两处挂起状态（捏合防抖、收控件的定时器）都挂在它上面。 */
  const [lifetime] = useState(() => new AbortController())

  const fitZoom = fitWidthZoom(viewportWidth, intrinsicWidth, horizontalInset, fitWidthUpscale)
  const zoom = resolveZoom(
    props.preference,
    viewportWidth,
    intrinsicWidth,
    horizontalInset,
    fitWidthUpscale
  )
  /** 本视口的缩放边界（缺省 = 文档阅读器那套；图片那侧传它自己的那套，行为互不影响）。 */
  const zoomBounds = props.bounds ?? DEFAULT_ZOOM_BOUNDS
  /**
   * 生效边界：`fitFloor` 打开时（图片口径），连 `bounds.min` 都装不下的大图以 fit 为下限 ——
   * 否则"点缩小"会把图**放大**到 min（旧图片阅读器 round 52 的同一处理）。
   * memo 一下：值是模块常量或只在 fitZoom 变化时换新，下游的 useCallback/effect 因此不每帧重挂。
   */
  const effectiveMin =
    zoomBounds.fitFloor === true ? Math.min(zoomBounds.min, fitZoom) : zoomBounds.min
  const effectiveBounds = useMemo(
    () => (effectiveMin === zoomBounds.min ? zoomBounds : { ...zoomBounds, min: effectiveMin }),
    [zoomBounds, effectiveMin]
  )
  const zoomRef = useRef<number>(zoom)
  const frame = useRef<HTMLElement | null>(null)
  const scrollport = useRef<HTMLDivElement | null>(null)
  const controls = useRef<ZoomControlsHandle>(null)
  const pinchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const controlsHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerInRevealZone = useRef(false)
  const controlsActive = useRef(false)

  useEffect(
    () => () => {
      lifetime.abort()
    },
    [lifetime]
  )

  const clearControlsHide = useCallback((): void => {
    clearTimeout(controlsHideTimer.current)
    controlsHideTimer.current = undefined
  }, [])

  const showControls = useCallback((): void => {
    clearControlsHide()
    setControlsVisible(true)
  }, [clearControlsHide])

  const scheduleControlsHide = useCallback((): void => {
    clearControlsHide()
    if (pointerInRevealZone.current || controlsActive.current || pinchTimer.current !== undefined) {
      return
    }
    controlsHideTimer.current = setTimeout(() => {
      controlsHideTimer.current = undefined
      setControlsVisible(false)
    }, CONTROLS_HIDE_DELAY_MS)
  }, [clearControlsHide])

  const handleControlsActive = useCallback(
    (active: boolean): void => {
      controlsActive.current = active
      if (active) showControls()
      else scheduleControlsHide()
    },
    [scheduleControlsHide, showControls]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const inRevealZone =
        event.pointerType === 'mouse' &&
        event.clientY >=
          event.currentTarget.getBoundingClientRect().bottom - CONTROLS_REVEAL_HEIGHT_PX
      pointerInRevealZone.current = inRevealZone
      if (inRevealZone) showControls()
      else scheduleControlsHide()
    },
    [scheduleControlsHide, showControls]
  )

  const handlePointerLeave = useCallback((): void => {
    pointerInRevealZone.current = false
    scheduleControlsHide()
  }, [scheduleControlsHide])

  const attachFrame = useCallback((node: HTMLElement | null): void => {
    frame.current = node
    node?.style.setProperty('--dsh-zoom', String(zoomRef.current))
  }, [])

  const attachScrollport = useCallback(
    (node: HTMLDivElement | null): void => {
      scrollport.current = node
      scrollportRef?.(node)
    },
    [scrollportRef]
  )

  /** 手势期间的缩放：只改 CSS 变量与滚动位置（不落 React），并把光标下那个点钉住不动。 */
  const showZoom = useCallback(
    (next: number, clientX?: number, clientY?: number): number => {
      const node = scrollport.current as HTMLDivElement
      const previous = zoomRef.current
      next = clampZoom(next, effectiveBounds)
      if (next === previous) return previous
      const bounds = node.getBoundingClientRect()
      const x = clientX === undefined ? node.clientWidth / 2 : clientX - bounds.left
      const y = clientY === undefined ? node.clientHeight / 2 : clientY - bounds.top
      const anchor = pointerAnchor(bounds.left + x, bounds.top + y)
      const previousScrollLeft = node.scrollLeft
      const previousScrollTop = node.scrollTop
      const ratio = next / previous
      zoomRef.current = next
      frame.current?.setAttribute('data-dsh-zoom-mode', 'fixed')
      frame.current?.style.setProperty('--dsh-zoom', String(next))
      controls.current?.showZoom(next)
      if (anchor === undefined) {
        // 没命中具体某一页：围绕视口中心缩放（滚动位置按同一比例推）
        node.scrollLeft = (previousScrollLeft + x) * ratio - x
        node.scrollTop = (previousScrollTop + y) * ratio - y
      } else {
        // 命中某一页：把光标下的那个点留在原地（缩放后重新量一次它的矩形）
        const nextBounds = anchor.surface.getBoundingClientRect()
        node.scrollLeft += nextBounds.left + anchor.x * ratio - anchor.clientX
        node.scrollTop += nextBounds.top + anchor.y * ratio - anchor.clientY
      }
      return next
    },
    [effectiveBounds]
  )

  const setZoom = useCallback(
    (next: number): void => {
      clearTimeout(pinchTimer.current)
      pinchTimer.current = undefined
      // 点了加减档 / 菜单项之后鼠标正停在面板上：这一档不该把面板自己收掉
      // （R90 探针在真机上撞到过：点完 zoom-in 面板 `pointer-events:none`，第二次点击就够不着了）
      showControls()
      onPreference({ kind: 'fixed', scale: showZoom(next) })
    },
    [onPreference, showControls, showZoom]
  )

  const goFitWidth = useCallback((): void => {
    clearTimeout(pinchTimer.current)
    pinchTimer.current = undefined
    showControls()
    zoomRef.current = fitZoom
    frame.current?.setAttribute('data-dsh-zoom-mode', 'fit-width')
    frame.current?.style.setProperty('--dsh-zoom', String(fitZoom))
    controls.current?.showZoom(fitZoom)
    onPreference({ kind: 'fit-width' })
  }, [fitZoom, onPreference, showControls])

  /** 量滚动口宽（面板缩放 / 侧栏开合 / 全屏都走这一条）。 */
  useLayoutEffect(() => {
    const node = scrollport.current
    if (node === null) return
    const measure = (): void => setViewportWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])

  /** 偏好/尺寸落定后回写 CSS 变量、控件数字与实际倍率（捏合期间让位给 showZoom）。 */
  useEffect(() => {
    if (pinchTimer.current !== undefined) return
    zoomRef.current = zoom
    frame.current?.setAttribute('data-dsh-zoom-mode', props.preference.kind)
    frame.current?.style.setProperty('--dsh-zoom', String(zoom))
    controls.current?.showZoom(zoom)
    onRenderZoom?.(zoom)
  }, [onRenderZoom, props.preference.kind, zoom])

  /** Ctrl + 滚轮缩放（非被动监听：Electron 默认会让 Ctrl+滚轮缩放整个界面，这里拦下来）。 */
  useEffect(() => {
    const node = scrollport.current
    if (node === null) return
    const signal = lifetime.signal
    const clearPendingPinch = (): void => {
      clearTimeout(pinchTimer.current)
      pinchTimer.current = undefined
      clearControlsHide()
    }
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || signal.aborted) return
      event.preventDefault()
      showControls()
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? node.clientHeight
            : 1
      const delta = Math.max(-40, Math.min(40, event.deltaY * unit))
      showZoom(zoomRef.current * Math.exp(-delta * 0.01), event.clientX, event.clientY)
      clearTimeout(pinchTimer.current)
      pinchTimer.current = setTimeout(() => {
        pinchTimer.current = undefined
        onPreference({ kind: 'fixed', scale: zoomRef.current })
        scheduleControlsHide()
      }, PINCH_SETTLE_DELAY_MS)
    }
    node.addEventListener('wheel', wheel, { passive: false })
    signal.addEventListener('abort', clearPendingPinch, { once: true })
    return () => {
      node.removeEventListener('wheel', wheel)
      signal.removeEventListener('abort', clearPendingPinch)
      clearPendingPinch()
    }
  }, [clearControlsHide, onPreference, scheduleControlsHide, showControls, showZoom, lifetime])

  return (
    <div
      ref={attachFrame}
      className="dsh-zoom-frame"
      data-testid="dsh-zoom-frame"
      data-dsh-zoom-frame
      data-dsh-zoom-mode={props.preference.kind}
      style={
        {
          '--dsh-zoom': zoom,
          '--dsh-zoom-reveal-height': `${CONTROLS_REVEAL_HEIGHT_PX}px`
        } as CSSProperties
      }
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <div ref={attachScrollport} className="dsh-zoom-scrollport" data-dsh-zoom-scrollport>
        {props.children}
      </div>
      <div className="dsh-zoom-reveal-zone" data-dsh-zoom-reveal-zone aria-hidden="true" />
      {intrinsicWidth !== undefined ? (
        <ZoomControls
          ref={controls}
          zoom={zoom}
          fitWidth={props.preference.kind === 'fit-width'}
          labels={labels}
          visible={controlsVisible}
          bounds={effectiveBounds}
          onZoom={setZoom}
          onFitWidth={goFitWidth}
          onActiveChange={handleControlsActive}
        />
      ) : null}
    </div>
  )
}
