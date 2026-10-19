// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@mastra/core/agent'
import type { MastraMemory } from '@mastra/core/memory'
import type { LibSQLStore } from '@mastra/libsql'
import { AskUserRuntime, askUserErrorText } from '../ask-user-runtime'

const input = {
  questions: [
    {
      id: 'q',
      header: 'Choice',
      question: 'Choose?',
      options: [
        { id: 'a', label: 'Original A' },
        { id: 'b', label: 'Original B' }
      ]
    }
  ]
}
const answer = { status: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['a'] }] }

function setup(cancelledRuns: unknown = []): AskUserRuntime {
  const agent = {
    listSuspendedRuns: async () => ({
      runs: [
        {
          runId: 'run',
          threadId: 'thread',
          resourceId: 'local-user',
          suspendedAt: new Date(),
          toolCalls: [
            {
              toolName: 'ask_user',
              toolCallId: 'tool',
              requiresApproval: false,
              suspendPayload: input
            }
          ]
        }
      ]
    })
  } as unknown as Agent
  const memory = {
    getThreadById: async () => ({ id: 'thread', resourceId: 'local-user' }),
    recall: async () => ({
      messages: [
        { id: 'm', content: { metadata: { askUserCancelledRuns: cancelledRuns }, parts: [] } }
      ]
    })
  } as unknown as MastraMemory
  return new AskUserRuntime(agent, memory, {} as LibSQLStore)
}

describe('AskUserRuntime authoritative claim', () => {
  it('persistent cancellation tombstone rejects a leftover workflow snapshot', async () => {
    const runtime = setup(['run'])
    await expect(runtime.claim('thread', 'run', 'tool', answer)).rejects.toMatchObject({
      status: 409,
      message: 'cancelled-run'
    })
    await expect(
      runtime.claimApprovals('thread', [{ runId: 'run', toolCallId: 'tool' }])
    ).rejects.toMatchObject({ status: 409 })
  })
  it('uses persisted questions and rejects unknown IDs without consuming the run', async () => {
    const runtime = setup()
    await expect(
      runtime.claim('thread', 'run', 'tool', {
        status: 'answered',
        answers: [{ questionId: 'q', selectedOptionIds: ['foreign'] }]
      })
    ).rejects.toMatchObject({ status: 400 })
    const claim = await runtime.claim('thread', 'run', 'tool', answer)
    expect(claim.answer).toEqual(answer)
    claim.release()
  })

  it('rejects cross-thread and unknown targets', async () => {
    const runtime = setup()
    await expect(runtime.claim('other', 'run', 'tool', answer)).rejects.toMatchObject({
      status: 409
    })
    await expect(runtime.claim('thread', 'run', 'other', answer)).rejects.toMatchObject({
      status: 409
    })
  })

  it('holds a run lock until the stream owner explicitly releases it', async () => {
    const runtime = setup()
    const claim = await runtime.claim('thread', 'run', 'tool', answer)
    await expect(runtime.claim('thread', 'run', 'tool', answer)).rejects.toMatchObject({
      status: 409
    })
    claim.release()
    const next = await runtime.claim('thread', 'run', 'tool', answer)
    claim.release()
    await expect(runtime.claim('thread', 'run', 'tool', answer)).rejects.toMatchObject({
      status: 409
    })
    next.release()
  })

  it('blocks initial chat leases throughout a thread mutation', async () => {
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let complete!: () => void
    const hold = new Promise<void>((resolve) => {
      complete = resolve
    })
    const agent = {
      listSuspendedRuns: async () => ({ runs: [] }),
      abortThreadStream: () => false
    } as unknown as Agent
    const memory = {
      getThreadById: async () => ({ resourceId: 'local-user' }),
      settled: async () => {},
      recall: async () => ({ messages: [] })
    } as unknown as MastraMemory
    const storage = {
      getStore: async () => ({ listWorkflowRuns: async () => ({ runs: [] }) })
    } as unknown as LibSQLStore
    const runtime = new AskUserRuntime(agent, memory, storage)
    const mutation = runtime.withThreadChange('thread', async () => {
      enter()
      await hold
    })
    await entered
    expect(() => runtime.claimInitial('thread')).toThrow('thread-busy')
    complete()
    await mutation
    runtime.claimInitial('thread').release()
  })

  it('malformed cancellation metadata returns stale-run rather than TypeError', async () => {
    const agent = {
      listSuspendedRuns: async () => ({ runs: [] }),
      abortThreadStream: () => false
    } as unknown as Agent
    const memory = {
      getThreadById: async () => ({ resourceId: 'local-user' }),
      settled: async () => {},
      recall: async () => ({
        messages: [
          {
            role: 'assistant',
            content: { metadata: { askUserCancelledRuns: { unexpected: true } } }
          }
        ]
      })
    } as unknown as MastraMemory
    const runtime = new AskUserRuntime(agent, memory, {} as LibSQLStore)
    await expect(runtime.cancel('thread', 'old')).rejects.toMatchObject({
      status: 409,
      message: 'stale-run'
    })
  })
})

/** 审批续跑：tolerateConsumedApprovals 的取证边界（toolCallId 必须绑到同一条 run） */
function approvalRuntime(options: {
  runs: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
}): AskUserRuntime {
  const agent = {
    listSuspendedRuns: async () => ({ runs: options.runs })
  } as unknown as Agent
  const memory = {
    getThreadById: async () => ({ id: 'thread', resourceId: 'local-user' }),
    recall: async () => ({ messages: options.messages })
  } as unknown as MastraMemory
  return new AskUserRuntime(agent, memory, {} as LibSQLStore)
}
const suspendedRun = (
  runId: string,
  toolCalls: Array<Record<string, unknown>>
): Record<string, unknown> => ({
  runId,
  threadId: 'thread',
  resourceId: 'local-user',
  suspendedAt: new Date(),
  toolCalls
})
const approvalTool = (toolCallId: string): Record<string, unknown> => ({
  toolName: 'bash',
  toolCallId,
  requiresApproval: true,
  suspendPayload: {}
})
const invocation = (toolCallId: string): Record<string, unknown> => ({
  type: 'tool-invocation',
  toolInvocation: { toolCallId, toolName: 'bash', state: 'call' }
})
const message = (
  role: 'assistant' | 'user',
  content: Record<string, unknown>
): Record<string, unknown> => ({ id: `${role}-msg`, role, content: { format: 2, ...content } })

describe('AskUserRuntime consumed-approval evidence', () => {
  it('tolerates a consumed sibling only when the assistant message binds it to the same run', async () => {
    const runtime = approvalRuntime({
      runs: [suspendedRun('R', [approvalTool('call-b2')])],
      messages: [
        message('assistant', {
          parts: [invocation('call-b1'), invocation('call-b2')],
          metadata: { pendingToolApprovals: { 'call-b2': { runId: 'R', toolCallId: 'call-b2' } } }
        })
      ]
    })
    const claim = await runtime.claimApprovals('thread', [
      { runId: 'R', toolCallId: 'call-b1' },
      { runId: 'R', toolCallId: 'call-b2' }
    ])
    claim.release()
  })

  it('rejects a tool call id that is only bound to another run (cross-run mixing)', async () => {
    const runtime = approvalRuntime({
      runs: [suspendedRun('R1', [approvalTool('call-1')])],
      messages: [
        message('assistant', {
          parts: [invocation('call-foreign')],
          metadata: { pendingToolApprovals: { x: { runId: 'R2', toolCallId: 'x' } } }
        })
      ]
    })
    await expect(
      runtime.claimApprovals('thread', [
        { runId: 'R1', toolCallId: 'call-1' },
        { runId: 'R1', toolCallId: 'call-foreign' }
      ])
    ).rejects.toMatchObject({ status: 409, message: 'stale-run' })
  })

  it('rejects a tool call id that appears without any run binding', async () => {
    const runtime = approvalRuntime({
      runs: [suspendedRun('R', [approvalTool('call-pending')])],
      messages: [message('assistant', { parts: [invocation('call-anywhere')] })]
    })
    await expect(
      runtime.claimApprovals('thread', [
        { runId: 'R', toolCallId: 'call-pending' },
        { runId: 'R', toolCallId: 'call-anywhere' }
      ])
    ).rejects.toMatchObject({ status: 409, message: 'stale-run' })
  })

  it('ignores tool evidence carried by a non-assistant message', async () => {
    const runtime = approvalRuntime({
      runs: [suspendedRun('R', [approvalTool('call-pending')])],
      messages: [
        message('user', {
          parts: [invocation('call-forged')],
          metadata: { pendingToolApprovals: { x: { runId: 'R', toolCallId: 'x' } } }
        })
      ]
    })
    await expect(
      runtime.claimApprovals('thread', [
        { runId: 'R', toolCallId: 'call-pending' },
        { runId: 'R', toolCallId: 'call-forged' }
      ])
    ).rejects.toMatchObject({ status: 409, message: 'stale-run' })
  })

  it('rejects an unknown run even with approval evidence in history', async () => {
    const runtime = approvalRuntime({
      runs: [],
      messages: [
        message('assistant', {
          parts: [invocation('call-b1')],
          metadata: { pendingToolApprovals: { b1: { runId: 'R', toolCallId: 'call-b1' } } }
        })
      ]
    })
    await expect(
      runtime.claimApprovals('thread', [{ runId: 'R', toolCallId: 'call-b1' }])
    ).rejects.toMatchObject({ status: 409, message: 'stale-run' })
  })

  it('rejects when every target is a consumed approval (no runnable target left)', async () => {
    const runtime = approvalRuntime({
      runs: [suspendedRun('R', [approvalTool('call-pending')])],
      messages: [
        message('assistant', {
          parts: [invocation('call-b1')],
          metadata: {
            pendingToolApprovals: { 'call-pending': { runId: 'R', toolCallId: 'call-pending' } }
          }
        })
      ]
    })
    await expect(
      runtime.claimApprovals('thread', [{ runId: 'R', toolCallId: 'call-b1' }])
    ).rejects.toMatchObject({ status: 409, message: 'stale-run' })
  })

  it('keeps rejecting a packed replay after cancel (cancelled-run wins over tolerance)', async () => {
    const runtime = approvalRuntime({
      runs: [suspendedRun('R', [approvalTool('call-b2')])],
      messages: [
        message('assistant', {
          parts: [invocation('call-b1'), invocation('call-b2')],
          metadata: {
            askUserCancelledRuns: ['R'],
            pendingToolApprovals: { 'call-b2': { runId: 'R', toolCallId: 'call-b2' } }
          }
        })
      ]
    })
    await expect(
      runtime.claimApprovals('thread', [
        { runId: 'R', toolCallId: 'call-b1' },
        { runId: 'R', toolCallId: 'call-b2' }
      ])
    ).rejects.toMatchObject({ status: 409, message: 'cancelled-run' })
  })

  it('still selects a genuinely suspended approval without needing history', async () => {
    const runtime = approvalRuntime({
      runs: [suspendedRun('R', [approvalTool('call-b2')])],
      messages: []
    })
    const claim = await runtime.claimApprovals('thread', [{ runId: 'R', toolCallId: 'call-b2' }])
    claim.release()
  })
})

/**
 * PB-034：长任务（用户实测 42 次思考 / 66 次工具 / 38s）执行中报 `{"error":"stale-run"}`。
 * 判定点 = `acquire()` 里"目标 run 不在 `listSuspendedRuns` 快照里"；长任务的续跑（审批 / 提问的
 * 回答）请求可能**比 run 持久化为 suspended 早到一点**，以前立刻 409 把整轮判失败。
 * 这里钉住：宽限窗口内重查 → 成功；已消费的审批 → 幂等；真的没有这一轮 → 仍 409（带人话）。
 */
describe('PB-034 stale-run：长任务续跑不误判', () => {
  it('续跑请求比 run 持久化早到：宽限窗口内重查后成功（不再立刻 409）', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const run = suspendedRun('run', [
        { toolName: 'ask_user', toolCallId: 'tool', requiresApproval: false, suspendPayload: input }
      ])
      const agent = {
        listSuspendedRuns: async () => {
          calls += 1
          // 前两次"还没持久化好"，第三次才可见（模拟长任务的时序竞态）
          return { runs: calls >= 3 ? [run] : [] }
        }
      } as unknown as Agent
      const memory = {
        getThreadById: async () => ({ id: 'thread', resourceId: 'local-user' }),
        recall: async () => ({ messages: [] })
      } as unknown as MastraMemory
      const runtime = new AskUserRuntime(agent, memory, {} as LibSQLStore)

      const pending = runtime.claim('thread', 'run', 'tool', answer)
      await vi.advanceTimersByTimeAsync(600)
      const claim = await pending
      expect(claim.answer.status).toBe('answered')
      claim.release()
      expect(calls).toBeGreaterThanOrEqual(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('既有 consumed 语义不变：run 不在挂起列表时，宽限窗口过后仍 409（宽限只治时序，不放过过期请求）', async () => {
    vi.useFakeTimers()
    try {
      const agent = { listSuspendedRuns: async () => ({ runs: [] }) } as unknown as Agent
      const memory = {
        getThreadById: async () => ({ id: 'thread', resourceId: 'local-user' }),
        recall: async () => ({
          messages: [
            message('assistant', {
              parts: [invocation('call-1')],
              metadata: { pendingToolApprovals: { 'call-1': { runId: 'R', toolCallId: 'call-1' } } }
            })
          ]
        })
      } as unknown as MastraMemory
      const runtime = new AskUserRuntime(agent, memory, {} as LibSQLStore)

      const pending = runtime.claimApprovals('thread', [{ runId: 'R', toolCallId: 'call-1' }])
      const assertion = expect(pending).rejects.toMatchObject({
        status: 409,
        message: 'stale-run'
      })
      await vi.advanceTimersByTimeAsync(2000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('真的没有这一轮（也没有已消费证据）：宽限窗口后仍报 stale-run', async () => {
    vi.useFakeTimers()
    try {
      const runtime = approvalRuntime({ runs: [], messages: [] })
      const pending = runtime.claimApprovals('thread', [{ runId: 'R', toolCallId: 'call-1' }])
      const assertion = expect(pending).rejects.toMatchObject({
        status: 409,
        message: 'stale-run'
      })
      await vi.advanceTimersByTimeAsync(2000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('内部错误码有人话：错误框不再只有 {"error":"stale-run"}', () => {
    expect(askUserErrorText('stale-run')).toContain('运行')
    expect(askUserErrorText('stale-run')).not.toBe('stale-run')
    expect(askUserErrorText('thread-busy')).toContain('会话')
    expect(askUserErrorText('unknown-code')).toContain('重试')
  })
})

