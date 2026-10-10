import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { StoredMessage } from '@shared/threads'
import { mapStoredMessages } from '../message-map'

/**
 * 历史回灌映射（T9 Step 1）：Mastra 存储消息 → AI SDK UI 消息。
 *
 * 样本取自**真实存储形态**（T9 探查：`content.format = 2` 的 parts 数组，
 * 文本/推理/工具调用都是 AI SDK v4 UI part 的形状）——不是凭空造的理想结构：
 *   - 文本：{ type: 'text', text }
 *   - 推理：{ type: 'reasoning', reasoning, details }
 *   - 工具：{ type: 'tool-invocation', toolInvocation: { state, toolCallId, toolName, args, result/errorText } }
 * 映射目标：ai（v7）的 UIMessage part（text / reasoning / tool-<name>），
 * 给 MessageList / ToolCard 直接渲染，工具卡的"调用中 / 已完成 / 出错"状态要能回放出来。
 */

function stored(role: string, parts: unknown[], id = `${role}-1`): StoredMessage {
  return { id, role, content: { format: 2, parts } } as StoredMessage
}

describe('mapStoredMessages：文本与推理', () => {
  it('用户/助手文本逐段映射，id 与顺序保持存储原样', () => {
    const mapped = mapStoredMessages([
      stored('user', [{ type: 'text', text: '帮我看看' }], 'u1'),
      stored(
        'assistant',
        [
          { type: 'text', text: '看什么？' },
          { type: 'text', text: '把文件发我。' }
        ],
        'a1'
      )
    ])

    expect(mapped).toHaveLength(2)
    expect(mapped[0]).toMatchObject({ id: 'u1', role: 'user' })
    expect(mapped[0].parts).toEqual([{ type: 'text', text: '帮我看看' }])
    expect(mapped[1].parts).toEqual([
      { type: 'text', text: '看什么？' },
      { type: 'text', text: '把文件发我。' }
    ])
  })

  it('推理映射成 reasoning part（text 字段），step-start 保留', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        { type: 'step-start' },
        {
          type: 'reasoning',
          reasoning: '先把问题拆开',
          details: [{ type: 'text', text: '先把问题拆开' }]
        },
        { type: 'text', text: '结论是……' }
      ])
    ])

    expect(message.parts).toEqual([
      { type: 'step-start' },
      { type: 'reasoning', text: '先把问题拆开' },
      { type: 'text', text: '结论是……' }
    ])
  })

  it('system / signal 不进 UI（只回灌 user/assistant）', () => {
    const mapped = mapStoredMessages([
      stored('system', [{ type: 'text', text: '系统提示' }], 's1'),
      stored('signal', [{ type: 'text', text: '信号' }], 'sig1'),
      stored('assistant', [{ type: 'text', text: '正常消息' }], 'a1')
    ])

    expect(mapped.map((message) => message.id)).toEqual(['a1'])
  })

  it('空文本、坏 part、未知类型被跳过，不把整条消息带崩', () => {
    const mapped = mapStoredMessages([
      stored('assistant', [
        { type: 'text', text: '' },
        { type: 'source-url', sourceId: 'x', url: 'https://example.com' },
        { type: 'text', text: '  保留  ' },
        null,
        'not-a-part',
        { type: 'text' }
      ])
    ])

    expect(mapped).toHaveLength(1)
    expect(mapped[0].parts).toEqual([{ type: 'text', text: '  保留  ' }])
  })

  it('content 不是预期结构（老格式/半截数据）时按空消息处理，不抛', () => {
    const mapped = mapStoredMessages([
      { id: 'a1', role: 'assistant', content: null } as unknown as StoredMessage,
      {
        id: 'a2',
        role: 'assistant',
        content: { format: 1, content: '老格式纯文本' }
      } as unknown as StoredMessage
    ])

    expect(mapped).toHaveLength(2)
    expect(mapped[0].parts).toEqual([])
    expect(mapped[1].parts).toEqual([])
  })
})

describe('mapStoredMessages：工具调用回放', () => {
  it('工具结果 → tool-<name> / output-available（input 与 output 原样带回）', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: 'call-1',
            toolName: 'read_file',
            args: { path: 'src/a.ts' },
            result: { content: 'hello' }
          }
        }
      ])
    ])

    expect(message.parts).toEqual([
      {
        type: 'tool-read_file',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { path: 'src/a.ts' },
        output: { content: 'hello' }
      }
    ])
  })

  it('工具出错 → output-error + errorText；结果带 isError 也按出错回放', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'output-error',
            toolCallId: 'call-err',
            toolName: 'run_command',
            args: { cmd: 'rm -rf /' },
            errorText: '权限不足'
          }
        },
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: 'call-err2',
            toolName: 'write_file',
            args: { path: 'a.txt' },
            result: '磁盘已满',
            isError: true
          }
        }
      ])
    ])

    expect(message.parts).toEqual([
      {
        type: 'tool-run_command',
        toolCallId: 'call-err',
        state: 'output-error',
        input: { cmd: 'rm -rf /' },
        errorText: '权限不足'
      },
      {
        type: 'tool-write_file',
        toolCallId: 'call-err2',
        state: 'output-error',
        input: { path: 'a.txt' },
        errorText: '磁盘已满'
      }
    ])
  })

  it('未完成的调用按状态机回放：partial-call → input-streaming、call → input-available', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'partial-call',
            toolCallId: 'call-p',
            toolName: 'glob',
            args: { pattern: '**' }
          }
        },
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'call',
            toolCallId: 'call-c',
            toolName: 'grep',
            args: { pattern: 'TODO' }
          }
        }
      ])
    ])

    expect(message.parts).toEqual([
      {
        type: 'tool-glob',
        toolCallId: 'call-p',
        state: 'input-streaming',
        input: { pattern: '**' }
      },
      {
        type: 'tool-grep',
        toolCallId: 'call-c',
        state: 'input-available',
        input: { pattern: 'TODO' }
      }
    ])
  })

  it('一条消息里文本与工具混排：顺序不变', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        { type: 'text', text: '我先读文件。' },
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: 'call-1',
            toolName: 'read_file',
            args: { path: 'a.txt' },
            result: '内容'
          }
        },
        { type: 'text', text: '读完了。' }
      ])
    ])

    expect(message.parts.map((part) => part.type)).toEqual(['text', 'tool-read_file', 'text'])
  })

  it('坏的工具 part（缺 toolName/toolCallId、args 缺失）被跳过', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1' } },
        { type: 'tool-invocation', toolInvocation: { state: 'result', toolName: 'x' } },
        { type: 'tool-invocation' },
        {
          type: 'tool-invocation',
          toolInvocation: { state: 'result', toolCallId: 'c2', toolName: 'read_file' }
        }
      ])
    ])

    expect(message.parts).toEqual([
      {
        type: 'tool-read_file',
        toolCallId: 'c2',
        state: 'output-available',
        input: undefined,
        output: undefined
      }
    ])
  })
})

describe('mapStoredMessages：与渲染契约对齐', () => {
  it('输出就是 UIMessage 数组（类型收口，chat 组件直接吃）', () => {
    const mapped: UIMessage[] = mapStoredMessages([
      stored('user', [{ type: 'text', text: '在吗' }])
    ])

    expect(mapped[0].role).toBe('user')
  })

  it('输入为只读数组也接受（渲染端拿到的是解出来的数组）', () => {
    const source = Object.freeze([
      Object.freeze(stored('user', [{ type: 'text', text: 'q' }]))
    ]) as readonly StoredMessage[]

    expect(mapStoredMessages(source)).toHaveLength(1)
  })
})
