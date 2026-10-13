/**
 * 轨迹搜索（纯函数）：文本 / 工具名 / 轮次三种命中口径。
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/threads'
import { buildTrajectory } from '../model'
import { searchTrajectory } from '../search'

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

const doc = buildTrajectory({
  messages: [
    message('u1', 'user', 1000, [{ type: 'text', text: '帮我查青光眼', createdAt: 1000 }]),
    message('a1', 'assistant', 2000, [
      { type: 'text', text: '先搜索资料', createdAt: 1200 },
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolName: 'mcp__kybase__search',
          toolCallId: 'c1',
          args: { keyword: '青光眼' },
          result: '命中 3 条'
        },
        updatedAt: 1800
      }
    ]),
    message('u2', 'user', 3000, [{ type: 'text', text: '再整理成文档', createdAt: 3000 }]),
    message('a2', 'assistant', 4000, [{ type: 'text', text: '已生成 Word', createdAt: 3900 }])
  ]
})

describe('searchTrajectory', () => {
  it('空查询 = 不过滤（列表照常全量）', () => {
    const result = searchTrajectory(doc.rows, '   ')
    expect(result.active).toBe(false)
    expect(result.matches.size).toBe(0)
  })

  it('正文命中（大小写不敏感）', () => {
    const result = searchTrajectory(doc.rows, '青光眼')
    expect(result.active).toBe(true)
    expect([...result.matches].sort()).toEqual([0, 2])
    expect(result.turns).toEqual(new Set([1]))
  })

  it('工具名命中：连入参 / 结果一起搜', () => {
    const byName = searchTrajectory(doc.rows, 'KYBASE')
    expect([...byName.matches]).toEqual([2])
    expect(byName.tools).toBe(1)

    const byResult = searchTrajectory(doc.rows, '命中 3 条')
    expect([...byResult.matches]).toEqual([2])
  })

  it('轮次过滤：纯数字 = 轮次精确匹配（不被正文里的数字淹没）', () => {
    const result = searchTrajectory(doc.rows, '2')
    // 第 2 轮 = 用户消息「再整理成文档」+ 助手「已生成 Word」
    expect([...result.matches].sort()).toEqual([3, 4])
    expect(result.turns).toEqual(new Set([2]))
  })

  it('「第2轮」这类写法去掉空白后也命中表头口径', () => {
    const result = searchTrajectory(doc.rows, '第2轮')
    expect(result.turns).toEqual(new Set([2]))
    expect(result.matches.size).toBeGreaterThan(0)
  })

  it('搜不到就是空集合（不回落成全量）', () => {
    const result = searchTrajectory(doc.rows, '不存在的词')
    expect(result.active).toBe(true)
    expect(result.matches.size).toBe(0)
    expect(result.tools).toBe(0)
  })
})
