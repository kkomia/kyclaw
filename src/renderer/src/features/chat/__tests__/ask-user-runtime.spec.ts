import { beforeEach, describe, expect, it, vi } from 'vitest'
import { threadChat, resetThreadChats } from '../thread-chats'
import { createMockTransport } from './mock-transport'
import { EMPTY_ASK_USER_THREAD, resetAskUserStore, useAskUserStore } from '../ask-user-store'

beforeEach(() => {
  resetThreadChats()
  resetAskUserStore()
})
describe('AskUser Chat runtime', () => {
  it('pending GET 确认全部题已答但审批待续时不报完成，旧 ask part 不阻止审批续跑', async () => {
    useAskUserStore.setState({
      threads: new Map([
        [
          'thread',
          {
            ...EMPTY_ASK_USER_THREAD,
            loaded: true
          }
        ]
      ])
    })
    const control = createMockTransport()
    const onTurnEnd = vi.fn()
    const chat = await threadChat('thread', {
      transport: control.transport,
      loadHistory: async () => [],
      onTurnEnd
    })
    const sending = chat.sendMessage({ text: '开始' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    control.toolInput('ask', 'ask_user', {})
    control.requestApproval({
      toolCallId: 'write',
      toolName: 'write',
      input: {},
      approvalId: 'run::write'
    })
    control.finish()
    await sending
    expect(onTurnEnd).toHaveBeenLastCalledWith(
      'thread',
      expect.objectContaining({ awaitingApproval: true })
    )
    const approval = chat.addToolApprovalResponse({ id: 'run::write', approved: true })
    await vi.waitFor(() => expect(control.requests).toHaveLength(2))
    control.toolOutput('ask', { status: 'answered', answers: [] })
    control.toolOutput('write', { ok: true })
    control.finish()
    await approval
    await vi.waitFor(() =>
      expect(onTurnEnd).toHaveBeenLastCalledWith(
        'thread',
        expect.objectContaining({ awaitingApproval: false })
      )
    )
    expect(onTurnEnd.mock.calls.at(-1)?.[1].waitingInteraction).not.toBe(true)
  })

  it('未答问题收尾标记 waitingInteraction，并保持 thread Chat 实例', async () => {
    const control = createMockTransport()
    const onTurnEnd = vi.fn()
    const runtime = { transport: control.transport, loadHistory: async () => [], onTurnEnd }
    const chat = await threadChat('thread', runtime)
    expect(await threadChat('thread', runtime)).toBe(chat)
    const sending = chat.sendMessage({ text: '开始' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    control.toolInput('ask', 'ask_user', {})
    control.finish('tool-calls')
    await sending
    expect(onTurnEnd).toHaveBeenCalledWith(
      'thread',
      expect.objectContaining({
        awaitingApproval: false,
        waitingInteraction: true,
        isError: false
      })
    )
  })
})
