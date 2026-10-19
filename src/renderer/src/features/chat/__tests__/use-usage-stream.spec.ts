import { describe, expect, it } from 'vitest'
import { collectUsage } from '../useUsageStream'

/** PB-033 data-usage 消费：有 usage / 无 usage / reported=false / 多步 / 同 step 覆盖。 */
const usage = (
  stepIndex: number,
  input: number,
  output: number,
  extra: Record<string, unknown> = {}
) => ({ type: 'data-usage', data: { stepIndex, inputTokens: input, outputTokens: output, ...extra } })

describe('collectUsage（PB-033 data-usage）', () => {
  it('无 data-usage → reported=false（UI 显示「—」，不显示 0）', () => {
    const result = collectUsage([{ type: 'text', text: 'hi' }])
    expect(result.steps).toEqual([])
    expect(result.latest).toEqual({
      input: null,
      output: null,
      total: null,
      cached: null,
      contextInput: null,
      reported: false
    })
  })

  it('有 usage → 精确取值（不估算），latest 取最后一步', () => {
    const result = collectUsage([usage(0, 1, 3, { totalTokens: 4, contextInput: 1 })])
    expect(result.steps).toEqual([
      { stepIndex: 0, input: 1, output: 3, total: 4, cached: null, contextInput: 1 }
    ])
    expect(result.latest).toMatchObject({ input: 1, output: 3, total: 4, contextInput: 1, reported: true })
  })

  it('多步累加：steps 按 stepIndex 升序，latest = 最大 stepIndex', () => {
    const result = collectUsage([usage(1, 10, 20), usage(0, 1, 2)])
    expect(result.steps.map((step) => step.stepIndex)).toEqual([0, 1])
    expect(result.latest).toMatchObject({ input: 10, output: 20, reported: true })
  })

  it('同一 step 只保留最新一条（后到覆盖先到）', () => {
    const result = collectUsage([usage(0, 1, 2), usage(0, 5, 6, { contextInput: 7 })])
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ input: 5, output: 6, contextInput: 7 })
  })

  it('非法/缺字段的 usage 被忽略（不造数字）', () => {
    const result = collectUsage([
      { type: 'data-usage', data: { stepIndex: 0 } },
      { type: 'data-usage', data: { stepIndex: 1, inputTokens: 'x', outputTokens: 2 } }
    ])
    expect(result.steps).toEqual([])
    expect(result.latest.reported).toBe(false)
  })
})
