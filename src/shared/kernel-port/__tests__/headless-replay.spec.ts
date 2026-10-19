// @vitest-environment node
/**
 * B2 黄金事件夹具：**B1.5 真机 POC 的原始 NDJSON**（不是手编）。
 * 这是将来内核升级的漂移闸门：事件名/字段/顺序一变，这里就红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseHeadlessNdjson, summarizeHeadlessRun } from '../headless-replay'

const FIXTURE = fileURLToPath(new URL('../fixtures/headless-poc-20261019.ndjson', import.meta.url))

describe('黄金事件夹具（POC 2026-10-19 实测）', () => {
  it('逐行解析出 7 条事件、顺序与类型与实测一致', () => {
    const events = parseHeadlessNdjson(readFileSync(FIXTURE, 'utf8'))
    expect(events).toHaveLength(7)
    expect(events.map((event) => event.type)).toEqual([
      'session',
      'status',
      'status',
      'text',
      'status',
      'status',
      'final'
    ])
  })

  it('汇总：session id / 一轮一步 / usage 12-8-20 / completed / 最终文本', () => {
    const summary = summarizeHeadlessRun(parseHeadlessNdjson(readFileSync(FIXTURE, 'utf8')))
    expect(summary).toMatchObject({
      sessionId: 'session-d115db07-ebce-4433-90b6-7f53b3ef3806',
      cwd: 'E:\\gitlab\\kyclaw',
      turn: 1,
      steps: 1,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      endKind: 'completed',
      text: 'POC-OK：内核会话与事件流可用。',
      finalText: 'POC-OK：内核会话与事件流可用。'
    })
  })

  it('坏行/缺 type 显式抛错（不静默吞掉漂移）', () => {
    expect(() => parseHeadlessNdjson('{"type":"text","text":"ok"}\nnot json')).toThrow(/not JSON/)
    expect(() => parseHeadlessNdjson('{"text":"ok"}')).toThrow(/has no type/)
  })
})
