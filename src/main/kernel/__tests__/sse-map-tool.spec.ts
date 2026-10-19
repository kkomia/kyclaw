// @vitest-environment node
/**
 * B3.2 工具事件映射：内核 `tool/call` + `tool/result` → 旧路径同形的
 * `tool-input-available` / `tool-output-available` / `tool-output-error`（字段级 diff）。
 *
 * 输入夹具：`kernel-tool-follow-values.json` / `kernel-tool-error-follow-values.json`（真机采集）。
 * 基准夹具：`renderer-sse-tool-success-0.1.6.json` / `renderer-sse-tool-error-0.1.6.json`（旧路径采集）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KernelSseMapper, type KernelFollowValue, type RendererSseFrame } from '../sse-map'

const KERNEL_SUCCESS = fileURLToPath(
  new URL('./fixtures/kernel-tool-follow-values.json', import.meta.url)
)
const KERNEL_ERROR = fileURLToPath(
  new URL('./fixtures/kernel-tool-error-follow-values.json', import.meta.url)
)
const REF_SUCCESS = fileURLToPath(
  new URL('./fixtures/renderer-sse-tool-success-0.1.6.json', import.meta.url)
)
const REF_ERROR = fileURLToPath(
  new URL('./fixtures/renderer-sse-tool-error-0.1.6.json', import.meta.url)
)

function mapAll(values: readonly KernelFollowValue[]): RendererSseFrame[] {
  const mapper = new KernelSseMapper()
  const frames: RendererSseFrame[] = []
  for (const value of values) frames.push(...mapper.push(value))
  return frames
}

function normalize(frames: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return frames.map((frame) => {
    const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>
    if (typeof clone.toolCallId === 'string') clone.toolCallId = '<id>'
    if (typeof clone.toolName === 'string') clone.toolName = '<tool>'
    if (typeof clone.input === 'object' && clone.input !== null) clone.input = '<input>'
    if (typeof clone.output === 'object' && clone.output !== null) clone.output = '<output>'
    if (typeof clone.errorText === 'string') clone.errorText = '<error>'
    return clone
  })
}

describe('B3.2 工具事件映射（字段级对齐旧路径）', () => {
  it('成功：tool-input-available → tool-output-available（文本先于工具帧）', () => {
    const values = JSON.parse(readFileSync(KERNEL_SUCCESS, 'utf8')) as KernelFollowValue[]
    const frames = mapAll(values)
    const toolFrames = frames.filter((frame) => frame.type.startsWith('tool'))
    const reference = JSON.parse(readFileSync(REF_SUCCESS, 'utf8')) as Record<string, unknown>[]
    expect(normalize(toolFrames as unknown as Record<string, unknown>[])).toEqual(
      normalize(reference)
    )

    const input = toolFrames[0]
    expect(input).toMatchObject({ type: 'tool-input-available', toolName: 'get_goal', input: {} })
    const output = toolFrames[1]
    expect(output).toMatchObject({ type: 'tool-output-available', output: { goal: null } })
  })

  it('报错：tool-input-available → tool-output-error（errorText 保留内核原文）', () => {
    const values = JSON.parse(readFileSync(KERNEL_ERROR, 'utf8')) as KernelFollowValue[]
    const frames = mapAll(values)
    const toolFrames = frames.filter((frame) => frame.type.startsWith('tool'))
    const reference = JSON.parse(readFileSync(REF_ERROR, 'utf8')) as Record<string, unknown>[]
    expect(normalize(toolFrames as unknown as Record<string, unknown>[])).toEqual(
      normalize(reference)
    )
    expect(toolFrames[1]).toMatchObject({
      type: 'tool-output-error',
      toolCallId: 'toolu_1'
    })
    const errorText = (toolFrames[1] as { errorText?: string }).errorText ?? ''
    expect(errorText).toContain('unknown tool')
  })
})
