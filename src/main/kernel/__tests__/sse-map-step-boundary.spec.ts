// @vitest-environment node
/**
 * PB-013 返工（Nia R07/R08/R06 真机）：**工具步骤边界被误判成"重试"**。
 *
 * 内核语义（`dsh-agent-loop` 源码确认）：每条 `assistant-stream start` 的 `attemptId` 是
 * `sessionId:attempt`（attached-Session 里的请求计数）——**每个 step 都会换**；start 帧同时带
 * `turn` 与 `step`。所以「attemptId 变了」不能当重试判据：
 *   - **同一 (turn, step) + 新 attemptId** = 真重试（断流/失败重跑）→ 要发 reset-step（PB-013 原修法）；
 *   - **(turn, step) 变了** = 工具步骤边界 → **不许 reset-step**（否则上一步的正文/工具卡/过程块被清掉：
 *     Nia 的真机现象是中间正文先可见随后变空、8 步只见到 1 个 tool-row、turn-latest-status 采样为 0）。
 *
 * 本 spec 同时钉两个方向（Lead 要求：真重试 → 清；工具步骤 → 不清）。
 */
import { describe, expect, it } from 'vitest'
import {
  KernelSseMapper,
  type KernelAssistantChunk,
  type KernelFollowValue,
  type RendererSseFrame
} from '../sse-map'

/** 与 PB-013 spec 同形的 AI SDK 最小消费端（reset-step 只丢当前步骤） */
class UiModel {
  private readonly parts: Array<{ kind: 'step-start' } | { kind: 'text'; id: string; text: string }> = []
  private activeText = new Map<string, { kind: 'text'; id: string; text: string }>()

  apply(frame: RendererSseFrame): void {
    switch (frame.type) {
      case 'start-step':
        this.parts.push({ kind: 'step-start' })
        return
      case 'text-start': {
        const part = { kind: 'text' as const, id: frame.id, text: '' }
        this.parts.push(part)
        this.activeText.set(frame.id, part)
        return
      }
      case 'text-delta': {
        const active = this.activeText.get(frame.id)
        if (active === undefined) {
          const part = { kind: 'text' as const, id: frame.id, text: frame.delta }
          this.parts.push(part)
          this.activeText.set(frame.id, part)
          return
        }
        active.text += frame.delta
        return
      }
      case 'reset-step': {
        let start = 0
        for (let index = this.parts.length - 1; index >= 0; index -= 1) {
          if (this.parts[index]?.kind === 'step-start') {
            start = index
            break
          }
        }
        this.parts.splice(start, this.parts.length - start)
        this.activeText = new Map()
        return
      }
      default:
        return
    }
  }

  texts(): string[] {
    return this.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : []))
  }
}

function stepStart(
  attemptId: string,
  slot: { turn?: number; step?: number } = {}
): KernelFollowValue {
  return { type: 'assistant-stream', frame: { type: 'start', attemptId, ...slot } }
}

function chunk(attemptId: string, body: KernelAssistantChunk): KernelFollowValue {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk: body } }
}

function textBody(attemptId: string, text: string): KernelFollowValue[] {
  return [
    chunk(attemptId, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(attemptId, { type: 'text-delta', index: 0, text }),
    chunk(attemptId, { type: 'block-end', index: 0 })
  ]
}

function stepFinish(attemptId: string): KernelFollowValue[] {
  return [
    chunk(attemptId, { type: 'finish', reason: { kind: 'tool-calls' } }),
    { type: 'assistant-stream', frame: { type: 'end', attemptId } }
  ]
}

function drive(values: KernelFollowValue[]): { frames: RendererSseFrame[]; ui: UiModel } {
  const mapper = new KernelSseMapper()
  const frames: RendererSseFrame[] = []
  const ui = new UiModel()
  for (const value of values) {
    for (const frame of mapper.push(value)) {
      frames.push(frame)
      ui.apply(frame)
    }
  }
  return { frames, ui }
}

describe('PB-013 返工：步骤边界 vs 真重试', () => {
  it('工具步骤边界（turn 同、step 变）→ 不发 reset-step，上一步正文保留', () => {
    const { frames, ui } = drive([
      stepStart('s1', { turn: 1, step: 1 }),
      ...textBody('s1', '第一步：先说一句'),
      ...stepFinish('s1'),
      stepStart('s2', { turn: 1, step: 2 }),
      ...textBody('s2', '第二步：再调工具'),
      ...stepFinish('s2')
    ])

    expect(frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(0)
    expect(ui.texts()).toEqual(['第一步：先说一句', '第二步：再调工具'])
    // 两步的正文 id 必须不同（否则 AI SDK 认为在给同一个 text part 续写）
    const textStarts = frames.flatMap((frame) => (frame.type === 'text-start' ? [frame.id] : []))
    expect(new Set(textStarts).size).toBe(2)
  })

  it('真重试（turn/step 都不变、attemptId 变）→ 仍发 reset-step，正文只留最终那份', () => {
    const { frames, ui } = drive([
      stepStart('r1', { turn: 1, step: 1 }),
      ...textBody('r1', '重试前的半截'),
      stepStart('r2', { turn: 1, step: 1 }),
      ...textBody('r2', '重试后的最终正文'),
      ...stepFinish('r2')
    ])

    expect(frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(1)
    expect(ui.texts()).toEqual(['重试后的最终正文'])
  })

  it('新 turn（turn 变、step 重置为 1）也按步骤边界处理，不清上一步', () => {
    const { frames, ui } = drive([
      stepStart('t1a', { turn: 1, step: 1 }),
      ...textBody('t1a', '第一轮'),
      ...stepFinish('t1a'),
      stepStart('t1b', { turn: 1, step: 2 }),
      ...textBody('t1b', '第一轮第二步'),
      ...stepFinish('t1b'),
      stepStart('t2a', { turn: 2, step: 1 }),
      ...textBody('t2a', '第二轮第一步'),
      ...stepFinish('t2a')
    ])

    expect(frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(0)
    expect(ui.texts()).toEqual(['第一轮', '第一轮第二步', '第二轮第一步'])
  })

  it('无 turn/step 的旧夹具形态仍按"attemptId 变 = 重试"（PB-013 原行为不回归）', () => {
    const { frames, ui } = drive([
      stepStart('legacy-1'),
      ...textBody('legacy-1', '旧形态半截'),
      stepStart('legacy-2'),
      ...textBody('legacy-2', '旧形态最终'),
      ...stepFinish('legacy-2')
    ])

    expect(frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(1)
    expect(ui.texts()).toEqual(['旧形态最终'])
  })
})
