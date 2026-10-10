import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'
import { ToolCard } from '@renderer/features/chat/parts/ToolCard'

/**
 * 工具卡（T7 只做静态状态渲染：审批与重试交互在 T12/T13）。
 * 状态取自 AI SDK 的 tool part 状态机。
 */
describe('ToolCard 静态状态', () => {
  it('input-streaming：参数还在流进来', () => {
    render(<ToolCard part={{ toolName: 'read', state: 'input-streaming' }} />)

    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'input-streaming')
    expect(screen.getByTestId('tool-card')).toHaveTextContent('read')
    expect(screen.getByTestId('tool-state')).toHaveTextContent('准备参数')
  })

  it('output-available：展示入参与结果', () => {
    render(
      <ToolCard
        part={{
          toolName: 'read',
          state: 'output-available',
          input: { path: 'a.txt' },
          output: '文件内容'
        }}
      />
    )

    expect(screen.getByTestId('tool-state')).toHaveTextContent('已完成')
    expect(screen.getByTestId('tool-input')).toHaveTextContent('a.txt')
    expect(screen.getByTestId('tool-output')).toHaveTextContent('文件内容')
  })

  it('output-error：展示错误文本', () => {
    render(
      <ToolCard
        part={{ toolName: 'write', state: 'output-error', errorText: '工作区外路径被拒绝' }}
      />
    )

    expect(screen.getByTestId('tool-state')).toHaveTextContent('出错')
    expect(screen.getByTestId('tool-output')).toHaveTextContent('工作区外路径被拒绝')
  })

  it('审批类状态只做静态呈现（本轮不给审批交互）', () => {
    render(<ToolCard part={{ toolName: 'write', state: 'approval-requested' }} />)

    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('助手消息里的工具 part', () => {
  it('tool-* part 渲染成工具卡，文本 part 照旧', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: '先读文件：' },
        {
          type: 'tool-read',
          toolCallId: 'c1',
          state: 'output-available',
          input: { path: 'a.txt' },
          output: '内容'
        }
      ]
    } as unknown as UIMessage

    render(<Message message={message} />)

    expect(screen.getByTestId('message-text')).toHaveTextContent('先读文件：')
    const card = screen.getByTestId('tool-card')
    expect(card).toHaveAttribute('data-tool', 'read')
    expect(card).toHaveTextContent('已完成')
  })
})
