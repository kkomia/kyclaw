import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askUserPending,
  askUserWaiting,
  resetAskUserStore,
  useAskUserStore
} from '../ask-user-store'
import { askUserCallKey } from '../ask-user-ui'
import type { PendingAskUser } from '@renderer/lib/ask-user-api'

const api = vi.hoisted(() => ({ fetch: vi.fn(), cancel: vi.fn() }))
vi.mock('@renderer/lib/ask-user-api', () => ({
  fetchPendingAskUser: api.fetch,
  cancelAskUser: api.cancel
}))
const pending: PendingAskUser = {
  runId: 'run',
  toolCallId: 'tool',
  suspendedAt: '2026-10-14T00:00:00Z',
  input: {
    questions: [
      {
        id: '__proto__',
        header: '方式',
        question: '请选择',
        options: [
          { id: 'a', label: 'A', recommended: true },
          { id: 'b', label: 'B' }
        ]
      }
    ]
  }
}
const answer = {
  status: 'answered' as const,
  answers: [{ questionId: '__proto__', selectedOptionIds: ['a'] }]
}

beforeEach(() => {
  resetAskUserStore()
  vi.clearAllMocks()
  api.fetch.mockResolvedValue([pending])
})
describe('AskUser renderer store', () => {
  it('成功 pending GET 覆盖旧 input-available part，失败时保守回落', async () => {
    const stale = {
      id: 'assistant',
      role: 'assistant' as const,
      parts: [
        {
          type: 'tool-ask_user' as const,
          state: 'input-available' as const,
          toolCallId: pending.toolCallId,
          input: pending.input
        }
      ]
    }
    expect(askUserPending('thread', stale)).toBe(true)
    api.fetch.mockResolvedValue([])
    await useAskUserStore.getState().refresh('thread')
    expect(askUserPending('thread', stale)).toBe(false)
    expect(askUserWaiting('thread')).toBe(false)
    api.fetch.mockRejectedValueOnce(new Error('pending 失败'))
    await useAskUserStore.getState().refresh('thread')
    expect(askUserPending('thread', stale)).toBe(true)
    expect(askUserWaiting('thread')).toBe(true)
  })

  it('恢复并保留按 thread/run/tool 的草稿，刷新不预选', async () => {
    const state = useAskUserStore.getState()
    await state.refresh('thread')
    const key = askUserCallKey({ threadId: 'thread', ...pending })
    const restored = useAskUserStore.getState().drafts.get(key)
    expect(restored).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(restored ?? {}, '__proto__')).toBe(true)
    expect(restored?.['__proto__']?.selectedOptionIds).toEqual([])
    const draft = Object.fromEntries([
      ['__proto__', { selectedOptionIds: ['a'], otherSelected: false, otherText: '' }]
    ])
    state.changeDraft(key, draft)
    await state.refresh('other')
    await state.refresh('thread')
    expect(useAskUserStore.getState().drafts.get(key)).toBe(draft)
    expect(askUserWaiting('thread')).toBe(true)
  })
  it('刷新失败保持旧问题和错误，重试后恢复', async () => {
    await useAskUserStore.getState().refresh('thread')
    api.fetch.mockRejectedValueOnce(new Error('刷新失败'))
    expect(await useAskUserStore.getState().refresh('thread')).toBe(false)
    expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([pending])
    expect(useAskUserStore.getState().threads.get('thread')?.error).toBe('刷新失败')
    await useAskUserStore.getState().refresh('thread')
    expect(useAskUserStore.getState().threads.get('thread')?.error).toBeNull()
  })
  it('resume 失败保留卡与草稿，不假成功', async () => {
    await useAskUserStore.getState().refresh('thread')
    await useAskUserStore.getState().submit('thread', pending, answer, async () => {
      throw new Error('409 stale-run')
    })
    expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
      submitting: false,
      error: '409 stale-run',
      pending: [pending]
    })
  })
  it('停止必须调用 stop 和 cancel，失败不清卡', async () => {
    await useAskUserStore.getState().refresh('thread')
    const stop = vi.fn().mockResolvedValue(undefined)
    api.cancel.mockRejectedValueOnce(new Error('停止失败'))
    expect(await useAskUserStore.getState().cancel('thread', stop)).toBeNull()
    expect(stop).toHaveBeenCalledOnce()
    expect(api.cancel).toHaveBeenCalledWith('thread')
    expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([pending])
    api.cancel.mockResolvedValue(['run'])
    api.fetch.mockResolvedValue([])
    expect(await useAskUserStore.getState().cancel('thread', stop)).toEqual(['run'])
    expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([])
  })
  it('停止使旧刷新失效，旧快照不能复活卡', async () => {
    let resolve!: (value: PendingAskUser[]) => void
    api.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const old = useAskUserStore.getState().refresh('thread')
    api.cancel.mockResolvedValue(['run'])
    api.fetch.mockResolvedValue([])
    await useAskUserStore.getState().cancel('thread', async () => {})
    resolve([pending])
    await old
    expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([])
  })
})
