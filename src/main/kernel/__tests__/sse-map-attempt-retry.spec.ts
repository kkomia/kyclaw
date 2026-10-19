// @vitest-environment node
/**
 * PB-013：内核 attempt 级重试导致 UI 正文重复（UI 3 份 / 落库 1 份）。
 *
 * 机理（Eve 实测，flag 开 K1/K2）：内核在「正文已交付之后」断流会自己重试，重试开始是一条新的
 * `assistant-stream start`（新 attemptId）。旧实现只把 messageId 换成新值、**不重置 textIds**，
 * 于是重试正文继续追加到同一个 `text-*` 部件 → UI N 份，而内核落库只有最终 attempt 1 份。
 *
 * 修法：把「新 attemptId」当正文边界——先发 `reset-step`（AI SDK v7 既有 UI chunk，丢弃当前步骤
 * 已渲染部件），再重置 textIds/finish/usage 状态，重发的 start-step + text-start 从零开始。
 * 正常路径（无重试）一帧都不多发，边收边发的流式行为不变。
 *
 * 这里用一个**模拟 AI SDK v7 消费端**的最小 UI 模型来量"用户最终看到几份正文"：
 *   parts 列表 + activeTextParts（按 id）；
 *   start-step 追加步骤标记；text-start 新建正文部件；text-delta 按 id 追加；
 *   reset-step 丢弃**当前步骤**的部件（= `node_modules/ai/dist/index.js` 的 case "reset-step"）。
 */
import { describe, expect, it } from 'vitest'
import {
  KernelSseMapper,
  appendEffectiveFrames,
  type KernelAssistantChunk,
  type KernelFollowValue,
  type RendererSseFrame
} from '../sse-map'

const MARK = 'DUPBODY'

/** AI SDK v7 消费端语义的最小复刻（只保留与判定相关的分支） */
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
        // 与 AI SDK 一致：只丢当前步骤的部件，并清空 activeTextParts
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

  /** 用户最终看到的正文（把各正文部件拼起来） */
  text(): string {
    return this.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('')
  }
}

function attemptStart(attemptId: string): KernelFollowValue {
  return { type: 'assistant-stream', frame: { type: 'start', attemptId } }
}

function chunk(attemptId: string, body: KernelAssistantChunk): KernelFollowValue {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk: body } }
}

/** 一次「吐正文」= block-start + 两段 delta（与 Eve 探针的 stub 剧本同形） */
function attemptBody(attemptId: string, text: string): KernelFollowValue[] {
  return [
    chunk(attemptId, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(attemptId, { type: 'text-delta', index: 0, text }),
    chunk(attemptId, { type: 'text-delta', index: 0, text: '｜' })
  ]
}

function attemptFinish(attemptId: string): KernelFollowValue[] {
  return [
    chunk(attemptId, { type: 'block-end', index: 0 }),
    chunk(attemptId, { type: 'finish', reason: { kind: 'stop' } }),
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

function countCopies(text: string): number {
  return text.split(MARK).length - 1
}

describe('PB-013 重试正文替换（attempt 边界）', () => {
  it('3 次断流后成功（K1 剧本）：UI 正文只 1 份，reset-step 每次重试一条', () => {
    const attempts = ['a1', 'a2', 'a3']
    const values: KernelFollowValue[] = []
    for (const attempt of attempts) {
      values.push(attemptStart(attempt), ...attemptBody(attempt, MARK))
      // 断流：没有 block-end/finish/end，内核直接开下一个 attempt
    }
    values.push(attemptStart('a4'), ...attemptBody('a4', MARK), ...attemptFinish('a4'))

    const { frames, ui } = drive(values)
    expect(countCopies(ui.text())).toBe(1)
    expect(ui.text()).toBe(`${MARK}｜`)
    expect(frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(3)
    // 每次重试的 start 帧都换了 messageId（attempt 边界可辨认）
    expect(new Set(frames.flatMap((frame) => (frame.type === 'start' ? [frame.messageId] : []))).size).toBe(4)
  })

  it('2 次断流后成功（K2 剧本）：UI 正文只 1 份', () => {
    const values: KernelFollowValue[] = [
      attemptStart('b1'),
      ...attemptBody('b1', MARK),
      attemptStart('b2'),
      ...attemptBody('b2', MARK),
      attemptStart('b3'),
      ...attemptBody('b3', MARK),
      ...attemptFinish('b3')
    ]
    const { frames, ui } = drive(values)
    expect(countCopies(ui.text())).toBe(1)
    expect(frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(2)
  })

  it('失败 attempt 带 outcome=failed 时同样替换（且不会把 error 留到下一 attempt）', () => {
    const values: KernelFollowValue[] = [
      attemptStart('c1'),
      ...attemptBody('c1', MARK),
      { type: 'assistant-stream', frame: { type: 'end', attemptId: 'c1', outcome: { kind: 'failed' } } },
      attemptStart('c2'),
      ...attemptBody('c2', MARK),
      ...attemptFinish('c2')
    ]
    const { frames, ui } = drive(values)
    expect(countCopies(ui.text())).toBe(1)
    // c1 的 error 帧在 c2 开流时已重置：成功 attempt 仍能正常收尾
    expect(frames.filter((frame) => frame.type === 'finish')).toHaveLength(1)
  })

  it('正常单 attempt：不发 reset-step，帧序与改动前一致（不多发帧）', () => {
    const values: KernelFollowValue[] = [
      attemptStart('d1'),
      ...attemptBody('d1', '正常正文'),
      ...attemptFinish('d1')
    ]
    const { frames } = drive(values)
    expect(frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(0)
    expect(frames.map((frame) => frame.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish'
    ])
  })
})

describe('PB-013 整轮有效帧（result.frames / result.sse 里正文只 1 份）', () => {
  /**
   * 这一条对齐 Eve 探针的度量口径（`uiCopies` = 把 result.frames 里同 id 的 text-delta 拼起来数 marker）：
   * 实时流照旧有 N 段 + reset-step，但**整轮有效帧**里只剩最终 attempt 的正文。
   */
  it('累积有效帧：3 次断流后成功 → 正文 1 份（Eve 探针口径）', () => {
    const values: KernelFollowValue[] = []
    for (const attempt of ['e1', 'e2', 'e3']) {
      values.push(attemptStart(attempt), ...attemptBody(attempt, MARK))
    }
    values.push(attemptStart('e4'), ...attemptBody('e4', MARK), ...attemptFinish('e4'))

    const mapper = new KernelSseMapper()
    const effective: RendererSseFrame[] = []
    let liveCopies = 0
    for (const value of values) {
      const frames = mapper.push(value)
      liveCopies += frames.reduce(
        (sum, frame) => sum + (frame.type === 'text-delta' ? countCopies(frame.delta) : 0),
        0
      )
      appendEffectiveFrames(effective, frames)
    }

    const effectiveText = effective
      .flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : []))
      .join('')
    // 实时流里 4 段（原样交付，UI 靠 reset-step 丢弃前 3 段）
    expect(liveCopies).toBe(4)
    // 整轮有效帧里只 1 份
    expect(countCopies(effectiveText)).toBe(1)
    expect(effective.filter((frame) => frame.type === 'reset-step')).toHaveLength(3)
    expect(effective.filter((frame) => frame.type === 'finish')).toHaveLength(1)
  })
})
