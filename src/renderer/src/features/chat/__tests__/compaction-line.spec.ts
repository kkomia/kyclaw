import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { StoredMessage, ThreadCompaction } from '@shared/threads'
import { mapStoredMessages } from '@renderer/lib/message-map'
import { compactionRowIndex, formatCompactTokens, messageCreatedAtOf } from '../compaction-line'

/**
 * round 59 · 压缩分界线的两件纯逻辑（标签数字口径 + 位置规则）与它的数据钩子。
 * 组件级形态（发丝线 / 查看摘要 / 折叠）在 compact-flow.spec.tsx 里钉；这里钉的是边界。
 */
function record(createdAt: string): ThreadCompaction {
  return {
    threadId: 'thread-1',
    summary: '## 要点\n- 压缩出来的要点',
    summarized: 4,
    kept: 10,
    createdAt,
    tokensBefore: null,
    tokensAfter: null
  }
}

function message(id: string, createdAt?: number): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: `正文 ${id}` }],
    ...(createdAt === undefined ? {} : { metadata: { createdAt } })
  }
}

describe('formatCompactTokens（分界线标签里的 token 数字）', () => {
  it('≥100k：取整到 k（百万级不说人话）', () => {
    expect(formatCompactTokens(527_000)).toBe('527k')
    expect(formatCompactTokens(527_400)).toBe('527k')
    expect(formatCompactTokens(1_048_576)).toBe('1049k')
    expect(formatCompactTokens(100_000)).toBe('100k')
  })

  it('<100k：保留 1 位小数并去尾 .0', () => {
    expect(formatCompactTokens(53_700)).toBe('53.7k')
    expect(formatCompactTokens(8_000)).toBe('8k')
    expect(formatCompactTokens(99_950)).toBe('100k')
  })

  it('不足 1k：原样给数（"0.9k" 这种读法没有意义）', () => {
    expect(formatCompactTokens(950)).toBe('950')
    expect(formatCompactTokens(0)).toBe('0')
  })
})

describe('compactionRowIndex（分界线 = 对话流里的时间点）', () => {
  const AT = '2026-10-11T02:00:00.000Z'
  const T = Date.parse(AT)

  it('没有压缩记录：不画（null）', () => {
    expect(compactionRowIndex([message('a', T)], null)).toBeNull()
  })

  it('落在"压缩时刻之后到达的第一条消息"之前', () => {
    expect(compactionRowIndex([message('a', T - 1_000), message('b', T + 1_000)], record(AT))).toBe(
      1
    )
  })

  it('压缩时刻之后的第一条就是首条：插在最前（0）', () => {
    expect(compactionRowIndex([message('a', T), message('b', T + 1)], record(AT))).toBe(0)
  })

  it('全部消息都更早（刚压完那种）：落在列表末尾', () => {
    expect(compactionRowIndex([message('a', T - 2_000), message('b', T - 1_000)], record(AT))).toBe(
      2
    )
    expect(compactionRowIndex([], record(AT))).toBe(0)
  })

  it('未知时间（本轮新发的消息）按"不早于压缩"：分界线落在它之前', () => {
    // a 在压缩之前 → 跳过；b 时间未知（本轮新发）→ 分界线插在它前面
    expect(
      compactionRowIndex([message('a', T - 1), message('b'), message('c', T + 1)], record(AT))
    ).toBe(1)
    expect(compactionRowIndex([message('a')], record(AT))).toBe(0)
  })

  it('已知前段 + 未知尾段（重开会话后本轮新发）：分界线停在未知段起点', () => {
    // 真实形态：回灌来的历史都早于压缩时刻（压缩把更早的摘掉了、留下的是压缩前的），
    // 本轮新发的消息没有时间戳 —— 它们必须排在分界线**下面**（不漂到末尾）
    expect(
      compactionRowIndex(
        [message('a', T - 2_000), message('b', T - 1_000), message('c'), message('d')],
        record(AT)
      )
    ).toBe(2)
  })

  it('极端数据：存储消息一个 part 都不带时间戳 → 同一近似（登记在案）', () => {
    expect(compactionRowIndex([message('a'), message('b')], record(AT))).toBe(0)
  })

  it('记录时间解析不出来（脏数据）：不猜位置，落到末尾', () => {
    expect(compactionRowIndex([message('a', T + 1)], record('不是时间'))).toBe(1)
  })
})

describe('回灌的消息时间（分界线的定位锚点）', () => {
  function stored(id: string, parts: unknown[]): StoredMessage {
    return { id, role: 'user', content: { format: 2, parts } }
  }

  it('取该消息各 part 的 createdAt 最大值挂成 metadata.createdAt', () => {
    const [mapped] = mapStoredMessages([
      stored('m1', [
        { type: 'text', text: '先落', createdAt: 100 },
        { type: 'text', text: '后落', createdAt: 300 }
      ])
    ])
    expect(messageCreatedAtOf(mapped)).toBe(300)
    expect(mapped.metadata).toEqual({ createdAt: 300 })
  })

  it('一个 part 都没时间 / 时间不是数：不挂这个字段（未知 ≠ 现在）', () => {
    const [noTime] = mapStoredMessages([stored('m1', [{ type: 'text', text: '正文' }])])
    expect(messageCreatedAtOf(noTime)).toBeNull()
    expect(noTime.metadata).toBeUndefined()

    const [badTime] = mapStoredMessages([
      stored('m2', [{ type: 'text', text: '正文', createdAt: '2026-10-11' }])
    ])
    expect(messageCreatedAtOf(badTime)).toBeNull()
  })
})
