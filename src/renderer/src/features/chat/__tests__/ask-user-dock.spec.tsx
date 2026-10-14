import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AskUserInput } from '@shared/ask-user'
import { AskUserDock, type AskUserDockRequest } from '../AskUserDock'
import { askUserCallKey, createAskUserDraft } from '../ask-user-ui'

const input: AskUserInput = {
  questions: [
    {
      id: 'q',
      header: '方式',
      question: '选择执行方式',
      options: [
        { id: 'a', label: '方式 A', recommended: true },
        { id: 'b', label: '方式 B' }
      ]
    }
  ]
}

function request(overrides: Partial<AskUserDockRequest> = {}): AskUserDockRequest {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    toolCallId: 'call-1',
    input,
    draft: createAskUserDraft(input),
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    ...overrides
  }
}

describe('AskUserDock', () => {
  it('空队列收起且无可聚焦隐藏表单', () => {
    render(<AskUserDock requests={[]} />)
    expect(screen.getByTestId('ask-user-dock')).toHaveAttribute('data-open', 'false')
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('多条待答调用不铺技术标签（无调用编号 / 无调用详情），但每条都仍可访问、区域自身不内滚', () => {
    render(
      <AskUserDock
        requests={[
          request(),
          request({ threadId: 'thread-2', runId: 'run-2', toolCallId: 'call-2' })
        ]}
      />
    )
    expect(screen.getByTestId('ask-user-dock')).toHaveAttribute('data-open', 'true')
    const items = screen.getAllByTestId('ask-user-dock-item')
    expect(items).toHaveLength(2)
    // 可见层只有提问本身：调用序号 / 标签 / 会话·轮次·调用详情都不再出现
    expect(screen.queryByText(/问题调用/)).not.toBeInTheDocument()
    expect(screen.queryByText('调用详情')).not.toBeInTheDocument()
    expect(screen.queryByText(/轮次：/)).not.toBeInTheDocument()
    // 状态没丢：调用身份仍在 data-call-key 与 item 的可访问名里（多条各自可辨、全部可访问）
    expect(items[0]).toHaveAttribute('data-call-key', askUserCallKey(request()))
    expect(items[1]).toHaveAttribute(
      'data-call-key',
      askUserCallKey(
        request({
          threadId: 'thread-2',
          runId: 'run-2',
          toolCallId: 'call-2'
        })
      )
    )
    expect(items[0]).toHaveAccessibleName('待回答的提问：call-1')
    expect(items[1]).toHaveAccessibleName('待回答的提问：call-2')
    for (const item of items) {
      expect(within(item).getByRole('form', { name: '回答问题' })).toBeInTheDocument()
      expect(within(item).getByRole('button', { name: '提交全部回答' })).toBeInTheDocument()
    }
    // 停靠容器自己不再夹高 / 不再是滚动区（当前题自然撑开，放不下交给外层）
    const region = screen.getByRole('region', { name: '待回答的工具调用' })
    expect(region.className).not.toContain('max-h-')
    expect(region.className).not.toContain('overflow-y-auto')
    expect(region.className).not.toContain('overscroll-contain')
    expect(region).not.toHaveAttribute('tabindex')
    expect(region.className).toContain('[overflow-wrap:anywhere]')
  })

  it('相同 toolCallId 在不同 run 中保持独立草稿和回调', () => {
    const first = request({
      draft: { q: { selectedOptionIds: ['a'], otherSelected: false, otherText: '' } }
    })
    const second = request({ runId: 'run-2' })
    render(<AskUserDock requests={[first, second]} />)
    const items = screen.getAllByTestId('ask-user-dock-item')
    expect(items[0]).toHaveAttribute('data-call-key', askUserCallKey(first))
    expect(items[1]).toHaveAttribute('data-call-key', askUserCallKey(second))
    expect(within(items[0]).getByRole('radio', { name: /方式 A/ })).toBeChecked()
    expect(within(items[1]).getByRole('radio', { name: /方式 A/ })).not.toBeChecked()
    expect(
      within(items[0])
        .getByRole('radio', { name: /方式 A/ })
        .getAttribute('name')
    ).not.toBe(
      within(items[1])
        .getByRole('radio', { name: /方式 A/ })
        .getAttribute('name')
    )
    fireEvent.click(within(items[1]).getByRole('radio', { name: '方式 B' }))
    expect(second.onDraftChange).toHaveBeenCalledWith({
      q: { selectedOptionIds: ['b'], otherSelected: false, otherText: '' }
    })
    expect(first.onDraftChange).not.toHaveBeenCalled()
    fireEvent.click(within(items[0]).getByRole('button', { name: '提交全部回答' }))
    expect(first.onSubmit).toHaveBeenCalledWith({
      status: 'answered',
      answers: [{ questionId: 'q', selectedOptionIds: ['a'] }]
    })
    expect(second.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(within(items[1]).getByRole('button', { name: '取消本轮提问' }))
    expect(second.onStop).toHaveBeenCalledTimes(1)
    expect(first.onStop).not.toHaveBeenCalled()
  })

  it('卸载再挂载由外层草稿恢复，组件不持久化也不自动选择推荐', () => {
    const restored = request({
      draft: { q: { selectedOptionIds: [], otherSelected: true, otherText: '保留草稿' } }
    })
    const { rerender } = render(<AskUserDock requests={[restored]} />)
    expect(screen.getByRole('textbox', { name: '其它内容' })).toHaveValue('保留草稿')
    rerender(<AskUserDock requests={[]} />)
    rerender(<AskUserDock requests={[restored]} />)
    expect(screen.getByRole('textbox', { name: '其它内容' })).toHaveValue('保留草稿')
    expect(screen.getByRole('radio', { name: /方式 A/ })).not.toBeChecked()
  })

  it('碰撞分隔符不影响三元组 key，初始草稿每题独立且不预选', () => {
    expect(askUserCallKey({ threadId: 'a::b', runId: 'c', toolCallId: 'd' })).not.toBe(
      askUserCallKey({ threadId: 'a', runId: 'b::c', toolCallId: 'd' })
    )
    const draft = createAskUserDraft({
      questions: [input.questions[0], { ...input.questions[0], id: 'second' }]
    })
    expect(draft.q).toEqual({ selectedOptionIds: [], otherSelected: false, otherText: '' })
    expect(draft.q).not.toBe(draft.second)
  })
})
