import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'
import { MessageList } from '@renderer/features/chat/MessageList'
import { ReasoningPart } from '@renderer/features/chat/parts/ReasoningPart'
import { TextPart } from '@renderer/features/chat/parts/TextPart'

/**
 * Step 3：思考块（reasoning part，模型支持才有）与流式光标。
 * 光标本体是 CSS 伪元素（细竖线 + 呼吸），DOM 侧的契约是 data-streaming 标记；
 * 样式侧契约（2px/呼吸/reduced-motion）在 styles/__tests__/markdown.spec.ts。
 */
describe('思考块（ReasoningPart）', () => {
  it('流式中自动展开；点一下折叠；流结束自动收起', () => {
    const { rerender } = render(<ReasoningPart text="先看文件结构……" streaming />)

    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('先看文件结构……')

    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.queryByTestId('reasoning-text')).not.toBeInTheDocument()
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')

    rerender(<ReasoningPart text="先看文件结构……" streaming={false} />)
    expect(screen.queryByTestId('reasoning-text')).not.toBeInTheDocument()
  })

  it('非流式默认折叠，点开后能看到内容', () => {
    render(<ReasoningPart text="推理内容" />)

    expect(screen.queryByTestId('reasoning-text')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('推理内容')
  })
})

describe('助手消息的 part 组装', () => {
  it('reasoning part → 思考块；text part → 文本（顺序保持）', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '先想一下' },
        { type: 'text', text: '答案在这里' }
      ]
    }
    render(<Message message={message} />)

    expect(screen.getByTestId('reasoning-part')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('先想一下')
    expect(screen.getByTestId('message-text')).toHaveTextContent('答案在这里')
  })

  it('模型没有 reasoning part 时不出现思考块（不假装有）', () => {
    render(
      <Message message={{ id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '直出' }] }} />
    )

    expect(screen.queryByTestId('reasoning-part')).not.toBeInTheDocument()
  })
})

describe('流式光标（细竖线）', () => {
  it('流式中的文本 part 带 data-streaming 标记，流结束去掉', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: '答' }]
    }
    const { rerender } = render(<Message message={message} streaming />)

    expect(screen.getByTestId('message-text')).toHaveAttribute('data-streaming', 'true')

    rerender(<Message message={message} streaming={false} />)
    expect(screen.getByTestId('message-text')).not.toHaveAttribute('data-streaming')
  })

  it('流刚开始、还没有内容时也要有光标（单独出一个）', () => {
    const { rerender } = render(<TextPart text="" streaming />)
    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument()

    // 有内容之后交给 CSS 伪元素跟字尾，不再重复出元素
    rerender(<TextPart text="第一段" streaming />)
    expect(screen.queryByTestId('streaming-cursor')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-text')).toHaveAttribute('data-streaming', 'true')
  })

  it('只有"最后一条助手消息 + status=streaming"才带光标标记', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '问' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '旧答案' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '新答案' }] }
    ]
    const { rerender } = render(<MessageList messages={messages} status="streaming" />)

    expect(screen.getByTestId('message-a2')).toHaveAttribute('data-streaming', 'true')
    expect(screen.getByTestId('message-a1')).not.toHaveAttribute('data-streaming')

    rerender(<MessageList messages={messages} status="ready" />)
    expect(screen.getByTestId('message-a2')).not.toHaveAttribute('data-streaming')
  })
})
