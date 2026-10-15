/**
 * 步骤列表行模型（纯函数）：分组 / 折叠 / 搜索 / 三档排序。
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/threads'
import { buildTrajectory, type TrajectoryDoc, type TrajectoryRow } from '../model'
import { buildLedgerItems, turnSummary, turnUsageText } from '../ledger'

function message(
  id: string,
  role: 'user' | 'assistant',
  createdAt: number,
  parts: unknown[]
): StoredMessage {
  return {
    id,
    role,
    createdAt: new Date(createdAt).toISOString(),
    content: {
      format: 2,
      parts,
      ...(role === 'assistant'
        ? { metadata: { modelId: 'deepseek-flash', provider: 'deepseek.chat' } }
        : {})
    }
  } as unknown as StoredMessage
}

const doc: TrajectoryDoc = buildTrajectory({
  messages: [
    message('u1', 'user', 1000, [{ type: 'text', text: '你好', createdAt: 1000 }]),
    message('a1', 'assistant', 2500, [
      { type: 'text', text: '查一下', createdAt: 1200 },
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolName: 'bash',
          toolCallId: 'c1',
          args: { command: 'ls' },
          result: '好'
        },
        updatedAt: 1900
      },
      { type: 'step-start', createdAt: 2000, model: 'deepseek-flash' },
      { type: 'text', text: '好了', createdAt: 2200 }
    ]),
    message('u2', 'user', 3000, [{ type: 'text', text: '继续', createdAt: 3000 }])
  ],
  usageRuns: [
    {
      id: 'r1',
      runId: null,
      model: 'deepseek-flash',
      provider: 'deepseek.chat',
      input: 1234,
      output: 56,
      total: 1290,
      cachedInput: 1000,
      contextInput: 4000,
      contextCachedInput: 3000,
      stepCount: 2,
      createdAt: new Date(1500).toISOString()
    }
  ]
})

const noFold = new Set<number>()

describe('分组与步骤分隔', () => {
  it('轮次档：一条表头 + 该轮的步骤分隔与数据行（步骤 >1 才出分隔）', () => {
    const items = buildLedgerItems({ doc, mode: 'turns', collapsedTurns: noFold, matches: null })

    expect(items.map((item) => item.type)).toEqual([
      'turn',
      'row', // 用户消息
      'step', // 步骤 1
      'row', // 助手步骤 1
      'row', // 工具
      'step', // 步骤 2
      'row', // 助手步骤 2
      'turn',
      'row'
    ])
    const header = items[0]
    expect(header?.type === 'turn' && header.label).toBe('第 1 轮')
    expect(header?.type === 'turn' && header.summary).toBe('2 个步骤 · 1 个工具调用')
    expect(header?.type === 'turn' && header.usageText).toBe('输入 1,234 · 输出 56 · 缓存 1,000')
    expect(header?.type === 'turn' && header.foldable).toBe(true)
  })

  it('折叠摘要文案与 dsh 同款："N 个步骤 · M 个工具调用"', () => {
    const turn = doc.turns[0]!
    expect(turnSummary(turn)).toBe('2 个步骤 · 1 个工具调用')
    expect(turnUsageText(turn)).toBe('输入 1,234 · 输出 56 · 缓存 1,000')
    expect(turnUsageText(doc.turns[1]!)).toBeNull()
  })
})

describe('折叠', () => {
  it('收起某一轮：表头 + 一行摘要，该轮的数据行全部让位', () => {
    const items = buildLedgerItems({
      doc,
      mode: 'turns',
      collapsedTurns: new Set([1]),
      matches: null
    })

    expect(items.map((item) => item.type)).toEqual(['turn', 'collapsed', 'turn', 'row'])
    const collapsed = items[1]
    expect(collapsed?.type === 'collapsed' && collapsed.summary).toBe('2 个步骤 · 1 个工具调用')
    expect(items[0]?.type === 'turn' && items[0].collapsed).toBe(true)
  })
})

describe('搜索', () => {
  it('搜索生效时不折叠：只留命中行，表头照旧（分组还看得见）', () => {
    const matches = new Set([doc.rows[2]!.index, doc.rows[4]!.index])
    const items = buildLedgerItems({
      doc,
      mode: 'turns',
      collapsedTurns: new Set([1, 2]),
      matches
    })

    expect(items.filter((item) => item.type === 'row')).toHaveLength(2)
    expect(items.some((item) => item.type === 'collapsed')).toBe(false)
    expect(items.map((item) => item.type)).toEqual(['turn', 'step', 'row', 'turn', 'row'])
  })
})

describe('视图档的排序与取舍', () => {
  /** 手工造一份"时间序与文档序不一致"的文档：第 3 条其实最早发生 */
  const reordered: TrajectoryDoc = {
    ...doc,
    rows: doc.rows.map((row, position) => ({ ...row, startedAt: 5000 - position * 1000 }))
  }

  it('时长档按真实开始时刻排（时刻缺的排最后，保持稳定）', () => {
    const withMissing = {
      ...reordered,
      rows: reordered.rows.map((row, position) =>
        position === 0 ? ({ ...row, startedAt: null } as TrajectoryRow) : row
      )
    }
    const items = buildLedgerItems({
      doc: withMissing,
      mode: 'duration',
      collapsedTurns: noFold,
      matches: null
    })
    const indexes = items.flatMap((item) => (item.type === 'row' ? [item.row.index] : []))

    // 手工时刻：第 N 条 = 5000 - N×1000；第 0 条置 null → 升序 = 4,3,2,1，null 的那条垫底
    expect(indexes).toEqual([4, 3, 2, 1, 0])
  })

  it('调用档只列工具行', () => {
    const items = buildLedgerItems({ doc, mode: 'calls', collapsedTurns: noFold, matches: null })
    const rows = items.filter((item) => item.type === 'row')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type === 'row' && rows[0].row.kind).toBe('tool')
    // 工具所在那一轮的表头还在（分组关系不丢）
    expect(items.some((item) => item.type === 'turn')).toBe(true)
  })
})
