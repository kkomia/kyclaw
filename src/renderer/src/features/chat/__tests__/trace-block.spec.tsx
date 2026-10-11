import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'

/**
 * 过程块（TraceBlock）的开合策略与分块（round 6，对照《对话UI-工具链与显示口径 v0.1》§0.3 #1/§1.3；
 * round 29 修订）：
 *   - 进行中展开（full）、这一轮跑完自动收起、用户手动点过听用户的；
 *   - round 29：块里不再有审批按钮（审批搬到输入框上方的审批条），**待审批不再锁死折叠** ——
 *     走"默认展开"这一档、箭头照画、点一下能收；
 *   - 流式期间块内的思考段保持展开（工具行到达不让它自动收起，见"思考可见"）；
 *   - 开合不持久化：只活在组件内存里（rerender 换一条消息就是新块）。
 */
function assistantMessage(parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts } as unknown as UIMessage
}

const READ_PART = {
  type: 'tool-read',
  toolCallId: 'c1',
  state: 'output-available',
  input: { path: 'a.txt' },
  output: '内容'
}

describe('进行中展开 → 跑完自动收起 → 手动点过听用户的', () => {
  it('streaming 时打开；跑完自动收起', () => {
    const message = assistantMessage([READ_PART])
    const { rerender } = render(<Message message={message} streaming />)

    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('trace-toggle')).toHaveAttribute('aria-expanded', 'true')

    rerender(<Message message={message} streaming={false} />)
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('trace-toggle')).toHaveAttribute('aria-expanded', 'false')
    // 开过一次 → 行留在 DOM（grid-rows 收起）
    expect(screen.getByTestId('tool-card')).toBeInTheDocument()
  })

  it('用户手动开过：跑完也不收（override 优先于自动档）', () => {
    const message = assistantMessage([READ_PART])
    const { rerender } = render(<Message message={message} streaming />)

    fireEvent.click(screen.getByTestId('trace-toggle')) // 手动收
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
    rerender(<Message message={message} streaming={false} />)
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByTestId('trace-toggle')) // 手动开
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
    rerender(<Message message={message} streaming />)
    rerender(<Message message={message} streaming={false} />)
    // 手动开过 → 这一轮跑完仍保持开
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
  })
})

describe('待审批：默认展开但可收，且块内没有审批按钮（round 29）', () => {
  const approvalMessage = assistantMessage([
    {
      type: 'tool-write',
      toolCallId: 'c2',
      state: 'approval-requested',
      input: { path: 'a.txt', content: '内容' },
      approval: { id: 'run-1::c2' }
    }
  ])

  it('挂起轮（不是 streaming）也默认展开，只画只读的「等待审批」行，不给任何按钮', () => {
    render(<Message message={approvalMessage} />)

    const block = screen.getByTestId('trace-block')
    expect(block).toHaveAttribute('data-open', 'true')
    expect(block).toHaveAttribute('data-pending', 'true')
    // 只读状态行：状态签在、行本身可展开看入参，但没有任何决策按钮
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'approval-requested')
    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-once')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-deny')).not.toBeInTheDocument()
  })

  it('不再锁死折叠：箭头照画、点一下能收起（用户不该被锁住）', () => {
    render(<Message message={approvalMessage} />)

    const block = screen.getByTestId('trace-block')
    const toggle = screen.getByTestId('trace-toggle')
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle).not.toHaveAttribute('aria-disabled')

    fireEvent.click(toggle)
    expect(block).toHaveAttribute('data-open', 'false')
  })
})

describe('思考可见（round 29：工具调用前不许"工具挨工具"裸奔）', () => {
  it('流式期间：思考段后面跟了工具行也保持展开（思考段自己已不是"最后一条"）', () => {
    render(
      <Message
        message={assistantMessage([
          { type: 'reasoning', text: '先看看目录结构' },
          {
            type: 'tool-read',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: 'ok'
          }
        ])}
        streaming
      />
    )

    const reasoning = screen.getByTestId('reasoning-toggle')
    expect(reasoning).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('先看看目录结构')
    // 标签仍是"思考过程"而不是"思考中…"——正在写的已经不是它了，只是这一轮还没跑完
    expect(reasoning).toHaveTextContent('思考过程')
  })

  it('多步：第二段思考到达即展开（同一块内两段都在）', () => {
    render(
      <Message
        message={assistantMessage([
          { type: 'reasoning', text: '第一段' },
          {
            type: 'tool-read',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: 'ok'
          },
          { type: 'reasoning', text: '第二段' },
          { type: 'tool-grep', toolCallId: 'c2', state: 'input-available', input: { pattern: 'x' } }
        ])}
        streaming
      />
    )

    expect(
      screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
    ).toEqual(['true', 'true'])
    expect(screen.getAllByTestId('reasoning-text').map((node) => node.textContent)).toEqual([
      '第一段',
      '第二段'
    ])
  })

  it('这一轮跑完：块收起（思考段随之不可见，点开仍看得到）', () => {
    const message = assistantMessage([
      { type: 'reasoning', text: '想完了' },
      { type: 'tool-read', toolCallId: 'c1', state: 'output-available', input: {}, output: 'ok' }
    ])
    const { rerender } = render(<Message message={message} streaming />)
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')

    rerender(<Message message={message} streaming={false} />)
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('想完了')
  })
})

describe('分块与总名', () => {
  it('总名 = 使用 N 个工具（N = 工具 part 数；思考不算）', () => {
    render(
      <Message
        message={assistantMessage([
          { type: 'reasoning', text: '先想一下' },
          READ_PART,
          { type: 'tool-grep', toolCallId: 'c2', state: 'input-available', input: { pattern: 'x' } }
        ])}
      />
    )

    expect(screen.getByTestId('trace-toggle')).toHaveTextContent('使用 2 个工具')
  })

  it('正文把过程 run 切开：两条文本之间是两个过程块', () => {
    render(
      <Message
        message={assistantMessage([
          READ_PART,
          { type: 'text', text: '读完了。' },
          {
            type: 'tool-write',
            toolCallId: 'c9',
            state: 'output-available',
            input: { path: 'b' },
            output: 'ok'
          }
        ])}
      />
    )

    expect(screen.getAllByTestId('trace-block')).toHaveLength(2)
    expect(screen.getAllByTestId('trace-toggle').map((node) => node.textContent)).toEqual([
      '使用 1 个工具',
      '使用 1 个工具'
    ])
  })

  it('只有思考、没有工具：不出现过程块，思考块直接出', () => {
    render(<Message message={assistantMessage([{ type: 'reasoning', text: '只想不做' }])} />)

    expect(screen.queryByTestId('trace-block')).not.toBeInTheDocument()
    expect(screen.getByTestId('reasoning-part')).toBeInTheDocument()
  })

  it('块内的思考行：跑完自动收起；点开后看得到推理文本', () => {
    render(
      <Message message={assistantMessage([{ type: 'reasoning', text: '推理内容' }, READ_PART])} />
    )

    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('推理内容')
  })
})
