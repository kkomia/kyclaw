// @vitest-environment node
/**
 * PB-013 返工补充护栏（Lead 本轮点名）：**多步轮里"第二步之后才发生的真重试"**。
 *
 * 风险：正文部件 id 改成 `text-<全局序号>` 后，如果**重试时把序号归零**，那么"第一步已经渲染过
 * text-0、第二步重试又从 text-0 开始"会撞 id。AI SDK 的真实行为（`node_modules/ai/dist/index.js`
 * 的 `case "text-start"`）：**不查重**，直接 push 一个新 part 并覆盖 `activeTextParts[id]`
 * —— 同一条消息里出现两个同 id 的 text part，后续按 id 选文/引用/再 reset 都会指错。
 *
 * 本 spec 钉三件事：
 *   1. 整轮所有 `text-start` 的 id **全局唯一**（含重试后重新吐出的正文）；
 *   2. 真重试仍只保留最终正文（reset-step 语义不回归）；
 *   3. **重放路径**：`appendEffectiveFrames` 产出的有效帧原样重发给一个新消费端，
 *      既不产生重复 id，也不会把上一步的正文误清；reload 走 `projectThreadMessages`
 *      （StoredMessage），**结构性不含 text 帧 id**，不存在 id 不一致问题。
 */
import { describe, expect, it } from 'vitest'
import {
  KernelSseMapper,
  appendEffectiveFrames,
  type KernelAssistantChunk,
  type KernelFollowValue,
  type RendererSseFrame
} from '../sse-map'

/** AI SDK 语义的最小复刻：text-start 不查重；reset-step 删"最后一个 start-step 之后"的部件 */
class AiLikeUiModel {
  readonly parts: Array<{ id?: string; type: string; text?: string }> = []
  private active = new Map<string, { type: string; text: string }>()

  apply(frame: RendererSseFrame): void {
    switch (frame.type) {
      case 'text-start': {
        const part = { type: 'text', id: frame.id, text: '' }
        this.parts.push(part)
        this.active.set(frame.id, part)
        return
      }
      case 'text-delta': {
        const part = this.active.get(frame.id)
        if (part === undefined) throw new Error(`text-delta for missing part ${frame.id}`)
        part.text += frame.delta
        return
      }
      case 'text-end': {
        const part = this.active.get(frame.id)
        if (part === undefined) throw new Error(`text-end for missing part ${frame.id}`)
        this.active.delete(frame.id)
        return
      }
      case 'start-step':
        this.parts.push({ type: 'step-mark' })
        return
      case 'reset-step': {
        let lastMark = -1
        for (let index = this.parts.length - 1; index >= 0; index -= 1) {
          if (this.parts[index]?.type === 'step-mark') {
            lastMark = index
            break
          }
        }
        if (lastMark >= 0) this.parts.splice(lastMark + 1)
        this.active.clear()
        return
      }
      default:
        return
    }
  }

  textIds(): string[] {
    return this.parts.flatMap((part) => (part.type === 'text' && part.id ? [part.id] : []))
  }

  texts(): string[] {
    return this.parts.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : []))
  }
}

function stepStart(attemptId: string, turn: number, step: number): KernelFollowValue {
  return { type: 'assistant-stream', frame: { type: 'start', attemptId, turn, step } }
}

function chunk(attemptId: string, body: KernelAssistantChunk): KernelFollowValue {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk: body } }
}

function textBody(attemptId: string, index: number, text: string): KernelFollowValue[] {
  return [
    chunk(attemptId, { type: 'block-start', index, blockType: 'text' }),
    chunk(attemptId, { type: 'text-delta', index, text }),
    chunk(attemptId, { type: 'block-end', index })
  ]
}

function stepFinish(attemptId: string): KernelFollowValue[] {
  return [
    chunk(attemptId, { type: 'finish', reason: { kind: 'tool-calls' } }),
    { type: 'assistant-stream', frame: { type: 'end', attemptId } }
  ]
}

function drive(values: KernelFollowValue[]): { frames: RendererSseFrame[]; ui: AiLikeUiModel } {
  const ui = new AiLikeUiModel()
  const frames: RendererSseFrame[] = []
  const mapper = new KernelSseMapper()
  for (const value of values) {
    for (const frame of mapper.push(value)) {
      frames.push(frame)
      ui.apply(frame)
    }
  }
  return { frames, ui }
}

describe('PB-013 补充护栏：多步轮 + 真重试的 id 唯一性', () => {
  it('第二步之后真重试：整轮 text-start id 全局唯一（不许与第一步残留 part 撞 id）', () => {
    const values: KernelFollowValue[] = [
      stepStart('a1', 1, 1),
      ...textBody('a1', 0, '第一步正文'),
      ...stepFinish('a1'),
      stepStart('a2', 1, 2),
      ...textBody('a2', 0, '第二步半截'),
      // 真重试：同 turn/step、新 attemptId
      stepStart('a3', 1, 2),
      ...textBody('a3', 0, '第二步重试后的正文'),
      ...stepFinish('a3')
    ]

    const { frames, ui } = drive(values)
    const ids = frames.flatMap((frame) => (frame.type === 'text-start' ? [frame.id] : []))
    expect(new Set(ids).size).toBe(ids.length)
    // 第二步的正文只留重试后那份（reset-step 语义不回归）
    expect(ui.texts()).toEqual(['第一步正文', '第二步重试后的正文'])
  })

  it('重放路径：有效帧原样重发不产生重复 id，且不误清上一步正文', () => {
    const values: KernelFollowValue[] = [
      stepStart('b1', 1, 1),
      ...textBody('b1', 0, '第一步'),
      ...stepFinish('b1'),
      stepStart('b2', 1, 2),
      ...textBody('b2', 0, '第二步半截'),
      stepStart('b3', 1, 2),
      ...textBody('b3', 0, '第二步最终'),
      ...stepFinish('b3')
    ]

    const mapper = new KernelSseMapper()
    const effective: RendererSseFrame[] = []
    for (const value of values) appendEffectiveFrames(effective, mapper.push(value))

    // "重放"= 把有效帧原样再喂给一个新消费端（id 已烘焙在帧里）
    const replayed = new AiLikeUiModel()
    for (const frame of effective) replayed.apply(frame)
    const ids = effective.flatMap((frame) => (frame.type === 'text-start' ? [frame.id] : []))
    expect(new Set(ids).size).toBe(ids.length)
    expect(replayed.texts()).toEqual(['第一步', '第二步最终'])
  })

  it('reload 路径（StoredMessage）不含 text 帧 id：结构性没有"重放 id 不一致"问题', async () => {
    const { projectThreadMessages } = await import('../../threads/thread-projection')
    const messages = projectThreadMessages([
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 2,
        data: {
          id: 'u-1',
          role: 'user',
          content: [{ type: 'text', text: '问题' }],
          source: { kind: 'user' }
        },
        surfaceOp: 'append'
      },
      {
        type: 'assistant/message',
        seq: 3,
        data: {
          turn: 1,
          step: 1,
          message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: '回答' }] }
        },
        surfaceOp: 'append'
      },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } }
    ])
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain('text-0')
    expect(serialized).not.toContain('text-start')
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })
})
