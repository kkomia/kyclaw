import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'

/**
 * 过程块（TraceBlock）的开合策略与分块（round 6，对照《对话UI-工具链与显示口径 v0.1》§0.3 #1/§1.3）：
 *   - 进行中展开（full）、这一轮跑完自动收起、用户手动点过听用户的；
 *   - 有待审批步骤：强制展开、头部不画箭头、点它也不收；
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

describe('待审批强制展开（且不画箭头）', () => {
  const approvalMessage = assistantMessage([
    {
      type: 'tool-write',
      toolCallId: 'c2',
      state: 'approval-requested',
      input: { path: 'a.txt', content: '内容' },
      approval: { id: 'run-1::c2' }
    }
  ])

  it('挂起轮（不是 streaming）也强制展开；头部无箭头、点了也不收；决策回调照旧透传', () => {
    const onApprovalDecision = vi.fn()
    render(
      <Message
        message={approvalMessage}
        workspaces={[{ path: 'D:\\ws', mode: 'ask' }]}
        onApprovalDecision={onApprovalDecision}
      />
    )

    const block = screen.getByTestId('trace-block')
    expect(block).toHaveAttribute('data-open', 'true')
    const toggle = screen.getByTestId('trace-toggle')
    expect(toggle).toHaveAttribute('data-forced', 'approval')
    expect(toggle.querySelector('svg')).toBeNull()

    fireEvent.click(toggle)
    expect(block).toHaveAttribute('data-open', 'true')

    fireEvent.click(screen.getByTestId('approval-allow-once'))
    expect(onApprovalDecision).toHaveBeenCalledTimes(1)
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
