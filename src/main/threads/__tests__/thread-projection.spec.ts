// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  applySurfaceOps,
  projectThreadCompaction,
  projectThreadMessages,
  projectThreadSummary
} from '../thread-projection'
import type { KernelSessionEventLike, KernelSessionSummary } from '../../kernel/kernel-session-ops'

let seq = 0
function event(
  type: string,
  data: Record<string, unknown>,
  options: { surfaceOp?: unknown; time?: number } = {}
): KernelSessionEventLike {
  seq += 1
  return {
    type,
    seq,
    time: options.time ?? 1_700_000_000_000 + seq,
    data,
    ...(options.surfaceOp === undefined
      ? { surfaceOp: 'append' }
      : { surfaceOp: options.surfaceOp })
  }
}

function user(
  text: string,
  sourceKind = 'user',
  surfaceOp: unknown = 'append'
): KernelSessionEventLike {
  return event(
    'user/message',
    {
      id: `u-${String(seq + 1)}`,
      role: 'user',
      source: { kind: sourceKind },
      content: [{ type: 'text', text }]
    },
    { surfaceOp }
  )
}

function assistant(text: string): KernelSessionEventLike {
  return event('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: `a-${String(seq + 1)}`,
      role: 'assistant',
      content: [{ type: 'text', text }]
    }
  })
}

describe('thread-projection：surface 语义与旧 StoredMessage', () => {
  it('summary → ThreadSummary（updatedAt 转 ISO）', () => {
    const summary: KernelSessionSummary = {
      sessionId: 't1',
      title: '标题',
      updatedAt: 1_700_000_000_000
    }
    expect(projectThreadSummary(summary)).toEqual({
      id: 't1',
      title: '标题',
      updatedAt: '2023-11-14T22:13:20.000Z'
    })
  })

  it('只保留 user/message(source=user) 与 assistant/message；runtime-context 不进历史', () => {
    const events = [
      user('你好'),
      user('Current runtime context', 'runtime-context'),
      assistant('你好，我在。')
    ]
    const messages = projectThreadMessages(events)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(messages[0]?.content)).toContain('你好')
    expect(JSON.stringify(messages[1]?.content)).toContain('你好，我在。')
    expect(JSON.stringify(messages)).not.toContain('Current runtime context')
  })

  it('tool/call + tool/result 归并成 assistant 的 tool-invocation part', () => {
    const events = [
      user('读一下'),
      event('tool/call', {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'read',
        arguments: '{"path":"a.txt"}'
      }),
      assistant('我来读。'),
      event('tool/result', {
        turn: 1,
        step: 1,
        message: {
          toolCallId: 'c1',
          isError: false,
          content: [{ type: 'text', text: '{"content":"ok"}' }]
        }
      })
    ]
    const messages = projectThreadMessages(events)
    const assistantMessage = messages.find((message) => message.role === 'assistant')
    expect(assistantMessage).toBeDefined()
    const content = assistantMessage?.content as { format?: number; parts?: unknown[] }
    expect(content.format).toBe(2)
    expect(content.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-invocation',
          toolInvocation: expect.objectContaining({
            toolCallId: 'c1',
            toolName: 'read',
            args: { path: 'a.txt' },
            state: 'result',
            result: { content: 'ok' }
          })
        })
      ])
    )
  })

  it('surfaceOp replace 先移除被覆盖的 surface 节点，再放替换节点', () => {
    const oldUser = user('旧问题')
    const oldAnswer = assistant('旧回答')
    const replacement = user('新问题', 'user', {
      op: 'replace',
      startSeq: oldUser.seq,
      endSeq: oldAnswer.seq
    })
    const surface = applySurfaceOps([oldUser, oldAnswer, replacement])
    expect(surface.map((item) => item.seq)).toEqual([replacement.seq])
    const messages = projectThreadMessages([oldUser, oldAnswer, replacement])
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages[0]?.content)).toContain('新问题')
    expect(JSON.stringify(messages)).not.toContain('旧回答')
  })

  it('tool/result 的 surface replace 会替换旧的工具结果（不是追加两份）', () => {
    const call = event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'read',
      arguments: '{}'
    })
    const firstResult = event('tool/result', {
      turn: 1,
      step: 1,
      message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'old' }] }
    })
    const replacement = event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'new' }] }
      },
      { surfaceOp: { op: 'replace', startSeq: firstResult.seq, endSeq: firstResult.seq } }
    )
    const assistantMessage = assistant('结果')
    const messages = projectThreadMessages([call, firstResult, replacement, assistantMessage])
    const text = JSON.stringify(messages)
    expect(text).toContain('new')
    expect(text).not.toContain('old')
  })

  it('compaction/summary 派生 summary/summarized/level，tokens 保持 null（不造假）', () => {
    const e1 = user('旧内容')
    const e2 = assistant('旧回答')
    const summary = event('compaction/summary', {
      summary: [{ type: 'text', text: '这段是摘要' }],
      shadowedSeqs: [e1.seq, e2.seq],
      shadowedRange: { start: e1.seq, end: e2.seq },
      shadowedTokenCount: 123
    })
    const checkpoint = user('summary checkpoint', 'compaction', {
      op: 'replace',
      startSeq: e1.seq,
      endSeq: e2.seq
    })
    const compaction = projectThreadCompaction([e1, e2, summary, checkpoint], 't1')
    expect(compaction).toMatchObject({
      threadId: 't1',
      summary: '这段是摘要',
      summarized: 2,
      level: 'summary',
      kept: null,
      tokensBefore: null,
      tokensAfter: null
    })
  })

  it('没有 compaction/summary 时返回 null', () => {
    expect(projectThreadCompaction([user('hi')], 't1')).toBeNull()
  })
})
