// @vitest-environment node
/**
 * B2：事件 → 现有 UI 形状的投影（不改 renderer，只保证 adapter 能产出同构数据）。
 */
import { describe, expect, it } from 'vitest'
import { createFakeKernel } from '../fake-kernel'
import { applySurfaceOps, projectSessionEvents } from '../projection'

describe('投影：surfaceOp.replace + UI 消息形状', () => {
  it('片段被最终消息替换，UI 只看到最终文本（与内核语义一致）', async () => {
    const kernel = createFakeKernel()
    const { events } = await kernel.runTurn('hi')
    const projected = projectSessionEvents(events)

    expect(projected.finalText).toBe('POC-OK：内核会话与事件流可用。')
    const assistantTexts = projected.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) =>
        message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      )
    expect(assistantTexts).toEqual(['POC-OK：内核会话与事件流可用。'])
    // 片段只有一条 assistant 文本 part（被 replace 掉，不会叠加成两条）
    expect(assistantTexts).toHaveLength(1)
  })

  it('工具 call/result 合成 tool-invocation part（result 状态与结果可见）', async () => {
    const kernel = createFakeKernel()
    const { events } = await kernel.runTurn('hi')
    const projected = projectSessionEvents(events)
    const tool = projected.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool-invocation')
    expect(tool).toMatchObject({
      type: 'tool-invocation',
      toolInvocation: {
        toolCallId: 'call-fake-1',
        toolName: 'read',
        state: 'result',
        result: { text: 'fake tool result' }
      }
    })
  })

  it('usage / turnEnd 从 turn/end 事件带出（POC 实测 12/8/20，completed）', async () => {
    const kernel = createFakeKernel()
    const { events } = await kernel.runTurn('hi')
    const projected = projectSessionEvents(events)
    expect(projected.turnEnd).toEqual({ kind: 'completed' })
    expect(projected.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      exactness: 'provider'
    })
  })

  it('applySurfaceOps 只剔除被替换区间，序号保持原样', async () => {
    const kernel = createFakeKernel({ withTool: false })
    const { events } = await kernel.runTurn('hi')
    const kept = applySurfaceOps(events)
    const seqs = kept.map((event) => event.seq)
    // 片段 seq=3 被最终消息（seq=4）替换
    expect(seqs).toEqual([1, 2, 4, 5, 6])
  })
})
