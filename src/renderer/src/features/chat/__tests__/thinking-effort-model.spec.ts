import { describe, expect, it } from 'vitest'
import type { ThinkingEffortSpec } from '@shared/models'
import {
  EFFORT_APEX_PERCENT,
  EFFORT_FASTER_TEXT,
  EFFORT_LABEL_TEXT,
  EFFORT_LABELS_EN,
  EFFORT_SMARTER_TEXT,
  EFFORT_TICK_PERCENTS,
  effortDisplayLabel,
  effortForPercent,
  effortMatrixCellStyle,
  effortMatrixLayout,
  effortMatrixOpacity,
  isApexPercent,
  percentForEffort
} from '../thinking-effort-model'

const EFFORTS: ThinkingEffortSpec[] = [
  { id: 'default', label: '默认' },
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' }
]

describe('思考强度百分比 ↔ 档位', () => {
  it('档位 → 百分比：四档 0 / 33 / 67 / 100', () => {
    expect(percentForEffort(EFFORTS, 'default')).toBe(0)
    expect(percentForEffort(EFFORTS, 'low')).toBe(33)
    expect(percentForEffort(EFFORTS, 'high')).toBe(67)
    expect(percentForEffort(EFFORTS, 'max')).toBe(100)
    expect(percentForEffort(EFFORTS, 'unknown')).toBe(0)
  })

  it('百分比 → 档位（均分桶，边界按截图口径）', () => {
    expect(effortForPercent(EFFORTS, 0)?.id).toBe('default')
    expect(effortForPercent(EFFORTS, 24)?.id).toBe('default')
    expect(effortForPercent(EFFORTS, 25)?.id).toBe('low')
    expect(effortForPercent(EFFORTS, 49)?.id).toBe('low')
    expect(effortForPercent(EFFORTS, 50)?.id).toBe('high')
    expect(effortForPercent(EFFORTS, 74)?.id).toBe('high')
    expect(effortForPercent(EFFORTS, 75)?.id).toBe('max')
    expect(effortForPercent(EFFORTS, 100)?.id).toBe('max')
    // 超界/坏值钳制
    expect(effortForPercent(EFFORTS, -20)?.id).toBe('default')
    expect(effortForPercent(EFFORTS, 380)?.id).toBe('max')
    expect(effortForPercent(EFFORTS, Number.NaN)?.id).toBe('default')
  })

  it('单档 / 空表：不炸', () => {
    const single = [{ id: 'default', label: '默认' }]
    expect(percentForEffort(single, 'default')).toBe(100)
    expect(effortForPercent(single, 0)?.id).toBe('default')
    expect(effortForPercent([], 50)).toBeNull()
    expect(percentForEffort([], 'x')).toBe(0)
  })
})

describe('档位英文文案（用户：推理强度显示英文）', () => {
  it('默认/低/高/最高映射到 Default/Low/High/Max（源码用 provider 英文 name，兜底 Default）', () => {
    expect(effortDisplayLabel('default')).toBe('Default')
    expect(effortDisplayLabel('low')).toBe('Low')
    expect(effortDisplayLabel('high')).toBe('High')
    expect(effortDisplayLabel('max')).toBe('Max')
    expect(effortDisplayLabel(undefined)).toBe('Default')
    expect(effortDisplayLabel(null)).toBe('Default')
    expect(effortDisplayLabel('')).toBe('Default')
    // 未知 id 首字母大写（不透出中文）
    expect(effortDisplayLabel('medium')).toBe('Medium')
    expect(effortDisplayLabel('xhigh')).toBe('XHigh')
    expect(EFFORT_LABELS_EN['max']).toBe('Max')
  })

  it('面板文案集中常量：标题/两端中文（task-87），档位名仍英文', () => {
    expect(EFFORT_LABEL_TEXT).toBe('推理等级')
    expect(EFFORT_FASTER_TEXT).toBe('更快')
    expect(EFFORT_SMARTER_TEXT).toBe('更强')
  })
})

describe('apex 元素格（照抄 dsh-claude-style 的 matrix 算法）', () => {
  it('进度边界：75% 起进入 apex（Max 档）', () => {
    expect(EFFORT_APEX_PERCENT).toBe(75)
    expect(isApexPercent(0)).toBe(false)
    expect(isApexPercent(74)).toBe(false)
    expect(isApexPercent(75)).toBe(true)
    expect(isApexPercent(100)).toBe(true)
  })

  it('刻度位置：四档均分边界 0/25/50/75/100', () => {
    expect(EFFORT_TICK_PERCENTS).toEqual([0, 25, 50, 75, 100])
  })

  it('矩阵布局：5 行；26 高 → 格子 4px + 1px gap；列数随宽度增长', () => {
    const narrow = effortMatrixLayout(264)
    expect(narrow.rows).toBe(5)
    expect(narrow.sq).toBe(4)
    expect(narrow.gap).toBe(1)
    expect(narrow.cols).toBeGreaterThan(20)
    const wide = effortMatrixLayout(320)
    expect(wide.cols).toBeGreaterThan(narrow.cols)
  })

  it('列方向强度曲线：左淡 → 右满（0.05 前 0，0.75 后 1）', () => {
    expect(effortMatrixOpacity(0)).toBe(0)
    expect(effortMatrixOpacity(1)).toBe(1)
    expect(effortMatrixOpacity(0.4)).toBeGreaterThan(0)
    expect(effortMatrixOpacity(0.4)).toBeLessThan(1)
  })

  it('元素格动画参数确定（同输入同输出；tone 0–7、延迟/时长为正）', () => {
    const first = effortMatrixCellStyle(2, 7, 40)
    const second = effortMatrixCellStyle(2, 7, 40)
    expect(first).toEqual(second)
    expect(first.tone).toBeGreaterThanOrEqual(0)
    expect(first.tone).toBeLessThan(8)
    expect(Number.parseFloat(first.animationDelay)).toBeGreaterThan(0)
    expect(Number.parseFloat(first.animationDuration)).toBeGreaterThan(1)
    expect(effortMatrixCellStyle(0, 39, 40).opacity).toBe(1)
  })
})
