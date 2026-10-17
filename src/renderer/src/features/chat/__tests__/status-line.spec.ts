import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { STATUS_LOCK_MS, STATUS_OVERTIME_MS, deriveStatusWord, useStatusWord } from '../status-line'

const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: '看下这个仓库' }] }

function reasoning(text: string): UIMessage {
  return { id: 'a0', role: 'assistant', parts: [{ type: 'reasoning', text }] }
}

function text(value: string): UIMessage {
  return { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: value }] }
}

function tool(name: string, input: Record<string, unknown> = {}): UIMessage {
  return {
    id: 'a2',
    role: 'assistant',
    parts: [
      {
        type: `tool-${name}`,
        toolCallId: `call-${name}`,
        state: 'input-available',
        input
      } as UIMessage['parts'][number]
    ]
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('deriveStatusWord：精确/粗粒度', () => {
  it('submitted：精确=正在准备工具调用；粗=正在准备', () => {
    expect(deriveStatusWord('submitted', [user], true)).toBe('正在准备工具调用')
    expect(deriveStatusWord('submitted', [user], false)).toBe('正在准备')
  })

  it('streaming：正文→正在写回答/正在生成；reasoning→正在思考', () => {
    expect(deriveStatusWord('streaming', [user, text('好的')], true)).toBe('正在写回答')
    expect(deriveStatusWord('streaming', [user, text('好的')], false)).toBe('正在生成')
    expect(deriveStatusWord('streaming', [user, reasoning('先看看')], true)).toBe('正在思考')
  })

  it('工具运行中：精确词带文件名；拿不到文件名退回「正在调用工具」；粗粒度永远通用词', () => {
    expect(
      deriveStatusWord('streaming', [user, tool('read', { path: 'D:\\repo\\README.md' })], true)
    ).toBe('正在读取 README.md')
    expect(deriveStatusWord('streaming', [user, tool('write', { path: 'src/a.ts' })], true)).toBe(
      '正在写入 a.ts'
    )
    expect(deriveStatusWord('streaming', [user, tool('fetch', { url: 'https://x' })], true)).toBe(
      '正在调用工具'
    )
    expect(deriveStatusWord('streaming', [user, tool('read', { path: 'README.md' })], false)).toBe(
      '正在调用工具'
    )
  })

  it('ready/error 空串；没有可见内容回正在思考', () => {
    expect(deriveStatusWord('ready', [user, text('完成')], true)).toBe('')
    expect(deriveStatusWord('streaming', [user], true)).toBe('正在思考')
  })
})

describe('useStatusWord：1s 锁 + 10s 超时', () => {
  it('1s 内不换词；锁过写最新词', () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useStatusWord({ status: 'streaming', messages, precise: true, enabled: true }),
      { initialProps: { messages: [user, reasoning('想一想')] } }
    )
    expect(result.current.word).toBe('正在思考')

    rerender({ messages: [user, tool('read', { path: 'a.md' })] })
    act(() => {
      vi.advanceTimersByTime(STATUS_LOCK_MS - 1)
    })
    expect(result.current.word).toBe('正在思考')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.word).toBe('正在读取 a.md')
  })

  it('10s 没有新输出 → 暂未响应（说法仍在）', () => {
    const { result } = renderHook(() =>
      useStatusWord({ status: 'submitted', messages: [user], precise: true, enabled: true })
    )
    expect(result.current.word).toBe('正在准备工具调用')
    act(() => {
      vi.advanceTimersByTime(STATUS_OVERTIME_MS + 600)
    })
    expect(result.current.word).toBe('暂未响应')
  })

  it('statusLine 关（enabled=false）：立刻切词、不跑锁/超时', () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useStatusWord({ status: 'streaming', messages, precise: false, enabled: false }),
      { initialProps: { messages: [user] } }
    )
    expect(result.current.word).toBe('正在思考')
    rerender({ messages: [user, text('在写')] })
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.word).toBe('正在生成')
  })
})
