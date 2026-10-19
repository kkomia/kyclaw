import { describe, expect, it } from 'vitest'
import { resolveUsageReadout } from '../usage-live'
import type { UsageLatest } from '../useUsageStream'

/** PB-033 读数优先级：live 覆盖库值 / live 缺失回落 / reported=false 显示「—」/ 轮末以库为准。 */
const live = (contextInput: number | null, reported = true): UsageLatest => ({
  input: 1,
  output: 2,
  total: 3,
  cached: null,
  contextInput,
  reported
})

describe('resolveUsageReadout', () => {
  it('流内：live reported 优先于库值', () => {
    const result = resolveUsageReadout({
      live: live(120),
      stored: { contextInput: 100, reported: true },
      settled: false
    })
    expect(result).toEqual({ contextInput: 120, reported: true, source: 'live' })
  })

  it('流内：live 缺失 → 回落库值', () => {
    const result = resolveUsageReadout({
      live: live(null, false),
      stored: { contextInput: 100, reported: true },
      settled: false
    })
    expect(result).toEqual({ contextInput: 100, reported: true, source: 'stored' })
  })

  it('reported=false（live 与库都无数据）→ null + reported=false（UI 显示「—」）', () => {
    const result = resolveUsageReadout({
      live: live(null, false),
      stored: { contextInput: null, reported: false },
      settled: false
    })
    expect(result).toEqual({ contextInput: null, reported: false, source: 'stored' })
  })

  it('轮末：settled=true 一律取库值（live 与库不一致以库为准）', () => {
    const result = resolveUsageReadout({
      live: live(120),
      stored: { contextInput: 100, reported: true },
      settled: true
    })
    expect(result).toEqual({ contextInput: 100, reported: true, source: 'stored' })
  })
})
