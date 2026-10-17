import { describe, expect, it } from 'vitest'
import { relativeSessionTime } from '../session-time'

/**
 * 会话行相对时间（task-66）：阈值/文案与 `session-time.ts` 文件头逐条对齐；
 * now 固定注入，不受运行时刻影响。
 */
const NOW = new Date('2026-10-18T12:00:00+08:00')
const at = (iso: string, now: Date = NOW): string => relativeSessionTime(iso, now)

describe('relativeSessionTime', () => {
  it('1 分钟以内（含未来时间）→ 刚刚', () => {
    expect(at('2026-10-18T11:59:30+08:00')).toBe('刚刚')
    expect(at('2026-10-18T12:00:00+08:00')).toBe('刚刚')
    // 未来时间（设备时钟偏差）也按「刚刚」，不显示负数
    expect(at('2026-10-18T12:05:00+08:00')).toBe('刚刚')
  })

  it('1 分钟–1 小时 → N 分钟', () => {
    expect(at('2026-10-18T11:59:00+08:00')).toBe('1 分钟')
    expect(at('2026-10-18T11:37:00+08:00')).toBe('23 分钟')
    expect(at('2026-10-18T11:01:00+08:00')).toBe('59 分钟')
  })

  it('同一日历日内 → N 小时（不足 24h 但跨日按日历日判）', () => {
    expect(at('2026-10-18T09:00:00+08:00')).toBe('3 小时')
    expect(at('2026-10-18T00:12:00+08:00')).toBe('11 小时')
    // 凌晨看前一晚 23:50：不算昨天（同一天 0 点前的会话已属于「昨天」）
    expect(
      relativeSessionTime('2026-10-17T23:50:00+08:00', new Date('2026-10-18T00:10:00+08:00'))
    ).toBe('20 分钟')
  })

  it('日历日差 1 → 昨天', () => {
    expect(at('2026-10-17T23:00:00+08:00')).toBe('昨天')
    expect(at('2026-10-17T00:00:00+08:00')).toBe('昨天')
  })

  it('2–6 个日历日 → N 天', () => {
    expect(at('2026-10-16T12:00:00+08:00')).toBe('2 天')
    expect(at('2026-10-12T12:00:00+08:00')).toBe('6 天')
  })

  it('≥7 个日历日 → M 月 D 日（跨年不显示年份）', () => {
    expect(at('2026-10-11T12:00:00+08:00')).toBe('10 月 11 日')
    expect(at('2026-09-01T09:00:00+08:00')).toBe('9 月 1 日')
    expect(at('2025-12-31T23:00:00+08:00')).toBe('12 月 31 日')
  })

  it('坏 ISO / 空串 → 空串（调用方不渲染时间）', () => {
    expect(at('')).toBe('')
    expect(at('not-a-date')).toBe('')
  })
})
