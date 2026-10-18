import { describe, expect, it } from 'vitest'
import { processSummaryOf } from '../parts/process-summary'

describe('task-114 · process-summary（顺序/单复数/分隔符）', () => {
  it('全角「，」连接，类别顺序 thinking→output→tool→record', () => {
    const s = processSummaryOf({ thinking: 1, output: 2, tool: 3, record: 4 })
    expect(s.full).toBe('执行 1 次思考，输出 2 段文字，调用 3 次工具，记录 4 条')
    expect(s.name).toBe(s.full)
    expect(s.compact).toBe('思考×1 · 输出×2 · 工具×3 · 记录×4')
  })

  it('单类别 / 0 项不写 / 只有 thinking', () => {
    expect(processSummaryOf({ thinking: 1 }).full).toBe('执行 1 次思考')
    expect(processSummaryOf({ tool: 3 }).full).toBe('调用 3 次工具')
    expect(processSummaryOf({ thinking: 0, tool: 2 }).full).toBe('调用 2 次工具')
    expect(processSummaryOf({}).full).toBe('')
    expect(processSummaryOf({}).compact).toBe('')
  })

  it('空类别跳过但保持顺序', () => {
    expect(processSummaryOf({ tool: 2, thinking: 1 }).full).toBe('执行 1 次思考，调用 2 次工具')
    expect(processSummaryOf({ record: 5, tool: 2 }).compact).toBe('工具×2 · 记录×5')
  })
})
