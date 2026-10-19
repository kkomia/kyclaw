// @vitest-environment node
/**
 * B2 fake kernel：产出符合 `SessionEvent` 语义的事件序列（不启动进程）。
 * 验收点：seq 单调、surfaceOp replace 指向被替换的片段、usage 用 POC 实测值。
 */
import { describe, expect, it } from 'vitest'
import { createFakeKernel } from '../fake-kernel'

describe('fake kernel：一轮事件序列（SessionEvent 语义）', () => {
  it('runTurn 产出 session → user → tool → assistant(片段/最终 replace) → turn/end', async () => {
    const kernel = createFakeKernel()
    const { events, finalText } = await kernel.runTurn('say hi')

    expect(finalText).toBe('POC-OK：内核会话与事件流可用。')
    expect(events.map((event) => event.type)).toEqual([
      'session/created',
      'user/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'assistant/message',
      'assistant/attempt',
      'turn/end'
    ])

    // SessionSeq 单调递增、从 1 开始
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    // 最终消息用 surfaceOp replace 指向片段（端点含边界，与内核语义一致）
    const final = events.find(
      (event) => event.type === 'assistant/message' && event.surfaceOp !== undefined
    )
    expect(final?.type).toBe('assistant/message')
    if (final?.type !== 'assistant/message') throw new Error('unreachable')
    expect(final.surfaceOp).toEqual({ op: 'replace', startSeq: 5, endSeq: 5 })

    const turnEnd = events.at(-1)
    expect(turnEnd?.type).toBe('turn/end')
    if (turnEnd?.type !== 'turn/end') throw new Error('unreachable')
    expect(turnEnd.reason).toEqual({ kind: 'completed' })
    expect(turnEnd.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      exactness: 'provider'
    })
  })

  it('subscribe 收到实时事件；replay 可按 seq 回放', async () => {
    const kernel = createFakeKernel({ withTool: false })
    const seen: number[] = []
    const unsubscribe = kernel.events.subscribe((event) => seen.push(event.seq))
    await kernel.runTurn('hi')
    unsubscribe()
    expect(seen).toEqual([1, 2, 3, 4, 5, 6])

    const replayed: number[] = []
    for await (const event of kernel.events.replay(3)) replayed.push(event.seq)
    expect(replayed).toEqual([3, 4, 5, 6])
  })

  it('usage / goal / commands / tools 端口形状可用（goal 走内核式 CAS）', async () => {
    const kernel = createFakeKernel()
    await expect(kernel.usage.read(kernel.sessionId)).resolves.toMatchObject({
      exactness: 'unknown',
      totalTokens: 0
    })

    const created = await kernel.goal.apply(kernel.sessionId, {
      action: 'create',
      objective: '完成迁移'
    })
    expect(created).toMatchObject({ phase: 'active', revision: 1, maxGoalRounds: 256 })

    await expect(
      kernel.goal.apply(kernel.sessionId, {
        action: 'pause',
        ref: { id: created?.id ?? '', revision: 99 }
      })
    ).rejects.toThrow(/stale goal revision/)

    const paused = await kernel.goal.apply(kernel.sessionId, {
      action: 'pause',
      ref: { id: created?.id ?? '', revision: 1 }
    })
    expect(paused).toMatchObject({ phase: 'paused', revision: 2 })

    expect(kernel.commands.list().map((command) => command.name)).toEqual([
      'compact',
      'plan',
      'goal'
    ])
    await expect(kernel.commands.execute('goal')).resolves.toMatchObject({ ok: true })
    expect(kernel.tools.list().map((tool) => tool.name)).toContain('hindsight_reflect')
    await expect(kernel.tools.invoke('nope', {})).resolves.toMatchObject({ ok: false })
  })
})
