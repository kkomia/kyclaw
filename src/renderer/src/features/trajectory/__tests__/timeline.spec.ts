/**
 * 时间轴布局（纯函数）：三条泳道、真实时刻 / 等宽序列两套投影、压空档、命中与最近邻。
 *
 * 一行一件事实：`输入/模型/工具` 的归属、块的左右位置与宽度、轮次分界的位置。
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/threads'
import { buildTrajectory, type TrajectoryDoc } from '../model'
import {
  deriveTimeline,
  laneFor,
  nearestSpanIndex,
  rowVisibleInMode,
  spanGeometry,
  spansInRange
} from '../timeline'

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
      // 注意：这条消息的 last part = 2200 —— 消息的"写完时刻"取它（行 createdAt 2500 只是插入时刻）
    ]),
    message('u2', 'user', 3000, [{ type: 'text', text: '继续', createdAt: 3000 }])
  ]
})

describe('泳道归属', () => {
  it('工具 → 第 3 条；助手与压缩 → 第 2 条；用户 / 上下文 / 系统 → 第 1 条（与 dsh 同口径）', () => {
    expect(laneFor('tool')).toBe(2)
    expect(laneFor('message')).toBe(1)
    expect(laneFor('compacted')).toBe(1)
    expect(laneFor('user')).toBe(0)
    expect(laneFor('context')).toBe(0)
    expect(laneFor('system')).toBe(0)
  })
})

describe('时长档（真实时刻 + 压空档）', () => {
  const model = deriveTimeline(doc, 'duration')

  it('位置与宽度来自真实时刻，事件之间的空档被压掉（等用户打字那段不占宽度）', () => {
    // 源数据：u1@1000、步骤 1@1000→2000、工具@1200→1900、步骤 2@2000→2200（消息最后写入 2200）、u2@3000
    // 压空档：u2 前面 800ms 空白被减掉 → 域 = [1000, 2200]
    expect(model.domainStart).toBe(1000)
    expect(model.domainEnd).toBe(2200)

    const u2 = model.spans.find((span) => span.kind === 'user' && span.start === 2200)
    expect(u2).toBeDefined()
    expect(model.spans.some((span) => span.start >= 2200 && span.end > 2200)).toBe(false)
  })

  it('每条块的左右与宽度按域换算（纯函数给百分比，视图直接画）', () => {
    const firstStep = model.spans.find((span) => span.kind === 'message' && span.start === 1000)
    expect(firstStep?.end).toBe(2000)
    expect(spanGeometry(model, firstStep!)).toEqual({
      leftPercent: 0,
      widthPercent: ((2000 - 1000) / 1200) * 100
    })

    const call = model.spans.find((span) => span.kind === 'tool')
    expect(spanGeometry(model, call!)).toEqual({
      leftPercent: ((1200 - 1000) / 1200) * 100,
      widthPercent: ((1900 - 1200) / 1200) * 100
    })
  })

  it('轮次分界落在每一轮的第一条块上', () => {
    expect(model.turnBoundaries.map((boundary) => boundary.turn)).toEqual([1, 2])
    expect(model.turnBoundaries[0]?.at).toBe(1000)
    expect(model.turnBoundaries[1]?.at).toBe(2200)
  })

  it('没有时长的行标 instant（视图用最小刻度画，不当成"持续了 0 毫秒"）', () => {
    const userRow = doc.rows[0]
    const span = model.spans.find((entry) => entry.rowIndex === userRow?.index)
    expect(span?.instant).toBe(true)
    expect(span?.start).toBe(span?.end)
  })

  it('只画带时刻的行；缺时刻的行不画（不补 0）', () => {
    const noTime = buildTrajectory({
      messages: [
        message('a9', 'assistant', 5000, [{ type: 'text', text: 'x' }]) as unknown as StoredMessage
      ]
    })
    const partial = deriveTimeline(
      { ...noTime, rows: noTime.rows.map((row) => ({ ...row, startedAt: null })) },
      'duration'
    )
    expect(partial.empty).toBe(true)
    expect(partial.spans).toHaveLength(0)
  })
})

describe('轮次档（等宽序列）', () => {
  const model = deriveTimeline(doc, 'turns')

  it('一条记录一个单位宽，与真实时刻无关（没时刻的行照样画得出来）', () => {
    expect(model.domainStart).toBe(0)
    expect(model.domainEnd).toBe(doc.rows.length)
    expect(model.spans.map((span) => [span.start, span.end])).toEqual(
      doc.rows.map((_, offset) => [offset, offset + 1])
    )
  })

  it('轮次分界落在该轮第一条记录在序列里的位置', () => {
    expect(model.turnBoundaries).toEqual([
      { turn: 1, at: 0 },
      { turn: 2, at: doc.rows.length - 1 }
    ])
  })
})

describe('调用档（只画工具）', () => {
  const model = deriveTimeline(doc, 'calls')

  it('只有工具块；空档同样压掉，域收紧到工具之间', () => {
    expect(model.spans.map((span) => span.kind)).toEqual(['tool'])
    expect(model.domainStart).toBe(1200)
    expect(model.domainEnd).toBe(1900)
  })

  it('rowVisibleInMode 说清了哪一行进这一档', () => {
    expect(rowVisibleInMode({ kind: 'tool' } as never, 'calls')).toBe(true)
    expect(rowVisibleInMode({ kind: 'message' } as never, 'calls')).toBe(false)
    expect(rowVisibleInMode({ kind: 'message' } as never, 'duration')).toBe(true)
  })
})

describe('可见集与命中', () => {
  it('只投影可见行（搜索过滤后时间轴与列表同一份集合）', () => {
    const onlyTools = new Set(doc.rows.filter((row) => row.kind === 'tool').map((row) => row.index))
    const model = deriveTimeline(doc, 'duration', onlyTools)
    expect(model.spans).toHaveLength(onlyTools.size)
    expect(new Set(model.spans.map((span) => span.rowIndex))).toEqual(onlyTools)
  })

  it('区间命中 = 区间内任一时刻活跃的块（含跨界的那条）', () => {
    const model = deriveTimeline(doc, 'duration')
    const hits = spansInRange(model, { start: 1500, end: 1600 })
    const kinds = [...hits].map(
      (index) => model.spans.find((span) => span.rowIndex === index)?.kind
    )
    expect(kinds).toContain('tool')
    expect(kinds).toContain('message')
  })

  it('点空白处找最近的一条（被覆盖的点返回覆盖它的那条）', () => {
    const model = deriveTimeline(doc, 'duration')
    // 1180 落在步骤 1 的区间（1000→2000）里，也紧挨着工具（1200 起）—— 返回覆盖它的步骤
    expect(nearestSpanIndex(model, 1180)).toBe(doc.rows[1]?.index)

    const fake = {
      domainStart: 0,
      domainEnd: 200,
      empty: false,
      turnBoundaries: [],
      spans: [
        {
          rowIndex: 7,
          lane: 0 as const,
          kind: 'user' as const,
          start: 0,
          end: 10,
          isError: false,
          instant: false
        },
        {
          rowIndex: 8,
          lane: 2 as const,
          kind: 'tool' as const,
          start: 100,
          end: 110,
          isError: false,
          instant: false
        }
      ]
    }
    // 45 距第一条 35、距第二条 55 → 第一条
    expect(nearestSpanIndex(fake, 45)).toBe(7)
    expect(nearestSpanIndex({ ...model, spans: [] }, 10)).toBeNull()
  })
})
