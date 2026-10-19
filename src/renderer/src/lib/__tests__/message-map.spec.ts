import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { StoredMessage } from '@shared/threads'
import { mapStoredMessages } from '../message-map'
import { MESSAGE_CONTEXT_KEY, SENT_AT_KEY } from '@shared/message-context'

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

  it('被拒绝的调用（T13）按"已拒绝"回放：形状就是存储里的真身（含 approval）', () => {
    // 样本抄自实机库（%APPDATA%/kyclaw.db）：T11 的审批流把拒绝存成 state='output-denied' + approval
    const [message] = mapStoredMessages([
      stored('assistant', [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'output-denied',
            toolCallId: 'call-denied',
            toolName: 'write',
            args: { path: 'rejected.txt', content: 'x\n' },
            approval: { id: 'run-1::call-denied', approved: false, reason: '用户拒绝了这次操作' },
            updatedAt: 1791641475362
          }
        }
      ])
    ])

    expect(message.parts).toEqual([
      {
        type: 'tool-write',
        toolCallId: 'call-denied',
        state: 'output-denied',
        input: { path: 'rejected.txt', content: 'x\n' },
        approval: { id: 'run-1::call-denied', approved: false, reason: '用户拒绝了这次操作' }
      }
    ])
  })

  it('拒绝态缺 approval.id 时用 toolCallId 兜底（v7 的 output-denied part 要求有 id）', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'output-denied',
            toolCallId: 'call-bare',
            toolName: 'edit',
            args: { path: 'a.txt' }
          }
        }
      ])
    ])

    expect(message.parts[0]).toMatchObject({
      state: 'output-denied',
      approval: { id: 'call-bare', approved: false }
    })
  })

  it('没带挂起登记（metadata.pendingToolApprovals）的 call：仍按"进行中"回放，不冒充可审批', () => {
    const [message] = mapStoredMessages([
      stored('assistant', [
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'call',
            toolCallId: 'call-pending',
            toolName: 'write',
            args: { path: 'a.txt', content: 'x' }
          }
        }
      ])
    ])

    expect(message.parts[0]).toMatchObject({ state: 'input-available' })
  })

  it('挂起等审批（call + metadata.pendingToolApprovals）：回放成 approval-requested，审批 id 按服务端口径复原', () => {
    const [message] = mapStoredMessages([
      {
        id: 'assistant-hang',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            { type: 'reasoning', reasoning: '先看看环境' },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'call',
                toolCallId: 'call_01_bash',
                toolName: 'bash',
                args: { command: 'pwd && ls -la' }
              }
            }
          ],
          metadata: {
            pendingToolApprovals: {
              call_01_bash: {
                toolCallId: 'call_01_bash',
                toolName: 'bash',
                args: { command: 'pwd && ls -la' },
                type: 'approval',
                runId: '8fa31d12-7f0f-45af-8d9b-4c93acc04ee3',
                resumeSchema: '{"type":"object"}'
              }
            }
          }
        }
      } as StoredMessage
    ])

    expect(message.parts[1]).toEqual({
      type: 'tool-bash',
      toolCallId: 'call_01_bash',
      state: 'approval-requested',
      input: { command: 'pwd && ls -la' },
      approval: { id: '8fa31d12-7f0f-45af-8d9b-4c93acc04ee3::call_01_bash' }
    })
  })

  it('同一步多个挂起审批：各自复原（两个 bash 都要用户决策）', () => {
    const [message] = mapStoredMessages([
      {
        id: 'assistant-hang-2',
        role: 'assistant',
        content: {
          format: 2,
          parts: ['call_a', 'call_b'].map((toolCallId) => ({
            type: 'tool-invocation',
            toolInvocation: { state: 'call', toolCallId, toolName: 'bash', args: { command: 'ls' } }
          })),
          metadata: {
            pendingToolApprovals: {
              call_a: { toolCallId: 'call_a', runId: 'run-9', type: 'approval' },
              call_b: { toolCallId: 'call_b', runId: 'run-9', type: 'approval' }
            }
          }
        }
      } as StoredMessage
    ])

    expect(message.parts.map((part) => (part as { state?: string }).state)).toEqual([
      'approval-requested',
      'approval-requested'
    ])
  })

  it('挂起登记是脏数据（缺 runId / 不是对象）：落回"进行中"，不抛、不冒充可审批', () => {
    const [message] = mapStoredMessages([
      {
        id: 'assistant-dirty',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: { state: 'call', toolCallId: 'call_x', toolName: 'bash', args: {} }
            }
          ],
          metadata: { pendingToolApprovals: { call_x: { toolCallId: 'call_x' } } as unknown }
        }
      } as StoredMessage
    ])

    expect(message.parts[0]).toMatchObject({ state: 'input-available' })
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

describe('0.1.3 / 006 + 008：展示上下文与发送时刻的回读', () => {
  /** 与写侧同一份形状（真链路落库回读的形状由 message-context-wire.spec.ts 钉住） */
  const context = {
    v: 1,
    entries: [
      {
        kind: 'file',
        name: 'note.md',
        size: 12,
        source: 'note.md',
        append: {
          length: 27,
          join: 2,
          head: '【附件】note.md\n```\n第一行\n第二行\n```',
          tail: '【附件】note.md\n```\n第一行\n第二行\n```',
          sha256: 'a'.repeat(64)
        }
      }
    ]
  }

  function storedUser(metadata: unknown, createdAt?: unknown): StoredMessage {
    return {
      id: 'u1',
      role: 'user',
      ...(createdAt === undefined ? {} : { createdAt }),
      content: { format: 2, parts: [{ type: 'text', text: '看这个' }], metadata }
    } as StoredMessage
  }

  it('content.metadata.kyclawContext 原样回挂（严格校验过的那一份）', () => {
    const [mapped] = mapStoredMessages([storedUser({ [MESSAGE_CONTEXT_KEY]: context })])
    expect((mapped.metadata as Record<string, unknown>)[MESSAGE_CONTEXT_KEY]).toEqual(context)
  })

  it('不合规的展示上下文不挂（坏数据 → 气泡按原文显示）', () => {
    const [mapped] = mapStoredMessages([
      storedUser({ [MESSAGE_CONTEXT_KEY]: { ...context, v: 99 } })
    ])
    expect(mapped.metadata).toBeUndefined()
  })

  it('顶层 createdAt（存储自己落的记录时间）当兜底：没有别人的时候用它', () => {
    // 顶层 = 存储落库时刻（ISO 串）；part 与 metadata 上都没有时间 → 用它（exact 由读侧判）
    const [onlyTop] = mapStoredMessages([storedUser(undefined, '2026-10-16T06:05:30.000Z')])
    expect(onlyTop.metadata).toEqual({ createdAt: Date.parse('2026-10-16T06:05:30.000Z') })

    // part 上更晚 → 取 part 最大值（round 59 口径）
    const both = {
      id: 'u2',
      role: 'user',
      createdAt: new Date('2026-10-16T06:00:00.000Z'),
      content: {
        format: 2,
        parts: [{ type: 'text', text: '正文', createdAt: Date.parse('2026-10-16T06:05:30.000Z') }]
      }
    } as unknown as StoredMessage
    const [mapped] = mapStoredMessages([both])
    expect((mapped.metadata as { createdAt?: unknown }).createdAt).toBe(
      Date.parse('2026-10-16T06:05:30.000Z')
    )

    // 顶层是脏数据（不是时间）→ 不看它，回落到 part 时间
    const [dirty] = mapStoredMessages([storedUser(undefined, '不是时间')])
    expect(dirty.metadata).toBeUndefined()
  })

  it('自有时间键（kyclawSentAt）优先：数字锚点 + 原值透传（精确发送时刻）', () => {
    const iso = '2026-10-16T06:05:30.123Z'
    const [mapped] = mapStoredMessages([
      storedUser({ [SENT_AT_KEY]: iso, createdAt: '2026-10-16T06:05:29.000Z' }, iso)
    ])
    const metadata = mapped.metadata as Record<string, unknown>
    // 数字锚点用我们写的那一份（不是服务端落库时刻）
    expect(metadata.createdAt).toBe(Date.parse(iso))
    // 精确时刻原值透传（读侧 readSentAt 据此标 exact）
    expect(metadata[SENT_AT_KEY]).toBe(iso)
  })

  it('自有时间键是脏数据：不挂它，锚点回落到别的来源', () => {
    const [mapped] = mapStoredMessages([
      storedUser({ [SENT_AT_KEY]: '不是时间' }, '2026-10-16T06:05:30.000Z')
    ])
    const metadata = mapped.metadata as Record<string, unknown>
    expect(metadata[SENT_AT_KEY]).toBeUndefined()
    expect(metadata.createdAt).toBe(Date.parse('2026-10-16T06:05:30.000Z'))
  })

  it('时间与上下文同时存在：都挂（互不挤占）', () => {
    const [mapped] = mapStoredMessages([
      storedUser({ [MESSAGE_CONTEXT_KEY]: context }, '2026-10-16T06:05:30.000Z')
    ])
    expect(mapped.metadata).toEqual({
      createdAt: Date.parse('2026-10-16T06:05:30.000Z'),
      [MESSAGE_CONTEXT_KEY]: context
    })
  })

  it('超体量预算的展示上下文不挂（时间照旧挂上）', () => {
    const oversized = {
      v: 1,
      entries: Array.from({ length: 20 }, (_, index) => ({
        kind: 'file' as const,
        name: `f${index}.txt`,
        size: 1,
        source: 'x'.repeat(1024)
      }))
    }
    const [mapped] = mapStoredMessages([
      storedUser({ [MESSAGE_CONTEXT_KEY]: oversized }, '2026-10-16T06:05:30.000Z')
    ])
    const metadata = mapped.metadata as Record<string, unknown>
    expect(metadata[MESSAGE_CONTEXT_KEY]).toBeUndefined()
    expect(metadata.createdAt).toBe(Date.parse('2026-10-16T06:05:30.000Z'))
  })

  it('PB-037：content.metadata.turnFailure 原样透传到 UIMessage.metadata（坏形状丢弃）', () => {
    const [good] = mapStoredMessages([
      storedUser({ turnFailure: { turn: 4, kind: 'error', code: 'E1', message: '失败了' } })
    ])
    expect((good.metadata as Record<string, unknown>).turnFailure).toEqual({
      turn: 4,
      kind: 'error',
      code: 'E1',
      message: '失败了'
    })

    const [bad] = mapStoredMessages([storedUser({ turnFailure: { kind: 'completed', turn: 4 } })])
    expect((bad.metadata as Record<string, unknown> | undefined)?.turnFailure).toBeUndefined()
  })
})
