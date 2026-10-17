import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { StoredMessage } from '@shared/threads'
import { defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { resetWorkbenchStore } from '@renderer/features/workbench/workbench-store'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { mapStoredMessages } from '@renderer/lib/message-map'
import { deliverablesByTurnTail } from '../deliverable'
import { Message } from '../Message'
import { MessageList } from '../MessageList'

/**
 * 0.1.3 / 014：交付卡整轮汇总到最终交付区。
 *
 * 钉住的口径：
 *   - **不看 deliver 在 part 流里的位置**：后面还有工具 / 正文，卡也落在消息末尾；
 *   - **不嵌过程块**：交付卡不在「使用 N 个工具」里；已完成的 deliver_file 也不再以工具行重复；
 *   - **轮次边界**：连续助手消息算一轮（审批 / ask-user / 计划续跑会追加），只有轮末那条渲染；
 *     用户消息切开轮次；
 *   - **流式 / 历史回读**：deliver 结果一到就落在最终位；回灌后的消息数组走同一套聚合；
 *   - **同路径去重**：同一文件多次交付只留一张卡（字段取最后一次）。
 */
type Part = UIMessage['parts'][number]

function text(value: string): Part {
  return { type: 'text', text: value }
}

function deliver(callId: string, name: string, extra: { size?: number; note?: string } = {}): Part {
  const path = `docs/${name}`
  return {
    type: 'tool-deliver_file',
    toolCallId: callId,
    state: 'output-available',
    input: { path },
    output: {
      path,
      name,
      size: extra.size ?? 10,
      ...(extra.note === undefined ? {} : { note: extra.note })
    }
  } as Part
}

function read(callId: string): Part {
  return {
    type: 'tool-read_file',
    toolCallId: callId,
    state: 'output-available',
    input: { path: 'src/a.ts' },
    output: { content: 'hello' }
  } as Part
}

function user(id: string, value: string): UIMessage {
  return { id, role: 'user', parts: [text(value)] }
}

function assistant(id: string, parts: Part[]): UIMessage {
  return { id, role: 'assistant', parts }
}

function cardNames(container: HTMLElement): string[] {
  return within(container)
    .queryAllByTestId('deliverable-name')
    .map((node) => node.textContent ?? '')
}

beforeEach(() => {
  resetWorkbenchStore()
  const settings = defaultSettings()
  installKyclawBridge(settings)
  useSettingsStore.setState({ settings, loaded: true })
  useSessionsStore.setState({ activeId: 'thread-1', loaded: true })
})

afterEach(() => {
  clearKyclawBridge()
  resetWorkbenchStore()
})

describe('deliverablesByTurnTail：轮次边界与去重', () => {
  it('连续助手消息算一轮，只有轮末那条拿到聚合；用户消息切开轮次', () => {
    const messages = [
      user('u1', '问'),
      assistant('a1', [deliver('d1', '一.md')]),
      assistant('a2', [deliver('d2', '二.md'), text('完')]),
      user('u2', '再问'),
      assistant('a3', [deliver('d3', '三.md')])
    ]

    const groups = deliverablesByTurnTail(messages)
    expect(groups.map((group) => group.map((card) => card.name))).toEqual([
      [],
      [],
      ['一.md', '二.md'],
      [],
      ['三.md']
    ])
  })

  it('同一个 toolCallId 的流式更新：一张卡，字段取最新', () => {
    const groups = deliverablesByTurnTail([
      assistant('a1', [deliver('d1', '同.md', { size: 10 })]),
      assistant('a2', [deliver('d1', '同.md', { size: 20, note: '最新' })])
    ])

    expect(groups[1]).toHaveLength(1)
    expect(groups[1][0]).toMatchObject({ name: '同.md', size: 20, note: '最新' })
  })

  it('同一路径的两个独立调用：两张卡都保留（多工作区同名不合并）', () => {
    const groups = deliverablesByTurnTail([
      assistant('a1', [deliver('d1', '同.md', { size: 10 })]),
      assistant('a2', [deliver('d2', '同.md', { size: 20 })])
    ])

    expect(groups[1]).toHaveLength(2)
    expect(groups[1].map((card) => card.size)).toEqual([10, 20])
  })
})

describe('Message：交付卡落在消息末尾的最终交付区', () => {
  it('deliver 后面还有工具与正文：卡仍在末尾，且不在过程块里', () => {
    render(
      <Message
        message={assistant('a1', [
          text('开始'),
          deliver('d1', '甲.pptx'),
          read('r1'),
          text('中间'),
          deliver('d2', '乙.pptx'),
          text('结束')
        ])}
      />
    )

    const article = screen.getByTestId('message-a1')
    expect(cardNames(article)).toEqual(['甲.pptx', '乙.pptx'])

    const area = within(article).getByTestId('message-deliverables')
    for (const card of within(article).getAllByTestId('deliverable-card')) {
      expect(area).toContainElement(card)
      expect(card.closest('[data-testid="trace-block"]')).toBeNull()
    }

    // 最后一段正文在最终交付区之前（卡确实是整条消息的末尾，不是被夹在中间）
    const lastText = within(article).getAllByTestId('message-text').at(-1)
    expect(lastText).toBeDefined()
    expect(
      (lastText as HTMLElement).compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // 过程块只数真正的过程工具（read）；已完成的 deliver 不再作为工具行重复出现
    const traces = within(article).getAllByTestId('trace-block')
    expect(traces).toHaveLength(1)
    expect(within(traces[0]).getByTestId('trace-toggle')).toHaveTextContent('使用 1 个工具')
  })

  it('流式中 deliver 已出结果：卡当场在最终位，后续过程 part 不会把它挤回中间', () => {
    render(
      <Message
        streaming
        message={assistant('a1', [
          text('开始'),
          deliver('d1', '甲.pptx'),
          {
            type: 'tool-read_file',
            toolCallId: 'r1',
            state: 'input-available',
            input: { path: 'src/a.ts' }
          } as Part
        ])}
      />
    )

    const article = screen.getByTestId('message-a1')
    const card = within(article).getByTestId('deliverable-card')
    expect(card.closest('[data-testid="trace-block"]')).toBeNull()
    expect(within(article).getByTestId('message-deliverables')).toContainElement(card)
  })
})

describe('Message：无可见内容不占位（014 收尾）', () => {
  it('非轮末只有已完成 deliver：MessageList 里不再留下空 article，卡仍在轮末', () => {
    render(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [deliver('d1', '一.md')]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )

    expect(screen.queryByTestId('message-a1')).not.toBeInTheDocument()
    expect(cardNames(screen.getByTestId('message-a2'))).toEqual(['一.md'])
    expect(screen.getAllByTestId('message-a2')).toHaveLength(1)
  })

  it('非轮末 deliver + 正文：正文照常显示（卡仍去轮末，不把整条消息误藏）', () => {
    render(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [text('中间说明'), deliver('d1', '一.md')]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )

    expect(screen.getByTestId('message-a1')).toHaveTextContent('中间说明')
    expect(
      within(screen.getByTestId('message-a1')).queryAllByTestId('deliverable-card')
    ).toHaveLength(0)
    expect(cardNames(screen.getByTestId('message-a2'))).toEqual(['一.md'])
  })

  it('没有已交付内容的空助手壳保持原有行为（不扩大删除面）', () => {
    render(<Message message={assistant('a1', [{ type: 'step-start' }])} />)
    expect(screen.getByTestId('message-a1')).toBeInTheDocument()
  })

  it('非轮末 deliver + 失败 deliver：失败工具行保留，消息不藏', () => {
    render(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [
            deliver('d1', '一.md'),
            {
              type: 'tool-deliver_file',
              toolCallId: 'd2',
              state: 'output-error',
              input: { path: 'docs/二.md' },
              errorText: '磁盘已满'
            } as Part
          ]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )

    const first = screen.getByTestId('message-a1')
    expect(first).toBeInTheDocument()
    expect(within(first).getByTestId('trace-block')).toBeInTheDocument()
    expect(cardNames(screen.getByTestId('message-a2'))).toEqual(['一.md'])
  })

  it('非轮末 deliver + 等待审批 / 非空 / 空思考 / 未知或 malformed 工具：照常渲染', () => {
    const { rerender } = render(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [
            deliver('d1', '一.md'),
            {
              type: 'tool-deliver_file',
              toolCallId: 'd2',
              state: 'approval-requested',
              input: { path: 'docs/二.md' },
              approval: { id: 'approval-1' }
            } as Part
          ]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )
    expect(screen.getByTestId('message-a1')).toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [deliver('d1', '一.md'), { type: 'reasoning', text: '想一下' } as Part]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )
    expect(screen.getByTestId('message-a1')).toBeInTheDocument()

    // 空 reasoning 也会让 chunkParts 建出过程块（ReasoningPart 有「思考过程」入口）：
    // 按实际渲染口径算可见，不能把它和 deliver 一起藏掉。
    rerender(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [deliver('d1', '一.md'), { type: 'reasoning', text: '  ' } as Part]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )
    expect(screen.getByTestId('message-a1')).toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [
            deliver('d1', '一.md'),
            {
              type: 'tool-mystery',
              toolCallId: 'm1',
              state: 'input-available',
              input: { anything: true }
            } as Part
          ]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )
    expect(screen.getByTestId('message-a1')).toBeInTheDocument()
    expect(within(screen.getByTestId('message-a1')).getByTestId('trace-block')).toBeInTheDocument()

    // malformed dynamic-tool（缺 toolName）虽然 body 行渲染不出来，但 TraceBlock 头部仍会
    // 显示「使用 1 个工具」——同样按实际渲染口径算可见，不藏。
    rerender(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [
            deliver('d1', '一.md'),
            {
              type: 'dynamic-tool',
              toolCallId: 'm2',
              state: 'input-available',
              input: { anything: true }
            } as Part
          ]),
          assistant('a2', [text('最终说明')])
        ]}
        status="ready"
      />
    )
    expect(screen.getByTestId('message-a1')).toBeInTheDocument()
    expect(within(screen.getByTestId('message-a1')).getByTestId('trace-block')).toBeInTheDocument()
  })

  it('流式中空正文还有光标：正在开始的这一条不被藏掉', () => {
    render(<Message streaming message={assistant('a1', [{ type: 'text', text: '' }])} />)

    expect(screen.getByTestId('message-a1')).toBeInTheDocument()
    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument()
  })
})

describe('MessageList：多 assistant 消息与历史回读', () => {
  it('同轮同路径两个独立交付：组件层两张卡都保留（key 不撞）', () => {
    render(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [deliver('d1', '同.md'), deliver('d2', '同.md'), text('最终说明')])
        ]}
        status="ready"
      />
    )

    expect(screen.getAllByTestId('deliverable-card')).toHaveLength(2)
    expect(cardNames(screen.getByTestId('message-a1'))).toEqual(['同.md', '同.md'])
  })

  it('同一轮两条助手消息：卡从第一条挪到轮末那条，只出现一次', () => {
    render(
      <MessageList
        messages={[
          user('u1', '问'),
          assistant('a1', [deliver('d1', '一.md')]),
          assistant('a2', [deliver('d2', '二.md'), text('最终说明')])
        ]}
        status="ready"
      />
    )

    // 第一条只有已完成交付、没有别的可见内容：不占位（卡已在轮末）
    expect(screen.queryByTestId('message-a1')).not.toBeInTheDocument()
    expect(cardNames(screen.getByTestId('message-a2'))).toEqual(['一.md', '二.md'])
    // 整页只有一组卡（没有重复渲染）
    expect(screen.getAllByTestId('deliverable-card')).toHaveLength(2)
  })

  it('用户消息是轮次边界：两轮各自在自己的轮末出一条卡', () => {
    render(
      <MessageList
        messages={[
          user('u1', '第一问'),
          assistant('a1', [deliver('d1', '一.md'), text('第一轮完')]),
          user('u2', '第二问'),
          assistant('a2', [deliver('d2', '二.md'), text('第二轮完')])
        ]}
        status="ready"
      />
    )

    expect(cardNames(screen.getByTestId('message-a1'))).toEqual(['一.md'])
    expect(cardNames(screen.getByTestId('message-a2'))).toEqual(['二.md'])
  })

  it('历史回读（message-map 的 tool-invocation result）：与实时流同一套聚合', () => {
    const stored: StoredMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: '问' }] }
      },
      {
        id: 'a1',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            { type: 'text', text: '先交一版' },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'result',
                toolCallId: 'd1',
                toolName: 'deliver_file',
                args: { path: 'docs/一.md' },
                result: { path: 'docs/一.md', name: '一.md', size: 10 }
              }
            }
          ]
        }
      },
      {
        id: 'a2',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'result',
                toolCallId: 'd2',
                toolName: 'deliver_file',
                args: { path: 'docs/二.md' },
                result: { path: 'docs/二.md', name: '二.md', size: 20 }
              }
            },
            { type: 'text', text: '最终' }
          ]
        }
      }
    ] as StoredMessage[]

    render(<MessageList messages={mapStoredMessages(stored)} status="ready" />)

    expect(
      within(screen.getByTestId('message-a1')).queryAllByTestId('deliverable-card')
    ).toHaveLength(0)
    expect(cardNames(screen.getByTestId('message-a2'))).toEqual(['一.md', '二.md'])
  })
})
