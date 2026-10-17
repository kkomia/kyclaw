import { describe, expect, it } from 'vitest'
import { relativeNewTabTime } from '../newtab-time'

/**
 * task-80：新增标签页「继续」栏相对时间（DESIGN §9.2）。
 * 语义：`lastActiveAt` = 文档标签上次被激活；文案到「月 日」为止，不跨年补年份。
 */
const NOW = new Date('2026-10-18T12:00:00+08:00')
const at = (ms: number): string => relativeNewTabTime(ms, NOW)
const ago = (ms: number): number => NOW.getTime() - ms

describe('relativeNewTabTime', () => {
  it('不到 1 分钟 → 刚刚（未来时间也归刚刚）', () => {
    expect(at(ago(30_000))).toBe('刚刚')
    expect(at(NOW.getTime())).toBe('刚刚')
    expect(at(NOW.getTime() + 60_000)).toBe('刚刚')
  })

  it('1 分钟–1 小时 → N 分钟前', () => {
    expect(at(ago(60_000))).toBe('1 分钟前')
    expect(at(ago(23 * 60_000))).toBe('23 分钟前')
    expect(at(ago(59 * 60_000))).toBe('59 分钟前')
  })

  it('同一日历日 → N 小时前；跨日不足 24h 仍按日历日落到昨天', () => {
    expect(at(ago(3 * 60 * 60_000))).toBe('3 小时前')
    expect(
      relativeNewTabTime(
        new Date('2026-10-17T23:50:00+08:00').getTime(),
        new Date('2026-10-18T00:10:00+08:00')
      )
    ).toBe('20 分钟前')
    expect(at(new Date('2026-10-17T20:00:00+08:00').getTime())).toBe('昨天')
  })

  it('更早 → M 月 D 日', () => {
    expect(at(new Date('2026-10-16T10:00:00+08:00').getTime())).toBe('10 月 16 日')
    expect(at(new Date('2026-09-01T10:00:00+08:00').getTime())).toBe('9 月 1 日')
  })

  it('坏时间 → 空串（调用方不渲染）', () => {
    expect(relativeNewTabTime(Number.NaN, NOW)).toBe('')
    expect(relativeNewTabTime(Number.POSITIVE_INFINITY, NOW)).toBe('')
  })
})
