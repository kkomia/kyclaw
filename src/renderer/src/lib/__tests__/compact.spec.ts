import { describe, expect, it } from 'vitest'
import { shouldCompact, thresholdTokensOf, usagePercentOf } from '@renderer/lib/compact'
import { defaultSettings, type AppSettings } from '@shared/settings'

/**
 * 压缩阈值口径（round 19；round 22 起 probed 实测优先）：
 * 阈值 = 默认模型 × contextPct × 上下文长度——分母与上下文环同源（contextTokensFor）。
 */
function withFlash(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...defaultSettings(),
    providers: [
      {
        id: 'ds',
        type: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        isDefault: true
      }
    ],
    ...overrides
  }
}

describe('thresholdTokensOf（round 22：probed 实测优先）', () => {
  it('没探测：回落注册表（deepseek-flash = 128K）；有探测：用真实值 1M', () => {
    expect(thresholdTokensOf(withFlash())).toBe(128_000)
    expect(
      thresholdTokensOf(
        withFlash({
          probedModels: {
            'ds:deepseek-flash': {
              contextWindow: 1_048_576,
              fetchedAt: '2026-10-11T00:00:00.000Z'
            }
          }
        })
      )
    ).toBe(1_048_576)
  })

  it('对话长度百分比同样走实测分母（50% × 1M = 512K）', () => {
    expect(
      thresholdTokensOf(
        withFlash({
          modelPrefs: { 'ds/deepseek-flash': { contextPct: 50 } },
          probedModels: {
            'ds:deepseek-flash': {
              contextWindow: 1_048_576,
              fetchedAt: '2026-10-11T00:00:00.000Z'
            }
          }
        })
      )
    ).toBe(524_288)
  })

  it('没有 provider → null（自动触发不动作）', () => {
    expect(thresholdTokensOf(defaultSettings())).toBeNull()
  })
})

describe('shouldCompact / usagePercentOf（既有口径回归）', () => {
  it('达到或超过阈值才触发；数据缺失不触发', () => {
    expect(shouldCompact(130_000, 128_000)).toBe(true)
    expect(shouldCompact(128_000, 128_000)).toBe(true)
    expect(shouldCompact(127_999, 128_000)).toBe(false)
    expect(shouldCompact(null, 128_000)).toBe(false)
    expect(shouldCompact(130_000, null)).toBe(false)
  })

  it('使用率换算：0–100 整数、封顶 100', () => {
    expect(usagePercentOf(64_000, 128_000)).toBe(50)
    expect(usagePercentOf(200_000, 128_000)).toBe(100)
    expect(usagePercentOf(null, 128_000)).toBeNull()
    expect(usagePercentOf(1000, null)).toBeNull()
  })
})
