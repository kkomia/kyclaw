import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'
import { ToolCard } from '@renderer/features/chat/parts/ToolCard'

/**
 * 工具卡（T7 起静态状态渲染；T13 补齐状态机的逐档渲染）。
 * 状态取自 AI SDK 的 tool part 状态机（spec §7.1）。
 */
describe('ToolCard 静态状态', () => {
  it('input-streaming：参数还在流进来', () => {
    render(<ToolCard part={{ toolName: 'read', state: 'input-streaming' }} />)

    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'input-streaming')
    expect(screen.getByTestId('tool-card')).toHaveTextContent('read')
    expect(screen.getByTestId('tool-state')).toHaveTextContent('准备参数')
  })

  it('input-available：参数齐了、正在调用', () => {
    render(<ToolCard part={{ toolName: 'write', state: 'input-available' }} />)

    expect(screen.getByTestId('tool-state')).toHaveTextContent('调用中')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'pending')
  })

  it('审批两档：等待审批 / 审批已回应（等待语义，语气签是"警告"）', () => {
    const { unmount } = render(
      <ToolCard part={{ toolName: 'write', state: 'approval-requested' }} />
    )
    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'waiting')
    unmount()

    render(<ToolCard part={{ toolName: 'write', state: 'approval-responded' }} />)
    expect(screen.getByTestId('tool-state')).toHaveTextContent('审批已回应')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'waiting')
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
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'pending')
    expect(screen.getByTestId('tool-input')).toHaveTextContent('a.txt')
    expect(screen.getByTestId('tool-output')).toHaveTextContent('文件内容')
  })

  it('output-error：展示错误文本（危险语气）', () => {
    render(
      <ToolCard
        part={{ toolName: 'write', state: 'output-error', errorText: '工作区外路径被拒绝' }}
      />
    )

    expect(screen.getByTestId('tool-state')).toHaveTextContent('出错')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'error')
    expect(screen.getByTestId('tool-output')).toHaveTextContent('工作区外路径被拒绝')
  })

  it('output-denied：用户拒绝后这一档（危险语气，不显示输出）', () => {
    render(
      <ToolCard part={{ toolName: 'write', state: 'output-denied', input: { path: 'b.txt' } }} />
    )

    expect(screen.getByTestId('tool-state')).toHaveTextContent('已拒绝')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'error')
    expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()
  })

  it('未知状态原样显示、按中性语气渲染（不猜）', () => {
    render(<ToolCard part={{ toolName: 'mcp__x__y', state: 'some-future-state' }} />)

    expect(screen.getByTestId('tool-state')).toHaveTextContent('some-future-state')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'pending')
  })

  it('审批类状态只做静态呈现：卡内没有按钮（交互在 ApprovalCard）', () => {
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

  it('approval-requested 的 part：接了决策回调就渲染审批卡，决策从 part 里读', () => {
    const message = {
      id: 'a2',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write',
          toolCallId: 'c2',
          state: 'approval-requested',
          input: { path: 'a.txt', content: '内容' },
          approval: { id: 'run-1::c2' }
        }
      ]
    } as unknown as UIMessage
    const onApprovalDecision = vi.fn()

    render(
      <Message
        message={message}
        workspaces={[{ path: 'D:\\ws', mode: 'ask' }]}
        onApprovalDecision={onApprovalDecision}
      />
    )

    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-tool', 'write')
    expect(screen.getByTestId('approval-allow-once')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('approval-allow-forever'))
    expect(onApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'run-1::c2', toolCallId: 'c2', toolName: 'write' }),
      'forever'
    )
  })

  it('没接决策回调：审批中也退回静态工具卡（不给点了没用的按钮）', () => {
    const message = {
      id: 'a3',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write',
          toolCallId: 'c3',
          state: 'approval-requested',
          input: { path: 'a.txt', content: '内容' },
          approval: { id: 'run-1::c3' }
        }
      ]
    } as unknown as UIMessage

    render(<Message message={message} />)

    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'approval-requested')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
