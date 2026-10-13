import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { MessageList } from '@renderer/features/chat/MessageList'
import { createMockTransport } from './mock-transport'
import { nextFrame } from './next-frame'

/**
 * 消息流渲染（Step 1）：
 *   - 纯渲染：user / assistant 两类消息与它们的 text part；
 *   - 流式：mock transport 推三段文本增量 → 消息列逐步呈现（不碰网络）。
 */
function assistantWith(text: string): UIMessage {
  return { id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] }
}

async function renderSession(control: ReturnType<typeof createMockTransport>): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId="thread-list"
        runtime={{ transport: control.transport, loadHistory: async () => [], onTurnEnd: () => {} }}
      />
    </MemoryRouter>
  )
  // Chat 是异步解析的（首次进入先回灌历史），等输入框出现再交互
  await screen.findByTestId('composer-input')
}

/** 在输入框里敲一句话并回车（真实交互路径，不越过 Composer 直接调 sendMessage） */
function typeAndSend(text: string): void {
  const input = screen.getByTestId('composer-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('消息列渲染', () => {
  it('用户消息与助手消息各自成条，文本 part 落在自己的条目里', () => {
    render(
      <MessageList
        messages={[
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我看下这个文件' }] },
          assistantWith('好的，先读一下。')
        ]}
        status="ready"
      />
    )

    const list = screen.getByTestId('message-list')
    expect(list).toHaveTextContent('帮我看下这个文件')
    expect(list).toHaveTextContent('好的，先读一下。')

    expect(screen.getByTestId('message-u1')).toHaveAttribute('data-role', 'user')
    expect(screen.getByTestId('message-a1')).toHaveAttribute('data-role', 'assistant')
  })

  it('空会话：消息列为空，不留提示小字（雷点 2：不靠小字补设计）', () => {
    render(<MessageList messages={[]} status="ready" />)

    const list = screen.getByTestId('message-list')
    expect(list).toBeInTheDocument()
    expect(list).toHaveTextContent('')
  })

  it('用户气泡里的引用标记画成内联 pill（round 14）；底层文本原样保留', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: '用【引用】技能：整理笔记 与【引用】上下文：默认 来做' }]
          }
        ]}
        status="ready"
      />
    )

    const pills = screen.getAllByTestId('message-reference-pill')
    expect(pills.map((pill) => pill.textContent)).toEqual(['技能：整理笔记', '上下文：默认'])
    // round 21（图3）：chip = 图标 + 文本；「【引用】」前缀不进可见层（用户点名的问题）
    for (const pill of pills) {
      expect(pill.querySelector('svg')).not.toBeNull()
      expect(pill).not.toHaveTextContent('【引用】')
    }
    expect(screen.getByTestId('message-u1')).toHaveTextContent(
      '用技能：整理笔记 与上下文：默认 来做'
    )
    expect(screen.getByTestId('message-u1')).not.toHaveTextContent('【引用】')
    // 原文（含前缀）仍在消息数据里：编辑重发/复制路径读的是 message.parts，不受渲染影响
  })

  it('旧「；」合并格式也画 chip（round 7-13 发出的消息不退化；同段多引用并成一个 chip）', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: '【引用】技能：读写文件；插件：回显服务' }]
          }
        ]}
        status="ready"
      />
    )

    const pills = screen.getAllByTestId('message-reference-pill')
    expect(pills.map((pill) => pill.textContent)).toEqual(['技能：读写文件；插件：回显服务'])
  })

  it('没有标记的用户消息：不渲染任何 pill（普通文本路径不变）', () => {
    render(
      <MessageList
        messages={[{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '普通一句' }] }]}
        status="ready"
      />
    )

    expect(screen.queryByTestId('message-reference-pill')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-u1')).toHaveTextContent('普通一句')
  })
})

describe('滚动跟随', () => {
  function withLayout(): HTMLElement {
    const view = screen.getByTestId('message-list')
    Object.defineProperty(view, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(view, 'clientHeight', { value: 400, configurable: true })
    return view
  }

  const first: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: '问' }] }
  const second: UIMessage = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '答' }] }

  it('本来贴在底部：新内容到达（流式增量）就跟着滚到底', () => {
    const { rerender } = render(<MessageList messages={[first]} status="streaming" />)
    const view = withLayout()
    view.scrollTop = 600 // 1000 - 600 - 400 = 0 → 贴底
    fireEvent.scroll(view)

    rerender(<MessageList messages={[first, second]} status="streaming" />)

    expect(view.scrollTop).toBe(1000)
  })

  it('用户向上翻历史时不抢滚动（离底超过阈值就不动了）', () => {
    const { rerender } = render(<MessageList messages={[first]} status="streaming" />)
    const view = withLayout()
    view.scrollTop = 100 // 离底 500 → 用户在看历史
    fireEvent.scroll(view)

    rerender(<MessageList messages={[first, second]} status="streaming" />)

    expect(view.scrollTop).toBe(100)
  })
})

describe('流式逐段呈现（mock transport）', () => {
  it('三段文本增量按到达顺序上屏，最后拼成完整回复', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      typeAndSend('你好')
    })

    // 请求已发出：历史里只有刚发的这条用户消息（服务端无状态，多轮靠客户端全量 messages）
    expect(control.requests).toHaveLength(1)
    expect(control.requests[0].trigger).toBe('submit-message')
    expect(control.requests[0].messages).toHaveLength(1)
    expect(control.requests[0].messages[0]).toMatchObject({ role: 'user' })
    expect(screen.getByTestId('message-list')).toHaveTextContent('你好')

    await act(async () => {
      control.push('（kyclaw 离线模式）')
    })
    // round 73：流式正文按帧上屏（每帧合流一次），推完增量先让出一帧
    await nextFrame()
    const list = screen.getByTestId('message-list')
    expect(list).toHaveTextContent('（kyclaw 离线模式）')
    expect(list).not.toHaveTextContent('我是 kyclaw')

    await act(async () => {
      control.push('你好，')
    })
    await nextFrame()
    expect(list).toHaveTextContent('（kyclaw 离线模式）你好，')
    expect(list).not.toHaveTextContent('我是 kyclaw')

    await act(async () => {
      control.push('我是 kyclaw。')
      control.finish()
    })
    // finish 之后 streaming=false：结束那一拍与 props 同步渲染，不等帧也对
    expect(list).toHaveTextContent('（kyclaw 离线模式）你好，我是 kyclaw。')

    // 流结束后回到可发送态
    expect(screen.getByTestId('composer-send')).toBeInTheDocument()
    expect(screen.queryByTestId('composer-stop')).not.toBeInTheDocument()
  })
})
