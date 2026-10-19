// @vitest-environment node
/**
 * PB-039（P0，Nia R07a 真机采样）：**非文本块的 `block-end` 不能发 `text-end`**。
 *
 * 现象：先说话再调工具的轮次整轮失败，renderer（AI SDK）抛
 * `Received text-end for missing text part`，错误卡「这一轮没有完成」。
 * 根因：`sse-map.ts` 对 `block-end` 无条件发 `text-end`（旧实现 `:265-268`），
 * 而 `block-start` 只对 `blockType === 'text'` 发 `text-start`（`:243-245`）——
 * 工具块（`blockType:'tool-call'`）从来没有 `text-start`，却收到了 `text-end`。
 *
 * 本 spec 钉两件事：
 *   1. 文本帧必须**成对且闭合**：每个 `text-end` 都能在它之前找到同 id 的 `text-start`；
 *      真实夹具 `kernel-tool-follow-values.json`（工具轮）里不许出现"孤立的 text-end"；
 *   2. 非文本块（工具/思考等）的 start/end **不产生任何 text 帧**；文本块照常配对。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  KernelSseMapper,
  type KernelAssistantChunk,
  type KernelFollowValue,
  type RendererSseFrame
} from '../sse-map'

const KERNEL_TOOL = fileURLToPath(
  new URL('./fixtures/kernel-tool-follow-values.json', import.meta.url)
)

type TextFrame = { type: string; id: string }

function textFrames(frames: readonly RendererSseFrame[]): TextFrame[] {
  return frames.flatMap((frame) =>
    (frame.type === 'text-start' || frame.type === 'text-end') && typeof frame.id === 'string'
      ? [{ type: frame.type, id: frame.id }]
      : []
  )
}

function orphanTextEnds(frames: readonly RendererSseFrame[]): TextFrame[] {
  const open = new Set<string>()
  const orphans: TextFrame[] = []
  for (const frame of frames) {
    if (frame.type === 'text-start') {
      open.add(frame.id)
      continue
    }
    if (frame.type !== 'text-end') continue
    if (open.has(frame.id)) open.delete(frame.id)
    else orphans.push(frame)
  }
  return orphans
}

function mapAll(values: readonly KernelFollowValue[]): RendererSseFrame[] {
  const mapper = new KernelSseMapper()
  const frames: RendererSseFrame[] = []
  for (const value of values) frames.push(...mapper.push(value))
  return frames
}

function chunk(attemptId: string, index: number, body: KernelAssistantChunk): KernelFollowValue {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId, index, chunk: body } }
}

describe('PB-039：非文本 block 不得产生 text 帧', () => {
  it('真实工具轮夹具：所有 text-end 都有配对 text-start（没有孤立 text-end）', () => {
    const values = JSON.parse(readFileSync(KERNEL_TOOL, 'utf8')) as KernelFollowValue[]
    const frames = mapAll(values)
    const ends = textFrames(frames).filter((frame) => frame.type === 'text-end')
    // 夹具里有工具块；它不该把 text-1 之类的 id 带出来
    expect(ends.map((frame) => frame.id)).not.toContain('text-1')
    expect(orphanTextEnds(frames)).toEqual([])
  })

  it('非文本块（tool-call）的 block-end → 不发 text-end（也不发 text-start）', () => {
    const mapper = new KernelSseMapper()
    const frames: RendererSseFrame[] = []
    frames.push(
      ...mapper.push({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a:1' } })
    )
    frames.push(
      ...mapper.push(chunk('a:1', 0, { type: 'block-start', index: 0, blockType: 'tool-call' }))
    )
    frames.push(
      ...mapper.push(
        chunk('a:1', 0, {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call' }
        })
      )
    )
    expect(textFrames(frames)).toEqual([])
  })

  it('文本块照常配对：start → delta → end 同 id，且只发一次 end', () => {
    const mapper = new KernelSseMapper()
    const frames: RendererSseFrame[] = []
    frames.push(
      ...mapper.push({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a:1' } })
    )
    frames.push(
      ...mapper.push(chunk('a:1', 0, { type: 'block-start', index: 0, blockType: 'text' }))
    )
    frames.push(...mapper.push(chunk('a:1', 0, { type: 'text-delta', index: 0, text: '先说一句' })))
    frames.push(
      ...mapper.push(
        chunk('a:1', 0, { type: 'block-end', index: 0, block: { type: 'text', text: '先说一句' } })
      )
    )
    expect(textFrames(frames)).toEqual([
      { type: 'text-start', id: 'text-0' },
      { type: 'text-end', id: 'text-0' }
    ])
    expect(orphanTextEnds(frames)).toEqual([])
  })

  it('文本块结束后再来一个工具块：工具块不产生 text 帧，文本块不受影响', () => {
    const mapper = new KernelSseMapper()
    const frames: RendererSseFrame[] = []
    frames.push(
      ...mapper.push({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a:1' } })
    )
    frames.push(
      ...mapper.push(chunk('a:1', 0, { type: 'block-start', index: 0, blockType: 'text' }))
    )
    frames.push(...mapper.push(chunk('a:1', 0, { type: 'text-delta', index: 0, text: '先读目标' })))
    frames.push(
      ...mapper.push(
        chunk('a:1', 0, { type: 'block-end', index: 0, block: { type: 'text', text: '先读目标' } })
      )
    )
    frames.push(
      ...mapper.push(chunk('a:1', 1, { type: 'block-start', index: 1, blockType: 'tool-call' }))
    )
    frames.push(
      ...mapper.push(
        chunk('a:1', 1, {
          type: 'block-end',
          index: 1,
          block: { type: 'tool-call' }
        })
      )
    )
    expect(textFrames(frames)).toEqual([
      { type: 'text-start', id: 'text-0' },
      { type: 'text-end', id: 'text-0' }
    ])
  })
})
