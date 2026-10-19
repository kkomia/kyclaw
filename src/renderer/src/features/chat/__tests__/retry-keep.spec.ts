import { describe, expect, it } from 'vitest'
import {
  RETRY_KEEP_METADATA_KEY,
  RETRY_KEEP_PROMPT,
  isRetryKeepMessage,
  preservedRecordsOf
} from '../retry-keep'

/**
 * PB-035 B′：失败轮「保留内容再试」的纯逻辑。
 * 这份文件只钉两件事：① 标记消息的识别口径；② 「已产生几条记录」的口径（决定错误卡给不给分叉）。
 */
describe('isRetryKeepMessage', () => {
  it('带标记的 user 消息 = 隐藏标记消息', () => {
    expect(
      isRetryKeepMessage({
        role: 'user',
        metadata: { [RETRY_KEEP_METADATA_KEY]: true }
      })
    ).toBe(true)
  })

  it('普通用户消息 / assistant 消息 / 坏 metadata 都不算', () => {
    expect(isRetryKeepMessage({ role: 'user', metadata: {} })).toBe(false)
    expect(isRetryKeepMessage({ role: 'user' })).toBe(false)
    expect(isRetryKeepMessage({ role: 'user', metadata: null })).toBe(false)
    expect(isRetryKeepMessage({ role: 'user', metadata: { [RETRY_KEEP_METADATA_KEY]: 'yes' } })).toBe(
      false
    )
    // 就算是 assistant 带了同名 metadata，也不算（标记只对 user 消息生效）
    expect(
      isRetryKeepMessage({ role: 'assistant', metadata: { [RETRY_KEEP_METADATA_KEY]: true } })
    ).toBe(false)
  })

  it('提示词不是空串（新起一轮必须有实际指令）', () => {
    expect(RETRY_KEEP_PROMPT.trim().length).toBeGreaterThan(10)
  })
})

describe('preservedRecordsOf', () => {
  it('非空正文 + 工具调用各算一条', () => {
    expect(
      preservedRecordsOf({
        role: 'assistant',
        parts: [
          { type: 'text', text: '说到一半' },
          { type: 'tool-bash', state: 'output-available' },
          { type: 'tool-read', state: 'input-available' }
        ]
      })
    ).toBe(3)
  })

  it('空白正文与 reasoning 不算「用户看得见的产出」', () => {
    expect(
      preservedRecordsOf({
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '想了很久' },
          { type: 'text', text: '   ' },
          { type: 'step-start' }
        ]
      })
    ).toBe(0)
  })

  it('没有 parts / 没有消息 = 0', () => {
    expect(preservedRecordsOf({ role: 'assistant' })).toBe(0)
    expect(preservedRecordsOf(undefined)).toBe(0)
  })
})
