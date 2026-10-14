import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tasksStore } from '@renderer/lib/tasks-store'
import { threadChat, resetThreadChats, dropThreadChat } from '../thread-chats'
import { createMockTransport } from './mock-transport'

beforeEach(() => {
  resetThreadChats()
  vi.restoreAllMocks()
})
describe('Task Chat lifecycle', () => {
  it('todo tool result 后刷新当前服务端快照', async () => {
    const load = vi.spyOn(tasksStore.getState(), 'load').mockResolvedValue(undefined)
    const control = createMockTransport()
    const chat = await threadChat('thread', {
      transport: control.transport,
      loadHistory: async () => [],
      onTurnEnd: vi.fn()
    })
    const sending = chat.sendMessage({ text: '开始' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    control.toolInput('todo', 'todo', { action: 'get' })
    control.toolOutput('todo', {
      status: 'ok',
      snapshot: { revision: 0, items: [], updatedAt: null }
    })
    control.finish()
    await sending
    expect(load).toHaveBeenCalledWith('thread')
  })
  it('删除路径 forget，历史重试路径不误清当前任务', () => {
    const forget = vi.spyOn(tasksStore.getState(), 'forget')
    dropThreadChat('retry')
    expect(forget).not.toHaveBeenCalled()
    dropThreadChat('deleted', { stop: true })
    expect(forget).toHaveBeenCalledExactlyOnceWith('deleted')
  })
})
