import { describe, expect, it } from 'vitest'
import {
  lookupReasoningChoice,
  reasoningOrdinalsOf,
  withReasoningChoice,
  type ReasoningOverrides
} from '@renderer/features/chat/reasoning-overrides'

/**
 * 思考段段身份的规则：**消息内 reasoning 序号**（只数 reasoning part）。
 *   - 工具行插进两段之间、正文流式追加，都不改序号 → 用户的选择不漂；
 *   - 同一消息里两段正文相同 / 互相是前缀，各有各的序号 → **各自独立**；
 *   - 正文只做辅助：记下时那份正文仍是现在这段的开头才算同一段。
 */
const parts = [
  { type: 'reasoning', text: '第一段' },
  { type: 'tool-bash' },
  { type: 'reasoning', text: '第二段' }
]
const ordinals = reasoningOrdinalsOf(parts)

describe('reasoning 序号（段身份）', () => {
  it('只数 reasoning：工具行不占号，插进来也不改后面两段的号', () => {
    const twoReasoning = [
      { type: 'reasoning', text: '第一段' },
      { type: 'reasoning', text: '第二段' }
    ]
    expect([...reasoningOrdinalsOf(twoReasoning)]).toEqual([
      [0, 0],
      [1, 1]
    ])
    // 工具插到中间：两段的号还是 0 / 1（part 下标却变成了 0 / 2）
    expect([...ordinals]).toEqual([
      [0, 0],
      [2, 1]
    ])
  })
})

describe('思考段手动开合表（按序号）', () => {
  it('记一次选择；同一段再改一次就覆盖', () => {
    const first = withReasoningChoice(new Map(), parts, ordinals, 0, { open: true, text: '第一段' })
    expect(lookupReasoningChoice(first, 0, '第一段')).toEqual({ open: true, text: '第一段' })

    const second = withReasoningChoice(first, parts, ordinals, 0, { open: false, text: '第一段' })
    expect(second.size).toBe(1)
    expect(lookupReasoningChoice(second, 0, '第一段')).toEqual({ open: false, text: '第一段' })
  })

  it('两段正文完全相同：各开各的，不串', () => {
    const same = [
      { type: 'reasoning', text: '同一段话' },
      { type: 'reasoning', text: '同一段话' }
    ]
    const sameOrdinals = reasoningOrdinalsOf(same)
    let overrides: ReasoningOverrides = new Map()
    overrides = withReasoningChoice(overrides, same, sameOrdinals, 0, {
      open: false,
      text: '同一段话'
    })
    overrides = withReasoningChoice(overrides, same, sameOrdinals, 1, {
      open: true,
      text: '同一段话'
    })
    // 第一段收起、第二段展开 —— 各自独立
    expect(lookupReasoningChoice(overrides, 0, '同一段话')?.open).toBe(false)
    expect(lookupReasoningChoice(overrides, 1, '同一段话')?.open).toBe(true)
    expect(overrides.size).toBe(2)
  })

  it('第二段是第一段的前缀：两段各开各的，不串', () => {
    const nested = [
      { type: 'reasoning', text: '先看目录再核对调用链' },
      { type: 'reasoning', text: '先看目录' }
    ]
    const nestedOrdinals = reasoningOrdinalsOf(nested)
    let overrides: ReasoningOverrides = new Map()
    overrides = withReasoningChoice(overrides, nested, nestedOrdinals, 0, {
      open: true,
      text: '先看目录再核对调用链'
    })
    overrides = withReasoningChoice(overrides, nested, nestedOrdinals, 1, {
      open: false,
      text: '先看目录'
    })
    expect(lookupReasoningChoice(overrides, 0, '先看目录再核对调用链')?.open).toBe(true)
    expect(lookupReasoningChoice(overrides, 1, '先看目录')?.open).toBe(false)
  })

  it('工具行插进来（序号不变）：第二段的选择照样查得到', () => {
    const before = [
      { type: 'reasoning', text: '第一段' },
      { type: 'reasoning', text: '第二段' }
    ]
    const chosen = withReasoningChoice(new Map(), before, reasoningOrdinalsOf(before), 1, {
      open: false,
      text: '第二段'
    })
    // 同一段的号还是 1，正文也没变 → 查得到
    expect(lookupReasoningChoice(chosen, 1, '第二段')?.open).toBe(false)
    const next = withReasoningChoice(chosen, parts, ordinals, 1, { open: false, text: '第二段' })
    expect(lookupReasoningChoice(next, 1, '第二段')?.open).toBe(false)
  })

  it('流式追加：按前缀认同一段，选择留着', () => {
    const chosen = withReasoningChoice(new Map(), parts, ordinals, 0, {
      open: false,
      text: '第一段'
    })
    expect(lookupReasoningChoice(chosen, 0, '第一段还没写完的后续')?.open).toBe(false)
  })

  it('这一段被换成了另一段正文（不是从旧的长的）→ 旧选择丢掉', () => {
    const stale = withReasoningChoice(new Map(), parts, ordinals, 0, { open: true, text: '第一段' })
    // 记下的比现在的长，说明这一段被替了
    expect(lookupReasoningChoice(stale, 0, '另一段')).toBeUndefined()
    const replaced = [
      { type: 'reasoning', text: '另一段' },
      { type: 'tool-bash' },
      { type: 'reasoning', text: '第二段' }
    ]
    const next = withReasoningChoice(stale, replaced, ordinals, 0, { open: false, text: '另一段' })
    expect(next.get(0)).toEqual({ open: false, text: '另一段' })
  })

  it('那一段没了（序号对不上任何 reasoning）→ 旧记录被清掉', () => {
    const stale = withReasoningChoice(new Map(), parts, ordinals, 1, { open: true, text: '第二段' })
    const onlyOne = [{ type: 'reasoning', text: '第一段' }]
    const next = withReasoningChoice(stale, onlyOne, reasoningOrdinalsOf(onlyOne), 0, {
      open: true,
      text: '第一段'
    })
    expect(next.has(1)).toBe(false)
    expect(next.size).toBe(1)
  })
})
