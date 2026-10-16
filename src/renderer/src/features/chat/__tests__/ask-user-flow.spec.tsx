import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '../ChatPage'
import { resetThreadChats } from '../thread-chats'
import { resetAskUserStore, useAskUserStore } from '../ask-user-store'
import { createMockTransport } from './mock-transport'
import { installKyclawBridge, clearKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'

const api = vi.hoisted(() => ({ pending: vi.fn(), cancel: vi.fn() }))
vi.mock('@renderer/lib/ask-user-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/ask-user-api')>()),
  fetchPendingAskUser: api.pending,
  cancelAskUser: api.cancel
}))
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(),
  truncateThread: vi.fn(),
  createThread: vi.fn(),
  generateThreadTitle: vi.fn()
}))
const input = {
  questions: [
    {
      id: '__proto__',
      header: '格式',
      question: '请选择格式',
      options: [
        { id: 'a', label: '格式 A' },
        { id: 'b', label: '格式 B' }
      ]
    }
  ]
}
const pending = { runId: 'run', toolCallId: 'ask', input, suspendedAt: '2026-10-14T00:00:00Z' }
const history: UIMessage[] = [
  { id: 'user', role: 'user', parts: [{ type: 'text', text: '生成报告' }] },
  {
    id: 'assistant',
    role: 'assistant',
    parts: [{ type: 'tool-ask_user', toolCallId: 'ask', state: 'input-available', input }]
  }
]
beforeEach(() => {
  resetThreadChats()
  resetAskUserStore()
  vi.clearAllMocks()
  const settings = defaultSettings()
  installKyclawBridge(settings)
  useSettingsStore.setState({ settings, loaded: true })
  useSessionsStore.setState({ queues: {}, threads: [], activeId: 'thread' })
  api.pending.mockResolvedValue([pending])
  api.cancel.mockResolvedValue(['run'])
})
afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})
function mount(messages = history): ReturnType<typeof createMockTransport> {
  const control = createMockTransport()
  render(
    <MemoryRouter>
      <ChatSession
        threadId="thread"
        transport={control.transport}
        runtime={{
          transport: control.transport,
          refreshInteractions: true,
          loadHistory: async () => messages,
          onTurnEnd: vi.fn()
        }}
      />
    </MemoryRouter>
  )
  return control
}
describe('AskUser ChatPage integration', () => {
  it('恢复卡片后同一 Chat resume，不追加用户消息；响应到手即收卡（整流还没跑完）', async () => {
    const control = mount()
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.click(screen.getByRole('radio', { name: '格式 A' }))
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(1))
    expect(control.requests[0].messages.filter((message) => message.role === 'user')).toHaveLength(
      1
    )
    expect(control.requests[0].body).toEqual({
      askUserResume: {
        threadId: 'thread',
        runId: 'run',
        toolCallId: 'ask',
        resumeData: {
          status: 'answered',
          answers: [{ questionId: '__proto__', selectedOptionIds: ['a'] }]
        }
      }
    })
    // 0.1.2 / 001：请求已受理（流还开着，没有 finish）—— 卡当场收起，提交等待不再挂在卡上
    await waitFor(() => expect(screen.queryByTestId('ask-user-card')).not.toBeInTheDocument())
    expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
      pending: [],
      submitting: false,
      error: null
    })
    // 这一轮还在跑：模型照常继续生成，文本进消息（"模型生成"由聊天自己的忙态表示）
    act(() => control.push('已收到你的选择。'))
    expect(await screen.findByText('已收到你的选择。')).toBeInTheDocument()
    act(() => control.finish())
  })
  it('响应没到手就不收卡：请求发出、卡与选择都留着，响应一到才收起', async () => {
    const control = mount()
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.click(screen.getByRole('radio', { name: '格式 A' }))
    control.holdResponse()
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(1))
    // 请求在途、响应没回来：这张卡与这次提交的视觉等待都还在（没"点击即成功"）
    expect(screen.getByTestId('ask-user-card')).toBeInTheDocument()
    expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
      pending: [pending],
      submitting: true,
      error: null
    })
    control.releaseResponse()
    await waitFor(() => expect(screen.queryByTestId('ask-user-card')).not.toBeInTheDocument())
    // 这一轮照旧在跑：输入卡那枚按钮切成停止（模型生成的忙态由聊天自己表示）
    expect(screen.getByRole('button', { name: '停止生成' })).toBeInTheDocument()
    act(() => control.disconnect(new Error('测试收尾')))
  })
  it('响应没到手就失败：卡与选择都留着，错误可见，重试仍能提交', async () => {
    const control = mount()
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.click(screen.getByRole('radio', { name: '格式 A' }))
    control.failNext(new Error('Failed to fetch'))
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(1))
    await screen.findAllByText(/Failed to fetch/)
    expect(screen.getByTestId('ask-user-card')).toBeInTheDocument()
    // 选过的项还在（重试不用重选）
    expect(screen.getByRole('radio', { name: '格式 A' })).toBeChecked()
    expect(useAskUserStore.getState().threads.get('thread')?.error).toMatch(/Failed to fetch/)
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(2))
    await waitFor(() => expect(screen.queryByTestId('ask-user-card')).not.toBeInTheDocument())
    act(() => control.disconnect(new Error('测试收尾')))
  })
  it('确认之后流断掉：错误落在对话层，提问卡不复辟、也不重复提交', async () => {
    const control = mount()
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.click(screen.getByRole('radio', { name: '格式 A' }))
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('ask-user-card')).not.toBeInTheDocument())
    act(() => control.disconnect(new Error('resume 失败')))
    await screen.findAllByText(/resume 失败/)
    // 卡不回来：这一次提问服务端已经消费掉了，复辟只会让用户对着空气再答一遍
    expect(screen.queryByTestId('ask-user-card')).not.toBeInTheDocument()
    expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
      pending: [],
      submitting: false,
      error: null
    })
    expect(control.requests).toHaveLength(1)
  })
  it('确认之后的旧 pending 快照不复活已答卡，新一轮提问照常出现', async () => {
    const control = mount()
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.click(screen.getByRole('radio', { name: '格式 A' }))
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('ask-user-card')).not.toBeInTheDocument())
    const sibling = {
      ...pending,
      toolCallId: 'ask-two',
      input: {
        questions: [
          {
            ...input.questions[0],
            header: '范围',
            options: [
              { id: 'a', label: '范围 A' },
              { id: 'b', label: '范围 B' }
            ]
          }
        ]
      }
    }
    // 服务端这一瞬仍列着已答的那条（挂起要被这一轮真消费掉才消失）+ 一条新提问
    api.pending.mockResolvedValue([pending, sibling])
    fireEvent.focus(window)
    expect(await screen.findByRole('radio', { name: '范围 A' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '格式 A' })).not.toBeInTheDocument()
    act(() => control.disconnect(new Error('测试收尾')))
  })
  it('混合审批决策不能绕过未回答问题自动续跑', async () => {
    const control = mount([
      {
        ...history[1],
        parts: [
          ...history[1].parts,
          {
            type: 'tool-write',
            toolCallId: 'write',
            state: 'approval-requested',
            input: { path: 'a.txt', content: 'a' },
            approval: { id: 'run::write' }
          }
        ]
      }
    ])
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.click(await screen.findByTestId('approval-allow-once'))
    await act(async () => {})
    expect(control.requests).toHaveLength(0)
    expect(screen.getByTestId('ask-user-card')).toBeInTheDocument()
  })
  it('部分回答未收到 tool result 时，以 pending GET 保留兄弟题而非重新显示已答题', async () => {
    const sibling = {
      ...pending,
      toolCallId: 'ask-two',
      input: {
        questions: [
          {
            ...input.questions[0],
            header: '范围',
            options: [
              { id: 'a', label: '范围 A' },
              { id: 'b', label: '范围 B' }
            ]
          }
        ]
      }
    }
    api.pending.mockResolvedValue([pending, sibling])
    const control = mount([
      {
        ...history[1],
        parts: [
          ...history[1].parts,
          {
            type: 'tool-ask_user',
            toolCallId: sibling.toolCallId,
            state: 'input-available',
            input: sibling.input
          }
        ]
      }
    ])
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '下一条' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    fireEvent.click(screen.getByRole('radio', { name: '格式 A' }))
    fireEvent.click(screen.getAllByRole('button', { name: '提交全部回答' })[0])
    await waitFor(() => expect(control.requests).toHaveLength(1))
    api.pending.mockResolvedValue([sibling])
    act(() => control.finish())
    await waitFor(() =>
      expect(screen.queryByRole('radio', { name: '格式 A' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('radio', { name: '范围 A' })).toBeInTheDocument()
    expect(useSessionsStore.getState().queues.thread).toHaveLength(1)
    expect(control.requests).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio', { name: '范围 A' }))
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(2))
    act(() => control.disconnect(new Error('测试收尾')))
  })
  it('挂起期间新消息进入队列，焦点刷新失败显示重试入口', async () => {
    const control = mount()
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '下一条' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    await waitFor(() => expect(useSessionsStore.getState().queues.thread).toHaveLength(1))
    expect(control.requests).toHaveLength(0)
    api.pending.mockRejectedValueOnce(new Error('刷新失败'))
    fireEvent.focus(window)
    await screen.findAllByText('刷新失败')
    expect(screen.getByTestId('ask-user-card')).toBeInTheDocument()
  })
  it('右上角 × 调后端 cancel，取消失败可见且卡片保留（只走一次）', async () => {
    api.cancel.mockRejectedValue(new Error('cancel 失败'))
    mount()
    await screen.findByRole('radio', { name: '格式 A' })
    fireEvent.click(screen.getByRole('button', { name: '取消本轮提问' }))
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('thread'))
    expect(api.cancel).toHaveBeenCalledTimes(1)
    await screen.findAllByText('cancel 失败')
    expect(screen.getByTestId('ask-user-card')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '停止本轮' })).not.toBeInTheDocument()
  })
  it('有提问时停靠区不再用固定 45vh 夹（当前题完整展示），没有提问时维持原夹高', async () => {
    mount()
    await screen.findByRole('radio', { name: '格式 A' })
    const area = screen.getByTestId('chat-dock-area')
    expect(area.className).toContain('max-h-[calc(100dvh-17rem)]')
    expect(area.className).not.toContain('45vh')
    // 提问卡自己没有任何夹高 / 内滚
    expect(screen.getByTestId('ask-user-card').className).not.toContain('max-h-')
    expect(screen.queryByText(/问题调用/)).not.toBeInTheDocument()
  })
  it('没有提问时停靠区还是原来的 45vh 夹高（任务清单 / 计划布局不受影响）', async () => {
    api.pending.mockResolvedValue([])
    mount()
    await waitFor(() => expect(useAskUserStore.getState().threads.get('thread')?.loaded).toBe(true))
    const area = screen.getByTestId('chat-dock-area')
    expect(area.className).toContain('max-h-[min(45vh,28rem)]')
    expect(area.className).not.toContain('dvh')
  })
  it('多题仍分页：逐题答、其它文本跨页不丢、末页一次提交整包 answers', async () => {
    api.pending.mockResolvedValue([
      {
        ...pending,
        input: {
          questions: [
            {
              id: 'one',
              header: '第一题',
              question: '选一个',
              options: [{ id: 'a', label: '选项 A' }]
            },
            {
              id: 'two',
              header: '第二题',
              question: '补充说明',
              multiSelect: true,
              options: [{ id: 'b', label: '选项 B' }]
            },
            {
              id: 'three',
              header: '第三题',
              question: '再选一个',
              options: [{ id: 'c', label: '选项 C' }]
            }
          ]
        }
      }
    ])
    const control = mount()
    await screen.findByRole('radio', { name: '选项 A' })
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 1/3 题')
    fireEvent.click(screen.getByRole('radio', { name: '选项 A' }))
    fireEvent.click(screen.getByTestId('ask-user-next'))
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 2/3 题')
    // 其它直接就是输入框：输入即勾上（多选与已勾预设共存）
    fireEvent.click(screen.getByRole('checkbox', { name: '选项 B' }))
    fireEvent.change(screen.getByRole('textbox', { name: '其它内容' }), {
      target: { value: '补充统计' }
    })
    fireEvent.click(screen.getByTestId('ask-user-next'))
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 3/3 题')
    // 翻回第二题：其它文本与勾选都还在（跨页不丢草稿）
    fireEvent.click(screen.getByTestId('ask-user-prev'))
    expect(screen.getByRole('textbox', { name: '其它内容' })).toHaveValue('补充统计')
    expect(screen.getByRole('checkbox', { name: '其它' })).toBeChecked()
    fireEvent.click(screen.getByTestId('ask-user-next'))
    fireEvent.click(screen.getByRole('radio', { name: '选项 C' }))
    fireEvent.click(screen.getByRole('button', { name: '提交全部回答' }))
    await waitFor(() => expect(control.requests).toHaveLength(1))
    expect(control.requests[0].body).toEqual({
      askUserResume: {
        threadId: 'thread',
        runId: 'run',
        toolCallId: 'ask',
        resumeData: {
          status: 'answered',
          answers: [
            { questionId: 'one', selectedOptionIds: ['a'] },
            { questionId: 'two', selectedOptionIds: ['b'], otherText: '补充统计' },
            { questionId: 'three', selectedOptionIds: ['c'] }
          ]
        }
      }
    })
    act(() => control.disconnect(new Error('测试收尾')))
  })
})
