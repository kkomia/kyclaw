import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  DEFAULT_ZOOM_BOUNDS,
  FIT_WIDTH,
  fitWidthZoom,
  IMAGE_ZOOM_BOUNDS,
  MAX_FIXED_ZOOM,
  MIN_FIXED_ZOOM,
  resolveZoom,
  stepZoom,
  ZOOM_OPTIONS,
  ZOOM_STEP
} from '../zoom'

describe('fitWidthZoom：适应宽度', () => {
  it('页比视口宽：按可用宽缩（扣掉左右留白）', () => {
    // 视口 424、留白 24 → 可用 400；原始宽 800 → 0.5
    expect(fitWidthZoom(424, 800, 24)).toBe(0.5)
  })

  it('默认铺满可用宽（含放大）：宽视口把页面拉到全宽', () => {
    expect(fitWidthZoom(1224, 800, 24)).toBe(1.5)
  })

  it('allowUpscale=false 就是 DSH 口径：只缩不放', () => {
    expect(fitWidthZoom(1224, 800, 24, false)).toBe(1)
    expect(fitWidthZoom(424, 800, 24, false)).toBe(0.5)
  })

  it('量不到原始宽 / 视口宽时按原始大小（1）：不硬缩、也不猜', () => {
    expect(fitWidthZoom(424, undefined, 24)).toBe(1)
    expect(fitWidthZoom(424, 0, 24)).toBe(1)
    expect(fitWidthZoom(0, 800, 24)).toBe(1)
  })
})

describe('stepZoom / clampZoom：档位', () => {
  it('按 0.25 的栅格上下走一档', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(1.25, -1)).toBe(1)
    expect(ZOOM_STEP).toBe(0.25)
  })

  it('捏合出来的非栅格倍率也走得动（往上取下一档 / 往下取上一档）', () => {
    expect(stepZoom(1.003, 1)).toBe(1.25)
    expect(stepZoom(1.003, -1)).toBe(1)
    // 比下限还小的时候"缩小"落在下限上（按钮在这个状态本来就是禁用的）
    expect(stepZoom(0.18, 1)).toBe(MIN_FIXED_ZOOM)
    expect(stepZoom(0.18, -1)).toBe(MIN_FIXED_ZOOM)
  })

  it('两端站住，不越界', () => {
    expect(stepZoom(MAX_FIXED_ZOOM, 1)).toBe(MAX_FIXED_ZOOM)
    expect(stepZoom(MIN_FIXED_ZOOM, -1)).toBe(MIN_FIXED_ZOOM)
    expect(clampZoom(9)).toBe(MAX_FIXED_ZOOM)
    expect(clampZoom(0.01)).toBe(MIN_FIXED_ZOOM)
    expect(clampZoom(1.2345678)).toBe(1.235)
  })

  it('菜单档位都在固定倍率的区间里', () => {
    for (const option of ZOOM_OPTIONS) {
      expect(option).toBeGreaterThanOrEqual(MIN_FIXED_ZOOM)
      expect(option).toBeLessThanOrEqual(MAX_FIXED_ZOOM)
    }
  })
})

describe('resolveZoom：偏好 → 倍率', () => {
  it('适应宽度现算（跟着视口走），固定倍率取现值', () => {
    expect(resolveZoom(FIT_WIDTH, 424, 800, 24)).toBe(0.5)
    expect(resolveZoom({ kind: 'fixed', scale: 2 }, 424, 800, 24)).toBe(2)
    expect(resolveZoom(FIT_WIDTH, 1224, 800, 24, false)).toBe(1)
  })
})

/* ── ZoomBounds：宿主可配边界（图片那套 10%–800% / ×1.25；不传就是上面那套文档口径） ── */

describe('ZoomBounds：边界可配，默认不动', () => {
  it('默认边界逐值等于原常量（文档/办公档的行为不变）', () => {
    expect(DEFAULT_ZOOM_BOUNDS).toEqual({
      min: MIN_FIXED_ZOOM,
      max: MAX_FIXED_ZOOM,
      step: ZOOM_STEP,
      options: ZOOM_OPTIONS
    })
    // 不传边界的调用与历史行为逐值一致
    expect(stepZoom(1, 1)).toBe(stepZoom(1, 1, DEFAULT_ZOOM_BOUNDS))
    expect(clampZoom(9)).toBe(clampZoom(9, DEFAULT_ZOOM_BOUNDS))
  })

  it('图片边界：一档 ×1.25（乘性，不是 0.25 栅格）', () => {
    expect(stepZoom(1, 1, IMAGE_ZOOM_BOUNDS)).toBe(1.25)
    expect(stepZoom(1, -1, IMAGE_ZOOM_BOUNDS)).toBe(0.8)
    expect(stepZoom(0.5, 1, IMAGE_ZOOM_BOUNDS)).toBe(0.625)
    // 放大到超出上限：夹到 800%（而不是 4）
    expect(stepZoom(7, 1, IMAGE_ZOOM_BOUNDS)).toBe(IMAGE_ZOOM_BOUNDS.max)
    expect(stepZoom(0.1, -1, IMAGE_ZOOM_BOUNDS)).toBe(0.1)
  })

  it('图片边界：10%–800%，且"下限跟随适应宽度"由调用方用 floor 覆盖', () => {
    expect(clampZoom(9, IMAGE_ZOOM_BOUNDS)).toBe(8)
    expect(clampZoom(0.01, IMAGE_ZOOM_BOUNDS)).toBe(0.1)
    // fitFloor 的实际用法：视口量出来的 fit 比 min 还小 → 以 fit 为下限（点缩小不会反而放大）
    expect(clampZoom(0.02, IMAGE_ZOOM_BOUNDS, 0.02)).toBe(0.02)
    expect(stepZoom(0.02, 1, IMAGE_ZOOM_BOUNDS, 0.02)).toBe(0.025)
  })

  it('图片边界的菜单档位都在区间里', () => {
    for (const option of IMAGE_ZOOM_BOUNDS.options) {
      expect(option).toBeGreaterThanOrEqual(IMAGE_ZOOM_BOUNDS.min)
      expect(option).toBeLessThanOrEqual(IMAGE_ZOOM_BOUNDS.max)
    }
  })
})
