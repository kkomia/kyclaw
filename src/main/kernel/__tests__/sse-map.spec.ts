// @vitest-environment node
/**
 * B3.1a：内核帧 → 现有 SSE 帧的**字段级 diff**。
 *
 * 输入：`fixtures/kernel-follow-frames.json`（真机 `session/follow` 原样帧，B3.1a 探测）。
 * 基准：`fixtures/renderer-sse-kyclaw-0.1.6.json`（现有 kyclaw chat 路径实测帧）。
 * 断言：帧顺序、每帧字段名、数值字段全部一致；只有 消息 id / 文本内容 做占位（它们本来就因 run 而异）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KernelSseMapper, type KernelFollowValue, type RendererSseFrame } from '../sse-map'

const KERNEL = fileURLToPath(new URL('./fixtures/kernel-follow-frames.json', import.meta.url))
const REFERENCE = fileURLToPath(
  new URL('./fixtures/renderer-sse-kyclaw-0.1.6.json', import.meta.url)
)

function normalizeRecords(frames: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return frames.map((frame) => {
    const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>
    if (typeof clone.messageId === 'string') clone.messageId = '<id>'
    if (typeof clone.id === 'string') clone.id = '<id>'
    if (typeof clone.delta === 'string') clone.delta = '<text>'
    return clone
  })
}

function normalize(frames: readonly RendererSseFrame[]): Record<string, unknown>[] {
  return normalizeRecords(frames as unknown as Record<string, unknown>[])
}

describe('内核 assistant-stream → 现有 SSE 帧（字段级等价）', () => {
  it('真机 follow 帧映射后与 0.1.6 参考帧逐字段一致', () => {
    const items = JSON.parse(readFileSync(KERNEL, 'utf8')) as Array<{ value: KernelFollowValue }>
    const mapper = new KernelSseMapper()
    const frames: RendererSseFrame[] = []
    for (const item of items) frames.push(...mapper.push(item.value))

    const reference = JSON.parse(readFileSync(REFERENCE, 'utf8')) as Record<string, unknown>[]
    expect(normalize(frames)).toEqual(normalizeRecords(reference))
  })

  it('文本拼接 = POC 实测回答；帧顺序符合现状（finish-step → data-usage → finish）', () => {
    const items = JSON.parse(readFileSync(KERNEL, 'utf8')) as Array<{ value: KernelFollowValue }>
    const mapper = new KernelSseMapper()
    const frames: RendererSseFrame[] = []
    for (const item of items) frames.push(...mapper.push(item.value))

    const text = frames
      .flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : []))
      .join('')
    expect(text).toBe('POC-OK：内核 RPC 与事件流可用。')
    expect(frames.map((frame) => frame.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'data-usage',
      'finish'
    ])
  })

  it('usage 字段与参考一致（12/8/20、cached 0、context=输入）', () => {
    const items = JSON.parse(readFileSync(KERNEL, 'utf8')) as Array<{ value: KernelFollowValue }>
    const mapper = new KernelSseMapper()
    const frames: RendererSseFrame[] = []
    for (const item of items) frames.push(...mapper.push(item.value))
    expect(frames.find((frame) => frame.type === 'data-usage')).toEqual({
      type: 'data-usage',
      data: {
        stepIndex: 0,
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedInputTokens: 0,
        contextInput: 12
      }
    })
  })

  it('错误轮：已交付文本帧保留，错误帧只追加在末尾（含工具错误码）', () => {
    const mapper = new KernelSseMapper()
    const frames = [
      ...mapper.push({
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'attempt-1' }
      }),
      ...mapper.push({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          chunk: { type: 'block-start', index: 0, blockType: 'text' }
        }
      }),
      ...mapper.push({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          chunk: { type: 'text-delta', index: 0, text: '已经交付的正文' }
        }
      }),
      ...mapper.push({
        type: 'event',
        event: {
          type: 'turn/end',
          data: {
            turn: 1,
            reason: {
              kind: 'error',
              error: { code: 'TOOL_OUTCOME_UNKNOWN', message: 'tool outcome unknown' }
            }
          }
        }
      })
    ]
    const types = frames.map((frame) => frame.type)
    const textIndex = types.indexOf('text-delta')
    const errorIndex = types.indexOf('error')
    expect(textIndex).toBeGreaterThanOrEqual(0)
    expect(errorIndex).toBe(types.length - 1) // 错误在末尾
    expect(textIndex).toBeLessThan(errorIndex) // 正文先交付
    expect(frames[textIndex]).toMatchObject({ type: 'text-delta', delta: '已经交付的正文' })
    expect(frames[errorIndex]).toMatchObject({
      type: 'error',
      errorText: '[TOOL_OUTCOME_UNKNOWN] tool outcome unknown'
    })
  })

  it('取消轮：已交付文本保留，不追加 error 帧（与现有取消形状一致）', () => {
    const mapper = new KernelSseMapper()
    const frames = [
      ...mapper.push({
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'attempt-2' }
      }),
      ...mapper.push({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-2',
          chunk: { type: 'block-start', index: 0, blockType: 'text' }
        }
      }),
      ...mapper.push({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-2',
          chunk: { type: 'text-delta', index: 0, text: '取消前正文' }
        }
      }),
      ...mapper.push({
        type: 'event',
        event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } }
      })
    ]
    expect(frames.some((frame) => frame.type === 'text-delta')).toBe(true)
    expect(frames.some((frame) => frame.type === 'error')).toBe(false)
  })
})
