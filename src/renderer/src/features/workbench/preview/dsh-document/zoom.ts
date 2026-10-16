/**
 * 缩放口径（纯函数 + 类型）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/zoom/types.ts`：保留它那套
 * "**适应宽度是一种模式**、不是某个档位"的口径 —— 视口变宽时适应宽度跟着走，固定倍率一直不动；
 * 上下限与档位表照抄（0.25–4，档位 0.25/0.5/1/1.5/2）并做成 **`ZoomBounds` 可配置**：
 * 文档阅读器不传就是原值（行为不变），图片阅读器传它自己那套（10%–800%、一档 ×1.25）。
 *
 * 一处与 DSH 不同的地方在 `fitWidthZoom` 的 `allowUpscale`：DSH 的适应宽度"只缩不放"
 * （页比视口窄时按原始大小显示），kyclaw 这边跟浏览器/阅读器的通行语义与既有 `PdfPreview` 对齐
 * —— 适应宽度就是**铺满可用宽**（含放大）。默认走后者，需要 DSH 那套口径时传 `false`。
 */

/** 自动适应宽度，或读者显式选定的固定倍率。 */
export type ZoomPreference =
  { readonly kind: 'fit-width' } | { readonly kind: 'fixed'; readonly scale: number }

/** 新打开一份文档时的默认偏好。 */
export const FIT_WIDTH: ZoomPreference = { kind: 'fit-width' }

/** 固定倍率的下限 / 上限（再往外就不是"读文档"了）。 */
export const MIN_FIXED_ZOOM = 0.25
export const MAX_FIXED_ZOOM = 4

/** 加减按钮走的栅格。 */
export const ZOOM_STEP = 0.25

/** 百分比菜单里的固定档位。 */
export const ZOOM_OPTIONS = [0.25, 0.5, 1, 1.5, 2] as const

/**
 * 一个宿主的缩放边界（可选传入；**缺省就是文档阅读器现状**，办公/PDF 那侧不传即可，行为不变）。
 *
 * 为什么要有这个：图片阅读器 round 52 那套能力是 **10%–800% + 一档 ×1.25**（用户可见能力，
 * 不缩水），而文档阅读器是 25%–400% + 0.25 加法栅格。统一视口之后两者共用同一套控件，
 * 边界由宿主声明 —— 谁都不改对方的默认。
 */
export interface ZoomBounds {
  /** 固定倍率下限 */
  readonly min: number
  /** 固定倍率上限 */
  readonly max: number
  /** 一档怎么走：数字 = 加法栅格（0.25 = 每档 ±25 个百分点）；`{ factor }` = 乘性（图片的 ×1.25） */
  readonly step: number | { readonly factor: number }
  /** 百分比菜单里的固定档位 */
  readonly options: readonly number[]
  /**
   * 下限是否跟随"适应宽度"再降一档：连 `min` 都装不下的大图以 fit 为下限，
   * 免得"点缩小反而变大"（图片口径）。缺省 `false` = 文档阅读器口径（恒为 `min`）。
   */
  readonly fitFloor?: boolean
}

/** 文档阅读器（PDF / 办公档）的边界：与本次改造前逐值相同。 */
export const DEFAULT_ZOOM_BOUNDS: ZoomBounds = {
  min: MIN_FIXED_ZOOM,
  max: MAX_FIXED_ZOOM,
  step: ZOOM_STEP,
  options: ZOOM_OPTIONS
}

/** 图片阅读器的边界：round 52 的既有能力（10%–800%、一档 ×1.25、下限跟随适应宽度）。 */
export const IMAGE_ZOOM_BOUNDS: ZoomBounds = {
  min: 0.1,
  max: 8,
  step: { factor: 1.25 },
  options: [0.1, 0.25, 0.5, 1, 2, 4, 8],
  fitFloor: true
}

/** 控件与失败态的文案（宿主可以整份换掉；组件默认中文）。 */
export interface ZoomLabels {
  readonly controls: string
  readonly menu: string
  readonly out: string
  readonly into: string
  readonly fitWidth: string
  readonly value: (percent: number) => string
}

/** 默认（中文）文案。 */
export const DEFAULT_ZOOM_LABELS: ZoomLabels = {
  controls: '缩放',
  menu: '选择缩放比例',
  out: '缩小',
  into: '放大',
  fitWidth: '适应宽度',
  value: (percent) => `${Math.round(percent)}%`
}

/**
 * 夹到边界里（顺带收掉浮点尾巴：捏合出来的倍率会很长）。
 * @param zoom 目标倍率。
 * @param bounds 宿主边界（缺省 = 文档阅读器那套）。
 * @param floor 本次的下限覆盖（图片的"下限跟随适应宽度"走这里；缺省用 `bounds.min`）。
 */
export function clampZoom(
  zoom: number,
  bounds: ZoomBounds = DEFAULT_ZOOM_BOUNDS,
  floor?: number
): number {
  const min = floor ?? bounds.min
  return Math.round(Math.min(bounds.max, Math.max(min, zoom)) * 1000) / 1000
}

/**
 * 适应宽度：按"可用宽 ÷ 内容原始宽"算倍率。
 * @param viewportWidth 滚动口的可用宽（CSS 像素）。
 * @param intrinsicWidth 内容原始宽（第一页量到的）；未知时给 1（还不该缩放）。
 * @param horizontalInset 左右留白（页列的内边距），算可用宽时扣掉。
 * @param allowUpscale true = 铺满可用宽（含放大）；false = DSH 口径，只缩不放。
 */
export function fitWidthZoom(
  viewportWidth: number,
  intrinsicWidth: number | undefined,
  horizontalInset = 0,
  allowUpscale = true
): number {
  if (intrinsicWidth === undefined || intrinsicWidth <= 0) return 1
  // 量不到视口宽（面板收起 / 还没布局）：先按原始大小，等量到再收
  if (!(viewportWidth > 0)) return 1
  const zoom = Math.max(1, viewportWidth - horizontalInset) / intrinsicWidth
  return allowUpscale ? zoom : Math.min(1, zoom)
}

/**
 * 一档增减：按边界的格子向上/向下取一档（捏合出来的非栅格倍率也走得动）。
 * @param zoom 当前倍率。
 * @param direction `1` 放大 / `-1` 缩小。
 * @param bounds 宿主边界（缺省 = 文档阅读器那套：0.25 加法栅格）。
 * @param floor 本次的下限覆盖（图片的"下限跟随适应宽度"走这里）。
 */
export function stepZoom(
  zoom: number,
  direction: -1 | 1,
  bounds: ZoomBounds = DEFAULT_ZOOM_BOUNDS,
  floor?: number
): number {
  const step = bounds.step
  const next =
    typeof step === 'number'
      ? (direction === -1 ? Math.ceil(zoom / step) - 1 : Math.floor(zoom / step) + 1) * step
      : zoom * (direction === -1 ? 1 / step.factor : step.factor)
  return clampZoom(next, bounds, floor)
}

/** 偏好 → 实际倍率（适应宽度要现算，固定倍率取现值）。 */
export function resolveZoom(
  preference: ZoomPreference,
  viewportWidth: number,
  intrinsicWidth: number | undefined,
  horizontalInset = 0,
  allowUpscale = true
): number {
  return preference.kind === 'fit-width'
    ? fitWidthZoom(viewportWidth, intrinsicWidth, horizontalInset, allowUpscale)
    : preference.scale
}
