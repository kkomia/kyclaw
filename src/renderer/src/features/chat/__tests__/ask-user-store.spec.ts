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
    const key = askUserCallKey({ threadId: 'thread', ...pending })
    const draft = Object.fromEntries([
      ['__proto__', { selectedOptionIds: ['b'], otherSelected: false, otherText: '' }]
    ])
    useAskUserStore.getState().changeDraft(key, draft)
    await useAskUserStore.getState().submit('thread', pending, answer, async () => {
      throw new Error('409 stale-run')
    })
    const state = useAskUserStore.getState()
    expect(state.threads.get('thread')).toMatchObject({
      submitting: false,
      error: '409 stale-run',
      pending: [pending]
    })
    // 草稿一个字没动（用户接着重试，不用重新选一遍）
    expect(state.drafts.get(key)).toEqual(draft)
  })

  /**
   * 0.1.2 / 001 的核心：**响应到手**（服务端已接收）与**整流结束**是两个时刻。
   * resume 的 Promise 要到模型流消费完才 resolve，所以收卡/放掉提交等待只能挂在"响应到手"那一下；
   * 反过来，没有回执就一律不当作成功。
   */
  describe('服务端已接收（响应到手）这个边界', () => {
    /** 一次可控的 resume：`ack()` 模拟响应到手，`settle()` 模拟这次请求结束（流跑完/abort 都一样） */
    function controlledResume(): {
      resume: (accepted: () => void) => Promise<void>
      ack: () => void
      settle: () => void
    } {
      let ack!: () => void
      let settle!: () => void
      return {
        resume: (accepted) => {
          ack = accepted
          return new Promise<void>((resolve) => {
            settle = resolve
          })
        },
        ack: () => ack(),
        settle: () => settle()
      }
    }

    it('已接收就收卡、放掉提交等待；整流还在跑，旧快照也不复活这张卡', async () => {
      await useAskUserStore.getState().refresh('thread')
      const control = controlledResume()
      const submitting = useAskUserStore
        .getState()
        .submit('thread', pending, answer, control.resume)
      control.ack()

      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
        pending: [],
        submitting: false,
        error: null
      })
      // 服务端这一瞬还列着它（挂起快照要等这一轮真消费掉才消失）：迟到的快照不能复活已答卡
      api.fetch.mockResolvedValue([pending])
      expect(await useAskUserStore.getState().refresh('thread')).toBe(true)
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([])
      expect(askUserWaiting('thread')).toBe(false)
      // 别的会话不受这一格的影响（确认是 (thread, run, tool) 三元组的账）
      expect(await useAskUserStore.getState().refresh('other')).toBe(true)
      expect(useAskUserStore.getState().threads.get('other')?.pending).toEqual([pending])

      control.settle()
      await submitting
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([])
    })

    it('整流中途断掉：错误交给对话层，提问卡不复辟、也不重复提交', async () => {
      await useAskUserStore.getState().refresh('thread')
      let calls = 0
      await useAskUserStore.getState().submit('thread', pending, answer, async (signal) => {
        calls += 1
        signal()
        throw new Error('流断了')
      })
      expect(calls).toBe(1)
      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
        pending: [],
        submitting: false,
        error: null
      })
      // 这一轮结束了，服务端快照仍是老样子（挂起还在路上）：照样不复活
      api.fetch.mockResolvedValue([pending])
      await useAskUserStore.getState().refresh('thread')
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([])
    })

    it('确认后新提问照常出现；同一次提交重复回调不重复收口', async () => {
      await useAskUserStore.getState().refresh('thread')
      const sibling: PendingAskUser = { ...pending, toolCallId: 'ask-two' }
      const control = controlledResume()
      const submitting = useAskUserStore
        .getState()
        .submit('thread', pending, answer, control.resume)
      control.ack()
      control.ack()
      api.fetch.mockResolvedValue([pending, sibling])
      await useAskUserStore.getState().refresh('thread')
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([sibling])
      control.settle()
      await submitting
    })

    it('双击只发一次（第二下在 submitting 上挡下）', async () => {
      await useAskUserStore.getState().refresh('thread')
      const control = controlledResume()
      const resume = vi.fn(control.resume)
      const first = useAskUserStore.getState().submit('thread', pending, answer, resume)
      const second = useAskUserStore.getState().submit('thread', pending, answer, resume)
      await second
      expect(resume).toHaveBeenCalledTimes(1)
      control.ack()
      control.settle()
      await first
      expect(resume).toHaveBeenCalledTimes(1)
    })

    it('没有回执就不算成功（abort / 没带通道）：卡与草稿都在，靠刷新收敛', async () => {
      await useAskUserStore.getState().refresh('thread')
      const key = askUserCallKey({ threadId: 'thread', ...pending })
      const control = controlledResume()
      const submitting = useAskUserStore
        .getState()
        .submit('thread', pending, answer, control.resume)
      // 请求正常结束、一次回执都没有（AI SDK 的中止就是这样：resolve 且不置 chat.error）
      control.settle()
      await submitting
      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
        pending: [pending],
        submitting: false,
        error: null
      })
      expect(useAskUserStore.getState().drafts.get(key)).toBeDefined()
      // 收敛：服务端真受理过的话，快照里就不会再列它 —— 卡自然消失（不靠"流末就算成功"）
      api.fetch.mockResolvedValue([])
      await useAskUserStore.getState().refresh('thread')
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([])
    })

    it('reset 之后迟到的回执：不复活线程、不记墓志铭', async () => {
      await useAskUserStore.getState().refresh('thread')
      const control = controlledResume()
      const submitting = useAskUserStore
        .getState()
        .submit('thread', pending, answer, control.resume)
      resetAskUserStore()
      control.ack()
      expect(useAskUserStore.getState().threads.get('thread')).toBeUndefined()
      control.settle()
      await submitting
      expect(useAskUserStore.getState().threads.get('thread')).toBeUndefined()
      // 也没留下墓志铭：重置之后的刷新照常把服务端列的东西铺出来
      await useAskUserStore.getState().refresh('thread')
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([pending])
    })

    it('新一轮提交之后，旧一代的迟到回执不动新状态', async () => {
      const sibling: PendingAskUser = { ...pending, toolCallId: 'ask-two' }
      api.fetch.mockResolvedValue([pending, sibling])
      await useAskUserStore.getState().refresh('thread')
      const first = controlledResume()
      const firstSubmit = useAskUserStore.getState().submit('thread', pending, answer, first.resume)
      // 第一次请求结束了但没回执（卡留着）→ 用户可以再答另一条
      first.settle()
      await firstSubmit
      const second = controlledResume()
      const secondSubmit = useAskUserStore
        .getState()
        .submit('thread', sibling, answer, second.resume)
      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({ submitting: true })

      first.ack()
      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
        submitting: true,
        pending: [pending, sibling]
      })

      second.ack()
      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
        submitting: false,
        pending: [pending]
      })
      second.settle()
      await secondSubmit
    })

    it('取消之后迟到的回执：不替取消擦账（取消失败的提示留着）', async () => {
      await useAskUserStore.getState().refresh('thread')
      const control = controlledResume()
      const submitting = useAskUserStore
        .getState()
        .submit('thread', pending, answer, control.resume)
      api.cancel.mockRejectedValueOnce(new Error('cancel 失败'))
      expect(await useAskUserStore.getState().cancel('thread', async () => {})).toBeNull()
      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
        error: 'cancel 失败',
        pending: [pending]
      })

      // 回执是**真证据**（服务端确实收了这次回答）：照常收卡，但不擦掉取消自己的账
      control.ack()
      expect(useAskUserStore.getState().threads.get('thread')).toMatchObject({
        error: 'cancel 失败',
        pending: [],
        submitting: false
      })
      control.settle()
      await submitting
    })

    it('墓志铭按当前快照收敛：服务端不再列它之后就回收', async () => {
      await useAskUserStore.getState().refresh('thread')
      const control = controlledResume()
      const submitting = useAskUserStore
        .getState()
        .submit('thread', pending, answer, control.resume)
      control.ack()
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([])
      // 服务端不再列它（这一轮真消费掉了）→ 账回收；此后只有"再列一次"才会重新算
      // （已消费的挂起不会重现，所以这一档生产上走不到，钉的是账不会越积越多）
      api.fetch.mockResolvedValue([])
      await useAskUserStore.getState().refresh('thread')
      api.fetch.mockResolvedValue([pending])
      await useAskUserStore.getState().refresh('thread')
      expect(useAskUserStore.getState().threads.get('thread')?.pending).toEqual([pending])
      control.settle()
      await submitting
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
