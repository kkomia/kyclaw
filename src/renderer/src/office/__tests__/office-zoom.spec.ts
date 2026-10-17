import { describe, expect, it } from 'vitest'
import {
  OFFICE_MAX_ZOOM,
  OFFICE_MIN_ZOOM,
  OFFICE_PAGE_WIDTH,
  OFFICE_TARGET_PAGE_WIDTH,
  officeDefaultZoom
} from '../components/office-zoom'

/**
 * 用户 2026-10-17 第 3 条定调：默认 fit-width 缩放，1280 窗口下纸面视觉宽 ≈ 860（830–880），
 * 且不改文档字号/字体（zoom 是视图缩放，不是字号调整）。
 */
describe('office-zoom：默认 fit-width 缩放', () => {
  it('1280 窗口的 iframe 可用宽（≈1218）下纸面视觉宽落在 830–880', () => {
    const zoom = officeDefaultZoom(1218)
    expect(OFFICE_TARGET_PAGE_WIDTH / OFFICE_PAGE_WIDTH).toBeCloseTo(1.054, 3)
    expect(zoom).toBeCloseTo(1.054, 3)
    const visualWidth = OFFICE_PAGE_WIDTH * zoom
    expect(visualWidth).toBeGreaterThanOrEqual(830)
    expect(visualWidth).toBeLessThanOrEqual(880)
  })

  it('宽窗（1600/1538）保持首选档，不会把纸拉得更大', () => {
    expect(officeDefaultZoom(1538)).toBe(officeDefaultZoom(1218))
    expect(OFFICE_PAGE_WIDTH * officeDefaultZoom(1538)).toBeCloseTo(860, 0)
  })

  it('窄窗退化为 fit（两侧各留 12px 最小边距），不产生横向溢出', () => {
    const narrow = 860
    const zoom = officeDefaultZoom(narrow)
    expect(zoom).toBeLessThan(1.054)
    // zoom 保留 3 位小数会带来 ±0.5px 取整误差：只要总量仍小于可用宽即可
    expect(zoom * OFFICE_PAGE_WIDTH).toBeLessThanOrEqual(narrow - 20)
  })

  it('A4：A3 AI 面板展开后 1280 窗口 iframe ≈898，仍保持 860 目标档（≥830 验收线）', () => {
    // 48px 边距会在这里算出 ≈802（不达标）；12px 后仍是 preferred 档
    const zoom = officeDefaultZoom(898)
    expect(zoom).toBeCloseTo(1.054, 3)
    expect(OFFICE_PAGE_WIDTH * zoom).toBeGreaterThanOrEqual(830)
  })

  it('非法/极端输入被夹在 [0.5, 2]，且非有限值回退首选档', () => {
    expect(officeDefaultZoom(Number.NaN)).toBeCloseTo(1.054, 3)
    expect(officeDefaultZoom(0)).toBeCloseTo(1.054, 3)
    expect(officeDefaultZoom(-100)).toBeCloseTo(1.054, 3)
    expect(officeDefaultZoom(10)).toBe(OFFICE_MIN_ZOOM)
    expect(officeDefaultZoom(10_000)).toBeLessThanOrEqual(OFFICE_MAX_ZOOM)
    expect(officeDefaultZoom(10_000)).toBeCloseTo(1.054, 3)
  })
})
