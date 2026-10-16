/**
 * DSH 图片阅读器（SVG / ICO 在内的七种图片格式 + 统一缩放）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/image/ImageBody.tsx`，并接了本仓既有的
 * 图片阅读能力。四类改动（口径差异都写在这里，不在别处重述）：
 *
 * 1) **缩放走统一视口**：上游图片与 PDF 共用同一个 `ZoomViewport`（适应宽度 + 百分比档位菜单 +
 *    加减一档 + Ctrl/捏合手势），这里直接复用本仓已移植的 `dsh-document/ZoomViewport`（同一份，
 *    不复制）—— 这就是"统一缩放"的落点。**但能力不缩水**：图片这一侧传自己的
 *    `IMAGE_ZOOM_BOUNDS`（**10%–800%**、一档 **×1.25**、下限跟随适应宽度），
 *    与 round 52 的既有口径逐值相同；文档阅读器不传边界，仍是 25%–400% / 0.25 栅格，不受影响。
 *    旋转按钮保留（见 3），双击适应宽度 ↔ 100% 也保留。
 * 2) **data URL 而非 Blob URL**：本仓 CSP 是 `img-src 'self' data:`（不放行 blob:），
 *    SVG 字节同样只经 `<img>` 的静态图上下文进入渲染，不进 DOM、不进 iframe；
 *    代价是 base64 膨胀约 33%（预览上限 30MB，见 `PREVIEW_IMAGE_MAX_BYTES`）。
 * 3) **保留 round 52 的旋转**：DSH 没有旋转，本仓有（用户可见功能，不砍）。旋转不改倍率语义：
 *    外框按**旋转后的外接框**给（90°/270° 宽高对调），所以"适应宽度"与滚动范围都按眼睛看到的
 *    那个方向算。双击 = 适应宽度 ↔ 100%（看图软件惯例，同样是本仓既有口径）。
 * 4) **没有内在尺寸的 SVG 不判坏图**：SVG 只给 viewBox、不给 width/height 时浏览器报 0×0，
 *    上游不处理（它的 `<img>` 走 fit-width 也可能量不到宽）；这里降级成"原始尺寸铺开、
 *    不给缩放控件"，不把能看的图说成坏的。
 *
 * 安全口径（与既有实现、与上游一致）：字节只走 data URL → `<img>`；
 * **SVG 标记永远不进应用 DOM**，因此 SVG 里的脚本不可能执行、也拿不到父页面。
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { RotateCcw, RotateCw } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { ZoomViewport } from '../dsh-document/ZoomViewport'
import {
  DEFAULT_ZOOM_LABELS,
  FIT_WIDTH,
  IMAGE_ZOOM_BOUNDS,
  type ZoomPreference
} from '../dsh-document/zoom'
import { IMAGE_MEDIA_TYPES, toDataUrl, type DshImageFormat } from './formats'
import './dsh-media.css'

/** 适应宽度时四周留的呼吸位（与 dsh-document 的页列同档：左右各 12px）。 */
const VIEW_GUTTER = 24

interface Size {
  readonly w: number
  readonly h: number
}

/** 解码生命周期；`unsized` = 图能显示但报不出内在尺寸（典型是只有 viewBox 的 SVG）。 */
type ImagePhase = 'loading' | 'ready' | 'unsized' | 'failed'

/**
 * 一张图片：data URL + 统一缩放视口（+ 旋转、双击回位）。
 * @param props `format` 是主进程认下来的字节格式，`bytes` 是原始字节（身份变化即换图）。
 * @returns 自带滚动口与浮动控件的图片阅读器。
 */
export function DshImageBody({
  format,
  bytes
}: {
  format: DshImageFormat
  bytes: Uint8Array
}): React.JSX.Element {
  const mediaType = IMAGE_MEDIA_TYPES[format]
  const [phase, setPhase] = useState<ImagePhase>('loading')
  /** 原始像素尺寸（未解码出来是 null：此时不画内容、也不给缩放控件） */
  const [natural, setNatural] = useState<Size | null>(null)
  const [rotation, setRotation] = useState(0)
  /** 缩放偏好（受控：状态住在阅读器里，换文件随组件重挂归位） */
  const [preference, setPreference] = useState<ZoomPreference>(FIT_WIDTH)

  // 30MB 图的 base64 只编一次（bytes 身份变化才重编）
  const url = useMemo(
    () => (mediaType === undefined ? null : toDataUrl(bytes, mediaType)),
    [bytes, mediaType]
  )
  const src = url ?? ''

  const onLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>): void => {
      const image = event.currentTarget
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        // SVG 只给 viewBox 时浏览器报 0×0：能显示就不算坏图，降级成原始尺寸铺开
        setPhase(format === 'image-svg' ? 'unsized' : 'failed')
        return
      }
      setNatural({ w: image.naturalWidth, h: image.naturalHeight })
      setPhase('ready')
    },
    [format]
  )

  const rotate = useCallback((delta: number): void => {
    setRotation((prev) => (prev + delta + 360) % 360)
  }, [])

  const toggleFit = useCallback((): void => {
    setPreference((prev) => (prev.kind === 'fit-width' ? { kind: 'fixed', scale: 1 } : FIT_WIDTH))
  }, [])

  if (mediaType === undefined) {
    return (
      <div className="dsh-media-root" data-testid="file-preview-image" data-loaded="false">
        <p data-testid="file-preview-image-error" className="dsh-media-status">
          这份文件不是图片（{format}），画不了
        </p>
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div
        className="dsh-media-root"
        data-testid="file-preview-image"
        data-loaded="false"
        data-format={format}
      >
        <p data-testid="file-preview-image-error" className="dsh-media-status">
          这张图片打不开（文件可能损坏）
        </p>
      </div>
    )
  }

  const loaded = phase === 'ready' || phase === 'unsized'
  const sideways = rotation % 180 !== 0
  /** 旋转后的外接框（90°/270° 宽高对调）——缩放与滚动都按它算 */
  const footprint = natural === null ? null : sideways ? { w: natural.h, h: natural.w } : natural
  const zoomWidth = footprint?.w ?? 0
  const zoomHeight = footprint?.h ?? 0
  // 图片元素按"原始尺寸相对外接框"的百分比铺：旋转不改它的布局框，转的是 transform
  const imageStyle: CSSProperties | undefined =
    natural === null
      ? undefined
      : {
          width: `${(natural.w / zoomWidth) * 100}%`,
          height: `${(natural.h / zoomHeight) * 100}%`,
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`
        }

  return (
    <div
      className="dsh-media-root"
      data-testid="file-preview-image"
      data-loaded={loaded ? 'true' : 'false'}
      data-format={format}
      data-rotation={String(rotation)}
    >
      {phase === 'unsized' ? (
        // 量不出内在尺寸：原始尺寸铺开（不估倍率、也不给缩放控件），但图照样看得到
        <div className="dsh-media-frame dsh-media-frame-native">
          <img className="dsh-media-image-native" src={src} alt="" decoding="async" />
        </div>
      ) : (
        <ZoomViewport
          preference={preference}
          intrinsicWidth={footprint?.w}
          horizontalInset={VIEW_GUTTER}
          // 上游图片口径：适应宽度**只缩不放**（比面板小的图保持 100%，别把图标糊成一片）
          fitWidthUpscale={false}
          // 图片的既有能力：10%–800%、一档 ×1.25、下限跟随适应宽度（文档阅读器不传，口径互不影响）
          bounds={IMAGE_ZOOM_BOUNDS}
          labels={DEFAULT_ZOOM_LABELS}
          onPreference={setPreference}
        >
          <div className="dsh-media-frame">
            {phase === 'loading' ? (
              <div className="dsh-media-status" data-testid="image-loading">
                <Spinner label="加载中" className="text-ink-tertiary" />
              </div>
            ) : null}
            <div
              className="dsh-zoom-surface dsh-media-surface"
              data-dsh-zoom-surface
              data-testid="image-frame"
              hidden={phase !== 'ready'}
              style={
                {
                  '--dsh-zoom-width': `${zoomWidth}px`,
                  aspectRatio: `${zoomWidth} / ${zoomHeight}`
                } as CSSProperties
              }
            >
              <img
                className="dsh-media-image"
                src={src}
                alt=""
                draggable={false}
                decoding="async"
                style={imageStyle}
                onLoad={onLoad}
                onError={() => setPhase('failed')}
                onDoubleClick={toggleFit}
              />
            </div>
          </div>
        </ZoomViewport>
      )}

      {/* 旋转是本仓保留的能力（上游没有）：浮层摆在右上角，不跟底部的缩放控件抢位置 */}
      {phase === 'ready' ? (
        <div className="dsh-media-actions" data-testid="image-toolbar">
          <Tooltip label="逆时针旋转">
            <IconButton
              data-testid="image-rotate-left"
              label="逆时针旋转"
              icon={<RotateCcw />}
              className="dsh-media-action"
              onClick={() => rotate(-90)}
            />
          </Tooltip>
          <Tooltip label="顺时针旋转">
            <IconButton
              data-testid="image-rotate-right"
              label="顺时针旋转"
              icon={<RotateCw />}
              className="dsh-media-action"
              onClick={() => rotate(90)}
            />
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}
