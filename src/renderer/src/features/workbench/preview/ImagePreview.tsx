/**
 * 图片预览（round 52：从"一张定高的 <img>"升级成看图器）：主进程回的原字节 → data URL → 可缩放 / 可旋转。
 *
 * 为什么是 data URL 而不是 `file://` 或 `blob:`：CSP 只放行 `img-src 'self' data:`，
 * 而仓库里"渲染端显示本地图片"本来就是 data URL 口径（composer 附件 / 消息 part / 插件图标同路数）。
 * 代价是 base64 膨胀约 33%（8MB 的图上限 = 约 10.7MB 字符串），换来的是不改 CSP、不留对象 URL 生命周期。
 *
 * 口径（对照 Kimi 的图片查看器）：
 *   - **百分比 = 相对原始像素的倍率**（100% = 一图一 CSS px），显示在工具条正中。初始态是"适应窗口"
 *     （`fit = min(1, 可用宽/原宽, 可用高/原高)`，contain 且**不放大**小图：图比容器小就是 100% 居中）；
 *     一按缩放钮 / Ctrl+滚轮就从"适应窗口"切到显式倍率，之后窗口再变也不跟着变（双击可回）。
 *   - **步进 ×1.25**（一档 +25%，10% ↔ 800% 之间约 18 步）：等比步进在两头都顺滑，不小图一大跳、大图磨洋工。
 *     夹取 [10%, 800%]；下限另取 `min(10%, fit)` —— 连 10% 都装不下的大图以 fit 为下限，免得"点缩小反而变大"。
 *   - **旋转 ±90°**，取模到 0/90/180/270（顺时针为正）：只记角度、不动缩放，所以百分比不因旋转变。
 *   - **变换顺序**：缩放走**布局尺寸**（img 的 width/height = 原始尺寸 × 倍率），旋转走 **transform**
 *     （`translate(-50%, -50%) rotate(θ)`：先摆到容器正中，再绕自身中心转 —— 两条各管一轴，互不叠乘，
 *     于是"倍率"这件事只由 width/height 表达，百分比不会因为转了 90° 就变个说法）。
 *     外框（frame）的布局尺寸 = 旋转后的**外接框**（90°/270° 时宽高对调、向上取整）：滚动条量到的正是
 *     图片真正占的地方，转到哪个方向都能滚着看全，且两轴都不被裁。
 *   - **居中 + 溢出**：stage 是滚动容器，里面套一层"取 max(内容, 容器)"的对中层，图片在这层里 flex 居中 ——
 *     图小于容器时两轴居中，大于容器时那层与图片同大、居中空转，于是**两轴都能滚到尽头**
 *     （`justify-content: center` 与 `margin: auto` 在溢出时都会把左/上缘甩出可滚范围，前者是行内偏心、
 *     后者是负边距，round 52 真机实测：175% 的图有 505px 宽度滚不回来）。工具条是**浮层**：
 *     绝对定位在滚动容器之外，滚图时它不动。
 *   - **Ctrl+滚轮**缩放（一格一步），普通滚轮不接管（照旧滚容器）。必须挂原生监听：React 的 `onWheel`
 *     是 passive 的，里面 `preventDefault()` 拦不掉 Chromium 自带的页面缩放与页面滚动。
 *     缩放**锚在光标下的那个点**（推导见 wheel 监听里那条注释）；转过的图只保证"布局框"锚得准，视觉点会有偏差。
 *   - **双击**：适应窗口 ↔ 100%（看图软件惯例）。
 *   - 右键不额外处理：Electron 不弹原生菜单，内联预览那侧由 BottomSheet 的包装层接管自绘菜单。
 */
import { RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileByteFormat } from '@shared/workbench'
import { cn } from '@renderer/components/ui/cn'
import { IconButton } from '@renderer/components/ui/icon-button'
import { IMAGE_MIME } from './modes'

/** 原字节 → data URL（分块拼二进制串：一次性 apply 大数组会爆栈） */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/** 一档倍率（×1.25 = 每步 +25%） */
const ZOOM_STEP = 1.25
/** 缩放夹取范围（10% – 800%） */
const ZOOM_MIN = 0.1
const ZOOM_MAX = 8
/** "适应窗口"时四周留的呼吸位（与旧实现的 p-3 同档观感） */
const VIEWER_GUTTER = 16

interface Size {
  w: number
  h: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 最近的**滚动容器**祖先（预览标签里是 PreviewTool 的滚动区；内联预览里是 BottomSheet 的内容区）。
 *
 * 它才是"这一屏能看到多高"的真源：舞台自己的高度在内联那侧是**内容撑的**（图多高它就多高，
 * 直到 BottomSheet 的 `max-h-[70%]` 把外层掐住）——照舞台自己算"适应窗口"等于永远不缩。
 */
function nearestScrollHost(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return parent
  }
  return null
}

export function ImagePreview({
  format,
  bytes
}: {
  format: FileByteFormat
  bytes: Uint8Array
}): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  /** 原始像素尺寸：`null` = 还没解码出来（此时图不画，也没有"适应窗口"可算） */
  const [natural, setNatural] = useState<Size | null>(null)
  /** 舞台可用尺寸（量不到就是 0 → 按 100%，见 fit） */
  const [box, setBox] = useState<Size>({ w: 0, h: 0 })
  /** 显式倍率；`null` = 跟随"适应窗口"（窗口一变就重算） */
  const [zoom, setZoom] = useState<number | null>(null)
  /** 旋转角：0 / 90 / 180 / 270（顺时针为正） */
  const [rotation, setRotation] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 滚轮锚定要落到的滚动位置（等这一帧的布局更新完，由 useLayoutEffect 落下去） */
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)

  const measure = useCallback((): void => {
    const stage = stageRef.current
    if (stage === null) return
    const host = nearestScrollHost(stage)
    const height =
      host === null ? stage.clientHeight : Math.min(stage.clientHeight, host.clientHeight)
    const width = stage.clientWidth
    setBox((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }))
  }, [])

  // 舞台（或它所在的滚动容器）一变形就重量一次 —— "适应窗口"跟着窗口走
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    measure()
    if (typeof ResizeObserver === 'undefined') {
      // jsdom 没有 ResizeObserver：留一条 resize 兜底（单测也靠它触发重量）
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const host = nearestScrollHost(stage)
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    if (host !== null) observer.observe(host)
    return () => observer.disconnect()
  }, [measure])

  const fit = useMemo((): number => {
    // 量不到布局（jsdom / 面板还没铺开）就按 100%：等真量到了再收
    if (natural === null || box.w <= 0 || box.h <= 0) return 1
    const width = Math.max(1, box.w - 2 * VIEWER_GUTTER)
    const height = Math.max(1, box.h - 2 * VIEWER_GUTTER)
    return Math.min(1, width / natural.w, height / natural.h)
  }, [natural, box])

  const scale = zoom ?? fit
  const zoomFloor = Math.min(ZOOM_MIN, fit)
  const limit = useCallback(
    (value: number): number => clamp(value, zoomFloor, ZOOM_MAX),
    [zoomFloor]
  )

  // Ctrl+滚轮：缩放。挂在原生监听上（React 的 onWheel 是 passive 的，preventDefault 不生效）。
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const onWheel = (event: WheelEvent): void => {
      // 手里没 Ctrl 就不接管：普通滚轮照旧滚这个容器（横向滚动同理）
      if (!event.ctrlKey || event.deltaY === 0) return
      event.preventDefault()
      const next = limit(scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
      if (next === scale) return

      /*
       * 光标锚定：让光标底下那个点在缩放前后停在屏幕同一处。
       * 设 k = 新倍率/旧倍率、X = 光标离滚动口左缘的距离、scrollLeft = 当前滚动位置：
       * 旧的内容点 p = scrollLeft + X，离内容中心 d = p − 内容宽/2；
       * 缩放后内容宽变 k 倍、中心不动 → d' = k·d → p' = k·(内容宽/2 + d)；
       * 要 X 处还是 p'，于是 scrollLeft' = p' − X = k·scrollLeft + (k−1)·X（内容宽那一项正好抵消）。
       * 纵轴同式。滚不动的方向设了也没用（浏览器自己夹到 0），所以不需要分情况。
       */
      const rect = stage.getBoundingClientRect()
      const k = next / scale
      pendingScroll.current = {
        left: k * stage.scrollLeft + (k - 1) * (event.clientX - rect.left),
        top: k * stage.scrollTop + (k - 1) * (event.clientY - rect.top)
      }
      setZoom(next)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [scale, limit])

  // 倍率变了、这一帧的布局已经更新完 → 把滚轮算好的滚动位置落下去（点缩放钮时这里是空转）
  useLayoutEffect(() => {
    const pending = pendingScroll.current
    pendingScroll.current = null
    const stage = stageRef.current
    if (stage === null || pending === null) return
    stage.scrollLeft = pending.left
    stage.scrollTop = pending.top
  }, [scale])

  const zoomBy = useCallback(
    (step: number): void => {
      setZoom(limit(scale * step))
    },
    [limit, scale]
  )

  const rotate = useCallback((delta: number): void => {
    setRotation((prev) => (prev + delta + 360) % 360)
  }, [])

  /** 双击：适应窗口 ↔ 100%（在适应窗口那一档再双击就锁到 100%，反之回适应窗口） */
  const toggleFit = useCallback((): void => {
    setZoom((prev) => (prev === null ? 1 : null))
  }, [])

  const onLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>): void => {
    const image = event.currentTarget
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      setBroken(true)
      return
    }
    setNatural({ w: image.naturalWidth, h: image.naturalHeight })
  }, [])

  if (broken) {
    return (
      <p data-testid="file-preview-image-error" className="px-3 py-2 text-b2 text-ink-secondary">
        这张图片打不开（文件可能损坏）
      </p>
    )
  }

  const loaded = natural !== null
  const percent = Math.round(scale * 100)
  const scaledW = (natural?.w ?? 0) * scale
  const scaledH = (natural?.h ?? 0) * scale
  // 90°/270° 时图片占的地盘是宽高对调的：外框照外接框给，滚动范围才和眼睛看到的一致
  const sideways = rotation % 180 !== 0
  const frameW = Math.ceil(sideways ? scaledH : scaledW)
  const frameH = Math.ceil(sideways ? scaledW : scaledH)

  return (
    <div
      data-testid="file-preview-image"
      data-loaded={loaded ? 'true' : 'false'}
      data-zoom={String(scale)}
      data-rotation={String(rotation)}
      className="relative flex h-full min-h-0 flex-col"
    >
      {/* 解码完之前不画也不给滚（图未定时外框是 0，硬画会闪一条巨大的滚动条）。
          最小高度给内联预览（BottomSheet 那块矮的）一个落点：那侧容器是内容撑的，
          不铺一条底线的话"适应窗口"会把图缩成火柴盒。45vh 是短窗下的收敛档。 */}
      <div
        ref={stageRef}
        data-testid="image-stage"
        className={cn(
          'min-h-[min(45vh,320px)] flex-1',
          loaded ? 'overflow-auto' : 'overflow-hidden'
        )}
      >
        {/*
          居中放在**这一层**：它取 max(内容, 容器) —— 内容比容器小就靠 flex 居中；
          内容更大时它跟着内容一起长大、尺寸与内容相等，居中变成空转，于是左/上缘永远滚得到。
          （直接在内容上用 `margin: auto` 是不行的：Chromium 对**溢出**的 flex 项照样按 auto 边距居中
          —— 负边距把左/上半截甩到可滚范围之外，滚不回来。round 52 真机实测：175% 的图有 505px
          宽度滚不到，且普通滚轮像被卡住。）
        */}
        <div className="flex h-max min-h-full w-max min-w-full items-center justify-center">
          <div
            data-testid="image-frame"
            className="relative"
            style={{ width: frameW, height: frameH }}
          >
            <img
              alt=""
              draggable={false}
              src={toDataUrl(bytes, IMAGE_MIME[format] ?? 'application/octet-stream')}
              onLoad={onLoad}
              onError={() => setBroken(true)}
              onDoubleClick={toggleFit}
              style={{
                left: '50%',
                top: '50%',
                width: scaledW,
                height: scaledH,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`
              }}
              className={cn(
                'absolute max-w-none transition-opacity duration-(--motion-fast) ease-main',
                loaded ? 'opacity-100' : 'opacity-0'
              )}
            />
          </div>
        </div>
      </div>

      {/* 工具条：浮层（不在滚动容器里，滚图时不动），底部居中。与参考图同构：
          [缩小] 百分比 [放大] ｜ [逆时针] [顺时针] —— 面板窄到放不下时折行，不撑破 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center px-2">
        <div
          data-testid="image-toolbar"
          className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-overlay border-(length:--hairline-width) border-hairline bg-surface px-1 py-0.5 shadow-(--shadow-overlay)"
        >
          <ToolIcon
            testId="image-zoom-out"
            label="缩小"
            icon={<ZoomOut />}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          />
          <span
            data-testid="image-zoom-value"
            className="min-w-10 shrink-0 text-center text-b2 text-ink-secondary tabular-nums"
          >
            {percent}%
          </span>
          <ToolIcon
            testId="image-zoom-in"
            label="放大"
            icon={<ZoomIn />}
            onClick={() => zoomBy(ZOOM_STEP)}
          />
          <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-hairline" />
          <ToolIcon
            testId="image-rotate-left"
            label="逆时针旋转"
            icon={<RotateCcw />}
            onClick={() => rotate(-90)}
          />
          <ToolIcon
            testId="image-rotate-right"
            label="顺时针旋转"
            icon={<RotateCw />}
            onClick={() => rotate(90)}
          />
        </div>
      </div>
    </div>
  )
}

/** 工具条上的图标钮：全站口径（IconButton + 透明描边 + hover 填充 + --motion-fast，不硬切） */
function ToolIcon({
  testId,
  label,
  icon,
  onClick
}: {
  testId: string
  label: string
  icon: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <IconButton
      data-testid={testId}
      label={label}
      icon={icon}
      onClick={onClick}
      className="border-transparent transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
    />
  )
}
