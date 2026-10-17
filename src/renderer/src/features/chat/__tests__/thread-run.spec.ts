import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropThreadChat, resetThreadChats, threadChat } from '../thread-chats'
import type { ThreadChatRuntime } from '../thread-chats'
import { resetThreadRunStore, useThreadRunStore } from '../thread-run-store'
import { createMockTransport } from './mock-transport'

/**
 * 010：会话运行态（submitted / streaming）的订阅与生命周期。
 *
 * 权威源是 thread-chats 里那一枚常驻 Chat（侧栏"在跑"灰圈的唯一来源）：
 *   - 只有 submitted / streaming 两种状态算"在跑"；ready / error **不算**；
 *     停在等审批的挂起轮（流已收尾）同样不算 —— 用户做完决策续跑才重新亮；
 *   - 状态回调只在**状态跳变**时来（@ai-sdk/react 的 `~registerStatusCallback`：status setter
 *     在值没变时直接返回），逐 token 的正文推进不经过这里 —— "不每 token 刷新"由断言钉住；
 *   - 删除 / 重置会解订阅并把灰圈清掉；历史还在拉时被丢弃的实例（异步竞态）此后不许再写状态，
 *     同 id 重建后的新实例订阅照常生效。
 */
function runningOf(threadId: string): boolean | undefined {
  return useThreadRunStore.getState().running[threadId]
}

function runtimeWith(
  control: ReturnType<typeof createMockTransport>,
  loadHistory: ThreadChatRuntime['loadHistory'] = async () => []
): { runtime: ThreadChatRuntime; onTurnEnd: ReturnType<typeof vi.fn> } {
  const onTurnEnd = vi.fn()
  return { runtime: { transport: control.transport, loadHistory, onTurnEnd }, onTurnEnd }
}

beforeEach(() => {
  resetThreadChats()
  resetThreadRunStore()
})

describe('会话运行态：submitted / streaming 才亮', () => {
  it('发送即亮、收尾即灭；逐 token 正文推进不再触碰 store（不每 token 刷新）', async () => {
    const control = createMockTransport()
    const { runtime } = runtimeWith(control)
    const chat = await threadChat('t-run', runtime)
    expect(runningOf('t-run')).toBeUndefined()

    let writes = 0
    const unsubscribe = useThreadRunStore.subscribe(() => {
      writes += 1
    })
    try {
      const sending = chat.sendMessage({ text: '问题' })
      await vi.waitFor(() => expect(control.requests).toHaveLength(1))
      expect(runningOf('t-run')).toBe(true)

      const afterSubmit = writes
      control.push('前半')
      control.push('后半')
      control.push('再后半')
      await vi.waitFor(() => expect(chat.status).toBe('streaming'))
      // 正文每 token 走的是 messages 回调，状态没跳变 —— store 一次都不该被写
      expect(writes).toBe(afterSubmit)

      control.finish()
      await sending
      await vi.waitFor(() => expect(runningOf('t-run')).toBeUndefined())
      expect(chat.status).toBe('ready')
    } finally {
      unsubscribe()
    }
  })

  it('等审批的挂起轮不算运行（流已收尾）；批准续跑是一次真运行，重新亮', async () => {
    const control = createMockTransport()
    const { runtime } = runtimeWith(control)
    const chat = await threadChat('t-approval', runtime)

    const sending = chat.sendMessage({ text: '写个文件' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    expect(runningOf('t-approval')).toBe(true)

    control.requestApproval({
      toolCallId: 'call-1',
      toolName: 'write',
      input: {},
      approvalId: 'run::write'
    })
    control.finish()
    await sending
    await vi.waitFor(() => expect(chat.status).toBe('ready'))
    expect(runningOf('t-approval')).toBeUndefined()

    const approving = chat.addToolApprovalResponse({ id: 'run::write', approved: true })
    await vi.waitFor(() => expect(control.requests).toHaveLength(2))
    expect(runningOf('t-approval')).toBe(true)
    control.toolOutput('call-1', { ok: true })
    control.finish()
    await approving
    await vi.waitFor(() => expect(runningOf('t-approval')).toBeUndefined())
  })

  it('流中途失败 / 响应到不了：灭（error 不是运行）', async () => {
    const control = createMockTransport()
    const { runtime } = runtimeWith(control)
    const chat = await threadChat('t-fail', runtime)

    const sending = chat.sendMessage({ text: '问题' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    control.push('半句')
    await vi.waitFor(() => expect(runningOf('t-fail')).toBe(true))
    control.disconnect(new Error('连接中断'))
    await sending
    await vi.waitFor(() => expect(chat.status).toBe('error'))
    expect(runningOf('t-fail')).toBeUndefined()

    // 响应都没到手（请求阶段就失败）同样不留在运行态
    control.failNext(new Error('连接被拒绝'))
    await chat.sendMessage({ text: '再来一次' })
    await vi.waitFor(() => expect(chat.status).toBe('error'))
    expect(runningOf('t-fail')).toBeUndefined()
  })

  it('停止：stop() 收流回 ready → 灭', async () => {
    const control = createMockTransport()
    const { runtime } = runtimeWith(control)
    const chat = await threadChat('t-stop', runtime)

    const sending = chat.sendMessage({ text: '问题' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    control.push('半句')
    await vi.waitFor(() => expect(runningOf('t-stop')).toBe(true))

    await chat.stop()
    await sending
    await vi.waitFor(() => expect(chat.status).toBe('ready'))
    expect(runningOf('t-stop')).toBeUndefined()
  })
})

describe('会话运行态：订阅生命周期', () => {
  it('dropThreadChat：解订阅 + 清运行态；被丢掉的实例后续变化不再写回', async () => {
    const control = createMockTransport()
    const { runtime } = runtimeWith(control)
    const chat = await threadChat('t-drop', runtime)

    const sending = chat.sendMessage({ text: '第一轮' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    expect(runningOf('t-drop')).toBe(true)

    dropThreadChat('t-drop', { stop: true })
    expect(runningOf('t-drop')).toBeUndefined()
    await sending

    // 被丢弃的实例再发（僵尸流）：订阅已解，不许把灰圈写回来
    const zombie = chat.sendMessage({ text: '不该被看见' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(2))
    expect(runningOf('t-drop')).toBeUndefined()
    control.finish()
    await zombie
    expect(runningOf('t-drop')).toBeUndefined()
  })

  it('创建竞态：历史还在拉时丢弃 —— 晚到的实例不注册订阅；同 id 重建后订阅照常生效', async () => {
    const control = createMockTransport()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const loadHistory = vi.fn(async () => {
      await gate
      return []
    })
    const { runtime } = runtimeWith(control, loadHistory)

    const created = threadChat('t-race', runtime)
    // 历史还没回来（实例还没进注册表）：这一下丢弃
    dropThreadChat('t-race')
    release()
    const stale = await created

    // 晚到的实例没有订阅：它跑起来也不写运行态
    const sending = stale.sendMessage({ text: 'late' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    expect(runningOf('t-race')).toBeUndefined()
    control.finish()
    await sending
    expect(runningOf('t-race')).toBeUndefined()

    // 重建：新实例的订阅照常生效（旧实例的丢弃没有把这一条的订阅通道弄坏）
    const recreated = await threadChat('t-race', runtime)
    expect(recreated).not.toBe(stale)
    const sending2 = recreated.sendMessage({ text: 'again' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(2))
    expect(runningOf('t-race')).toBe(true)
    control.finish()
    await sending2
    await vi.waitFor(() => expect(runningOf('t-race')).toBeUndefined())
  })

  it('resetThreadChats：整表清空（订阅解除，旧实例不再写回）', async () => {
    const control = createMockTransport()
    const { runtime } = runtimeWith(control)
    const chat = await threadChat('t-reset', runtime)

    const sending = chat.sendMessage({ text: '问题' })
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    expect(runningOf('t-reset')).toBe(true)

    resetThreadChats()
    expect(useThreadRunStore.getState().running).toEqual({})

    control.push('僵尸')
    await vi.waitFor(() => expect(chat.status).toBe('streaming'))
    expect(runningOf('t-reset')).toBeUndefined()
    control.finish()
    await sending
    expect(runningOf('t-reset')).toBeUndefined()
  })
})
