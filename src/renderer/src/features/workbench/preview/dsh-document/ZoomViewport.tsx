/**
 * 缩放视口：滚动口 + fit 测量（适应宽度 / 适应窗口）+ 指针锚定的缩放 + 漂在底部的控件。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.tsx`，改动七处：
 *   1) 去掉 DSH 的 `signal`（标签记录生命周期）那一层座位：本仓没有标签记录。wheel 监听由
 *      effect 自己安装/清理（**StrictMode 双跑 effect 也安全**：不把 AbortController 放进
 *      state 里复用，避免第二次 mount 拿到已 abort 的 signal）；对外接口不变；
 *   2) 类名换成 `dsh-*`（样式在 `dsh-document.css`）并引入 kyclaw 的 `ZoomControls`；
 *   3) CSS 变量 `--document-zoom*` → `--dsh-zoom*`；
 *   4) `fitWidthUpscale` 开关：默认"铺满可用宽"（本仓与浏览器/阅读器的口径），
 *      传 false 就是 DSH 的"只缩不放"；
 *   5) 控件**起始露着**（挂出来就是第一印象），之后才走 DSH 的"底部露头 / 移开收起"那一套；
 *   6) 可选 `fit='contain'`（图片那侧的"适应窗口"）：fit 模式改成按宽高都装得下算（`containZoom`），
 *      多量一个视口高、多一条上下留白。**默认 `'width'` 不变** —— 文档/办公档不传就是原行为。
 *   7) 两个**仅图片启用**的开关（缺省都关，文档 / 办公档行为逐值不变）：
 *      `alwaysShowControls`（底部缩放控件常驻，不再按露头/移开收起）与 `panOnDrag`
 *      （放大后按住鼠标左键拖拽平移；拖拽释放的 click / dblclick 只在滚动口自己的
 *      capture 上收口、不装 window 全局监听，卸载即无残留）。PDF 不装拖拽监听，
 *      文字选择不受影响。
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
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { ZoomControls, type ZoomControlsHandle } from './ZoomControls'
import {
  clampZoom,
  containZoom,
  fitWidthZoom,
  resolveZoom,
  DEFAULT_ZOOM_BOUNDS,
  type ZoomBounds,
  type ZoomFit,
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
/** 拖拽平移的起手阈值：小于它就当点击（双击回位仍然有效）。 */
const PAN_DRAG_THRESHOLD_PX = 3
/**
 * 拖拽释放后的 click 压制窗口：真实 click 紧跟 pointerup（同一 task），只给这么短的时间。
 * 一旦这次 click 被吞，它可能被浏览器算进双击次数；dblclick 在第二次 click 之后才来，
 * 所以双击压制窗口要覆盖一次完整双击，而不是 0ms。两者都只挂在滚动口自己的 capture 上。
 */
const DRAG_CLICK_SUPPRESS_MS = 250
const DRAG_DOUBLE_CLICK_SUPPRESS_MS = 600

/**
 * 只有**拖拽内容面**上的派生 click/dblclick 才收：图片面标了 `data-dsh-zoom-surface`，
 * 交互控件（按钮 / 链接 / 输入 / 菜单 / contenteditable）即使在滚动口内部也一律放行。
 * 缩放 ± 按钮本身是滚动口的兄弟（不在 port 内），这里再兜一层，避免以后布局变化误伤。
 */
function isDragContentTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (
    target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="menuitem"], [role="link"]'
    ) !== null
  ) {
    return false
  }
  return target.closest('[data-dsh-zoom-surface]') !== null
}

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
   * fit 模式的"原始宽"（适应宽度 / 适应窗口共用）就是它 —— 与倍率无关，所以不会自我循环。
   */
  readonly intrinsicWidth: number | undefined
  /** 内容原始高（`fit='contain'` 要它；不给就退回适应宽度，见 `containZoom`）。 */
  readonly intrinsicHeight?: number
  /** fit 模式下扣掉的左右留白（页列的内边距）。 */
  readonly horizontalInset?: number
  /** `fit='contain'` 时扣掉的上下留白。 */
  readonly verticalInset?: number
  /**
   * fit 模式的适应口径（缺省 `'width'` = 文档/办公档现状，**行为不变**）：
   * `'contain'` = 宽高都装得下（图片的"适应窗口"，只缩不放）。
   */
  readonly fit?: ZoomFit
  /** fit（适应宽度 / 适应窗口）是否允许放大（默认 true；false = DSH 的只缩不放，见文件头注）。 */
  readonly fitWidthUpscale?: boolean
  /**
   * 缩放边界（缺省 = 文档阅读器那套 25%–400%/0.25 栅格，**行为与本次改造前逐值相同**）。
   * 图片那侧传 `IMAGE_ZOOM_BOUNDS`（10%–800%、一档 ×1.25、下限跟随当前适配倍率）。
   */
  readonly bounds?: ZoomBounds
  readonly labels: ZoomLabels
  /**
   * 底部缩放控件常驻（不按"露头 / 移开收起"隐藏）。缺省 false = 文档 / 办公档现状；
   * 图片阅读器传 true —— 用户要求可见的放大 / 缩小按钮。
   */
  readonly alwaysShowControls?: boolean
  /**
   * 放大后按住**鼠标左键**拖拽平移（滚动口内容超出可视区时才有意义）。缺省 false：
   * 不装任何监听，PDF 的文字选择不受影响。图片阅读器传 true。
   */
  readonly panOnDrag?: boolean
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
    intrinsicHeight,
    horizontalInset = 0,
    verticalInset = 0,
    labels,
    onPreference,
    onRenderZoom,
    scrollportRef
  } = props
  const fit = props.fit ?? 'width'
  const fitWidthUpscale = props.fitWidthUpscale ?? true
  const alwaysShowControls = props.alwaysShowControls ?? false
  const panOnDrag = props.panOnDrag ?? false
  const [viewportWidth, setViewportWidth] = useState(0)
  /** contain 的口径要吃视口高（`fit='width'` 那条路不读它，PDF / 办公档的更新行为不变）。 */
  const [viewportHeight, setViewportHeight] = useState(0)
  // 起始**露着**：控件要等第一页量到原始宽才挂出来，那一挂就是"缩放在这儿"的第一印象；
  // 之后鼠标一动就按露头/收起那套走（DSH 是进来就收着，全靠鼠标摸到右下角才发现）。
  // `alwaysShowControls` 时 `scheduleControlsHide` 直接不排收起，这个初始值就是常驻。
  const [controlsVisible, setControlsVisible] = useState(true)

  // 现算的 fit 倍率：contain 那侧宽高一起看（只缩不放），默认仍是"适应宽度"逐值不变
  const fitZoom =
    fit === 'contain'
      ? containZoom(
          viewportWidth,
          viewportHeight,
          intrinsicWidth,
          intrinsicHeight,
          horizontalInset,
          verticalInset,
          fitWidthUpscale
        )
      : fitWidthZoom(viewportWidth, intrinsicWidth, horizontalInset, fitWidthUpscale)
  const zoom = resolveZoom(
    props.preference,
    viewportWidth,
    intrinsicWidth,
    horizontalInset,
    fitWidthUpscale,
    fitZoom
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
  /** 拖拽平移的收尾函数（换手势 / 卸载时把 window 上的监听摘干净）。 */
  const panTeardown = useRef<(() => void) | null>(null)
  /** 拖拽释放后、到点之前到来的 click 要吞掉（组件内 ref，卸载即随组件消失）。 */
  const suppressClickUntil = useRef(0)
  /** 被吞掉的那次拖拽 click 可能参与一次 dblclick：把紧随其后的 dblclick 也收掉。 */
  const suppressDoubleClickUntil = useRef(0)

  useEffect(
    () => () => {
      panTeardown.current?.()
    },
    []
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
    if (
      alwaysShowControls ||
      pointerInRevealZone.current ||
      controlsActive.current ||
      pinchTimer.current !== undefined
    ) {
      return
    }
    controlsHideTimer.current = setTimeout(() => {
      controlsHideTimer.current = undefined
      setControlsVisible(false)
    }, CONTROLS_HIDE_DELAY_MS)
  }, [alwaysShowControls, clearControlsHide])

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

  /**
   * 拖拽释放产生的 click 只在本滚动口内吞掉（组件级 capture，不再挂 window 全局监听）：
   * 同一 tick 里落在旋转钮 / 工作台按钮上的点击不受影响；卸载后也不存在残留监听。
   * 普通双击没有拖拽前置，`suppressClickUntil` 为 0，照常走到 `onDoubleClick`。
   */
  const handlePanClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (!panOnDrag || !isDragContentTarget(event.target)) return
      const now = performance.now()
      if (suppressClickUntil.current === 0 || now > suppressClickUntil.current) return
      suppressClickUntil.current = 0
      // 这次 click 会被浏览器计入双击次数：紧随其后的 dblclick 也要收掉，别切回适应窗口。
      suppressDoubleClickUntil.current = now + DRAG_DOUBLE_CLICK_SUPPRESS_MS
      event.preventDefault()
      event.stopPropagation()
    },
    [panOnDrag]
  )

  const handlePanDoubleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (!panOnDrag || !isDragContentTarget(event.target)) return
      const now = performance.now()
      if (suppressDoubleClickUntil.current === 0 || now > suppressDoubleClickUntil.current) return
      suppressDoubleClickUntil.current = 0
      event.preventDefault()
      event.stopPropagation()
    },
    [panOnDrag]
  )

  /**
   * 放大后按住鼠标左键拖拽平移（图片 opt-in；PDF 不传 `panOnDrag`，选文手势不受影响）。
   * 只在内容真的超出视口时接管；小于阈值按下算点击，双击"适应窗口 ↔ 100%"仍然成立。
   * 监听挂在 window 上：拖到滚动口外面也不会断，收尾一律摘干净。
   */
  const handlePanPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (!panOnDrag) return
      const node = scrollport.current
      if (node === null) return
      // 只认鼠标左键：触屏 / 触控笔留给原生滚动与捏合；滚动条上的按下也不接管。
      if (event.button !== 0 || event.pointerType !== 'mouse') return
      if (event.target === node) return
      const canPanX = node.scrollWidth > node.clientWidth + 1
      const canPanY = node.scrollHeight > node.clientHeight + 1
      if (!canPanX && !canPanY) return

      panTeardown.current?.()
      suppressClickUntil.current = 0
      suppressDoubleClickUntil.current = 0
      const { pointerId, clientX: startX, clientY: startY } = event
      let lastX = startX
      let lastY = startY
      let moved = false
      let teardown = (): void => undefined

      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return
        // pointerup 丢了（例如在窗口外释放且没触发 blur）：buttons=0 的 move 就是收尾信号。
        if (moveEvent.buttons === 0) {
          teardown()
          return
        }
        if (!moved) {
          if (
            Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) <
            PAN_DRAG_THRESHOLD_PX
          ) {
            return
          }
          moved = true
          node.dataset.dshPanning = ''
        }
        if (moveEvent.cancelable) moveEvent.preventDefault()
        // 增量平移：拖拽期间滚轮/触控板改过的滚动位置不会被"按下时快照"覆盖。
        const deltaX = moveEvent.clientX - lastX
        const deltaY = moveEvent.clientY - lastY
        if (canPanX) node.scrollLeft -= deltaX
        if (canPanY) node.scrollTop -= deltaY
        lastX = moveEvent.clientX
        lastY = moveEvent.clientY
      }

      const finish = (finishEvent: PointerEvent): void => {
        if (finishEvent.pointerId !== pointerId) return
        teardown()
        if (!moved) return
        // 拖完这一下不是点击：组件内的 click capture 会在紧跟的窗口里把它收掉；
        // 同时压住可能由这次 click 参与的双击（dblclick 比 click 晚到）。
        const now = performance.now()
        suppressClickUntil.current = now + DRAG_CLICK_SUPPRESS_MS
        suppressDoubleClickUntil.current = now + DRAG_DOUBLE_CLICK_SUPPRESS_MS
      }

      /** 手势被取消（pointercancel / 窗口失焦）：只收尾，不吞后续点击。 */
      const cancel = (): void => {
        teardown()
      }

      teardown = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('blur', cancel)
        delete node.dataset.dshPanning
        if (panTeardown.current === teardown) panTeardown.current = null
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('blur', cancel)
      panTeardown.current = teardown
    },
    [panOnDrag]
  )

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

  /** 量滚动口（面板缩放 / 侧栏开合 / 全屏都走这一条）：宽总是要的；高只有 contain 口径读。 */
  useLayoutEffect(() => {
    const node = scrollport.current
    if (node === null) return
    const measure = (): void => {
      setViewportWidth(node.clientWidth)
      if (fit === 'contain') setViewportHeight(node.clientHeight)
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [fit])

  /**
   * 偏好/尺寸落定后回写 CSS 变量、控件数字与实际倍率（捏合期间让位给 showZoom）。
   * 用 layout effect：非手势的 fit 变化（加载 / 面板缩放）在 paint 前落盘，不闪一帧；
   * 手势中则直接 return，绝不覆盖 showZoom 写在 CSS 变量上的手势值。
   */
  useLayoutEffect(() => {
    if (pinchTimer.current !== undefined) return
    zoomRef.current = zoom
    frame.current?.setAttribute('data-dsh-zoom-mode', props.preference.kind)
    frame.current?.style.setProperty('--dsh-zoom', String(zoom))
    controls.current?.showZoom(zoom)
  }, [props.preference.kind, zoom])

  /** 页面重绘走 passive 阶段：PDF 的位图仍等 paint 后再按新倍率画（与改造前同一条时序）。 */
  useEffect(() => {
    if (pinchTimer.current !== undefined) return
    onRenderZoom?.(zoom)
  }, [onRenderZoom, props.preference.kind, zoom])

  /** Ctrl + 滚轮缩放（非被动监听：Electron 默认会让 Ctrl+滚轮缩放整个界面，这里拦下来）。 */
  useEffect(() => {
    const node = scrollport.current
    if (node === null) return
    const clearPendingPinch = (): void => {
      clearTimeout(pinchTimer.current)
      pinchTimer.current = undefined
      clearControlsHide()
    }
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
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
    return () => {
      node.removeEventListener('wheel', wheel)
      clearPendingPinch()
    }
  }, [clearControlsHide, onPreference, scheduleControlsHide, showControls, showZoom])

  return (
    <div
      ref={attachFrame}
      className="dsh-zoom-frame"
      data-testid="dsh-zoom-frame"
      data-dsh-zoom-frame
      data-dsh-zoom-mode={props.preference.kind}
      data-dsh-zoom-fit={fit}
      style={
        {
          // 注意：`--dsh-zoom` 不在 React style 里 —— 它由 attachFrame / 落定 effect / 手势
          // 命令式写入。手势中的一次 ResizeObserver 渲染若由 React 写回 fit 值，会把刚放大的
          // 面缩回去；这里把写入权只留给"非手势"路径。
          '--dsh-zoom-reveal-height': `${CONTROLS_REVEAL_HEIGHT_PX}px`
        } as CSSProperties
      }
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <div
        ref={attachScrollport}
        className="dsh-zoom-scrollport"
        data-dsh-zoom-scrollport
        data-dsh-pan-enabled={panOnDrag ? '' : undefined}
        onPointerDown={panOnDrag ? handlePanPointerDown : undefined}
        onClickCapture={panOnDrag ? handlePanClickCapture : undefined}
        onDoubleClickCapture={panOnDrag ? handlePanDoubleClickCapture : undefined}
      >
        {props.children}
      </div>
      <div className="dsh-zoom-reveal-zone" data-dsh-zoom-reveal-zone aria-hidden="true" />
      {intrinsicWidth !== undefined ? (
        <ZoomControls
          ref={controls}
          zoom={zoom}
          fitWidth={props.preference.kind === 'fit-width'}
          labels={labels}
          visible={controlsVisible || alwaysShowControls}
          bounds={effectiveBounds}
          onZoom={setZoom}
          onFitWidth={goFitWidth}
          onActiveChange={handleControlsActive}
        />
      ) : null}
    </div>
  )
}
