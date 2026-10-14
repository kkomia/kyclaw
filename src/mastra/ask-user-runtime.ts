import type { Agent, AgentRun, AgentRunToolCall } from '@mastra/core/agent'
import type { MastraMemory } from '@mastra/core/memory'
import type { LibSQLStore } from '@mastra/libsql'
import {
  validateAskUserAnswer,
  validateAskUserInput,
  type AskUserAnswer,
  type AskUserInput
} from '../shared/ask-user'
import { LOCAL_USER_RESOURCE_ID } from '../shared/threads'

export class AskUserHttpError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string
  ) {
    super(message)
  }
}

const runtimes = new WeakMap<MastraMemory, AskUserRuntime>()
export function askUserRuntimeFor(memory: MastraMemory): AskUserRuntime | undefined {
  return runtimes.get(memory)
}

export interface StreamLease {
  release(): void
  bindStop(stop: () => Promise<void>): void
}

type ActiveExecution = {
  token: symbol
  threadId: string
  done: Promise<void>
  release: () => void
  stop: () => Promise<void>
}
type ActiveRun = ActiveExecution & {
  run: AgentRun
  messageIds: Set<string>
}
type SuspendedInteraction = {
  threadId: string
  runId: string
  toolCallId: string
  toolName: AgentRunToolCall['toolName']
  suspendPayload: AgentRunToolCall['suspendPayload']
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export class AskUserRuntime {
  private readonly active = new Map<string, ActiveRun>()
  private readonly reserved = new Map<string, symbol>()
  private readonly initial = new Map<symbol, ActiveExecution>()
  private readonly changingThreads = new Set<string>()

  claimInitial(threadId: string): StreamLease {
    if (
      this.changingThreads.has(threadId) ||
      [...this.initial.values(), ...this.active.values()].some((run) => run.threadId === threadId)
    )
      throw new AskUserHttpError(409, 'thread-busy')
    const token = Symbol('initial-stream')
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    let bind!: (stop: () => Promise<void>) => void
    const bound = new Promise<() => Promise<void>>((resolve) => {
      bind = resolve
    })
    const execution: ActiveExecution = {
      token,
      threadId,
      done,
      release: finish,
      stop: async () => {
        await (
          await bound
        )()
      }
    }
    this.initial.set(token, execution)
    const release = (): void => {
      if (this.initial.get(token) !== execution) return
      this.initial.delete(token)
      bind(async () => {})
      finish()
    }
    return { release, bindStop: bind }
  }

  constructor(
    private readonly agent: Agent,
    private readonly memory: MastraMemory,
    private readonly storage: LibSQLStore
  ) {
    runtimes.set(memory, this)
  }

  private async runs(threadId: string): Promise<AgentRun[]> {
    const thread = await this.memory.getThreadById({ threadId })
    if (!thread || thread.resourceId !== LOCAL_USER_RESOURCE_ID) return []
    const { runs } = await this.agent.listSuspendedRuns({
      threadId,
      resourceId: LOCAL_USER_RESOURCE_ID
    })
    return runs.filter(
      (run) => run.threadId === threadId && run.resourceId === LOCAL_USER_RESOURCE_ID
    )
  }

  async pending(threadId: string): Promise<{
    pending: Array<{ runId: string; toolCallId: string; input: AskUserInput; suspendedAt: string }>
  }> {
    const pending: Array<{
      runId: string
      toolCallId: string
      input: AskUserInput
      suspendedAt: string
    }> = []
    const { messages } = await this.memory.recall({ threadId, perPage: false, hideSignals: false })
    const cancelled = new Set(
      messages.flatMap((message) => strings(record(message.content.metadata).askUserCancelledRuns))
    )
    for (const run of await this.runs(threadId)) {
      if (cancelled.has(run.runId)) continue
      for (const tool of run.toolCalls) {
        if (tool.toolName !== 'ask_user' || !tool.toolCallId || tool.requiresApproval) continue
        pending.push({
          runId: run.runId,
          toolCallId: tool.toolCallId,
          input: validateAskUserInput(tool.suspendPayload),
          suspendedAt: new Date(run.suspendedAt).toISOString()
        })
      }
    }
    return { pending }
  }

  async assertThread(threadId: string): Promise<void> {
    const thread = await this.memory.getThreadById({ threadId })
    if (!thread || thread.resourceId !== LOCAL_USER_RESOURCE_ID)
      throw new AskUserHttpError(409, 'stale-thread')
  }

  async listSuspended(
    threadId: string
  ): Promise<Array<SuspendedInteraction & { requiresApproval: boolean }>> {
    await this.assertThread(threadId)
    const { messages } = await this.memory.recall({ threadId, perPage: false, hideSignals: false })
    const cancelled = new Set(
      messages.flatMap((message) => strings(record(message.content.metadata).askUserCancelledRuns))
    )
    return (await this.runs(threadId))
      .filter((run) => !cancelled.has(run.runId))
      .flatMap((run) =>
        run.toolCalls
          .filter((tool) => tool.toolCallId)
          .map((tool) => ({
            threadId,
            runId: run.runId,
            toolCallId: tool.toolCallId!,
            toolName: tool.toolName,
            requiresApproval: tool.requiresApproval,
            suspendPayload: tool.suspendPayload
          }))
      )
  }

  async claimSuspend(
    threadId: string,
    runId: string,
    toolCallId: string,
    expectedToolName: string
  ): Promise<StreamLease & { target: SuspendedInteraction }> {
    const claim = await this.acquire(threadId, [
      { runId, toolCallId, approval: false, expectedToolName }
    ])
    const selected = claim.selected[0]
    return {
      release: claim.release,
      bindStop: claim.bindStop,
      target: {
        threadId,
        runId: selected.run.runId,
        toolCallId: selected.tool.toolCallId!,
        toolName: selected.tool.toolName,
        suspendPayload: selected.tool.suspendPayload
      }
    }
  }

  async withIdleThread<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    if (
      this.changingThreads.has(threadId) ||
      [...this.initial.values(), ...this.active.values()].some((run) => run.threadId === threadId)
    )
      throw new AskUserHttpError(409, 'thread-busy')
    this.changingThreads.add(threadId)
    try {
      await this.assertThread(threadId)
      if ((await this.listSuspended(threadId)).length)
        throw new AskUserHttpError(409, 'pending-interaction')
      return await operation()
    } finally {
      this.changingThreads.delete(threadId)
    }
  }

  private async acquire(
    threadId: string,
    targets: Array<{
      runId: string
      toolCallId: string
      approval: boolean
      expectedToolName?: string
    }>,
    options?: { tolerateConsumedApprovals?: boolean }
  ): Promise<StreamLease & { selected: Array<{ run: AgentRun; tool: AgentRunToolCall }> }> {
    const ids = [...new Set(targets.map((target) => target.runId))].sort()
    if (this.changingThreads.has(threadId) || ids.some((id) => this.reserved.has(id)))
      throw new AskUserHttpError(409, 'run-busy')
    const token = Symbol('run-claim')
    ids.forEach((id) => this.reserved.set(id, token))
    let bindStop!: (stop: () => Promise<void>) => void
    const bound = new Promise<() => Promise<void>>((resolve) => {
      bindStop = resolve
    })
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      bindStop(async () => {})
      for (const id of ids) {
        const active = this.active.get(id)
        if (active?.token === token) {
          active.release()
          this.active.delete(id)
        }
        if (this.reserved.get(id) === token) this.reserved.delete(id)
      }
    }
    const stop = async (): Promise<void> => {
      await (
        await bound
      )()
    }
    try {
      const runs = await this.runs(threadId)
      const { messages } = await this.memory.recall({
        threadId,
        perPage: false,
        hideSignals: false
      })
      // 同一步多条审批时，客户端把「已回应的兄弟审批」与「仍挂起的那一条」打包进同一条续跑请求
      // （渲染端只看最后一步，见 approval.ts 的 canResumeAfterApproval）。已消费的审批不在当前
      // 快照里，但**不会重执行**：SDK 仍按原 (runId, toolCallId) 调 resumeStream，快照里查不到即报
      // AGENT_RESUME_TOOL_CALL_NOT_SUSPENDED 并跳过（@mastra/ai-sdk 的 streamV6ApprovalResumes）。
      //
      // 只放过有「同 run 持久化证据」的目标：toolCallId 必须绑到该 run —— 额度元数据里 runId 对得上
      // 的登记，或落在「该 run 登记的助手消息」里的 tool-invocation 部件。凭空编的 id、异 run 的部件、
      // 非助手消息一律不放过（仍 409）。
      const consumed = new Set<string>()
      const consumedKey = (runId: string, toolCallId: string): string => `${runId}::${toolCallId}`
      if (options?.tolerateConsumedApprovals)
        for (const message of messages) {
          if (message.role !== 'assistant') continue
          const parts = message.content.parts ?? []
          const metadata = record(message.content.metadata)
          const messageRunIds = new Set<string>()
          for (const key of ['suspendedTools', 'pendingToolApprovals'])
            for (const [toolId, entry] of Object.entries(record(metadata[key]))) {
              const entryRecord = record(entry)
              const runId = String(entryRecord.runId ?? '')
              if (!ids.includes(runId)) continue
              messageRunIds.add(runId)
              consumed.add(consumedKey(runId, String(entryRecord.toolCallId ?? toolId)))
            }
          for (const part of parts) {
            const data = record(record(part).data)
            const runId = String(data.runId ?? '')
            if (typeof data.toolCallId === 'string' && ids.includes(runId)) {
              messageRunIds.add(runId)
              consumed.add(consumedKey(runId, data.toolCallId))
            }
          }
          if (messageRunIds.size === 0) continue
          for (const part of parts) {
            const invocation = record(record(part).toolInvocation)
            if (typeof invocation.toolCallId === 'string')
              for (const runId of messageRunIds)
                consumed.add(consumedKey(runId, invocation.toolCallId))
          }
        }
      const selected = targets.flatMap((target) => {
        const run = runs.find((item) => item.runId === target.runId)
        if (!run) throw new AskUserHttpError(409, 'stale-run')
        const tool = run.toolCalls.find((item) => item.toolCallId === target.toolCallId)
        if (!tool) {
          if (
            options?.tolerateConsumedApprovals &&
            target.approval &&
            consumed.has(consumedKey(target.runId, target.toolCallId))
          )
            return []
          throw new AskUserHttpError(409, 'stale-run')
        }
        if (
          target.approval !== tool.requiresApproval ||
          (!target.approval && tool.toolName !== (target.expectedToolName ?? 'ask_user'))
        )
          throw new AskUserHttpError(409, 'wrong-tool')
        return [{ run, tool }]
      })
      if (selected.length === 0) throw new AskUserHttpError(409, 'stale-run')
      const persistedThread = await this.memory.getThreadById({ threadId })
      if (
        ids.some((id) =>
          strings(record(persistedThread?.metadata).cancelledInteractionRuns).includes(id)
        ) ||
        messages.some((message) =>
          ids.some((id) =>
            strings(record(message.content.metadata).askUserCancelledRuns).includes(id)
          )
        )
      )
        throw new AskUserHttpError(409, 'cancelled-run')
      for (const id of ids) {
        const run = selected.find((item) => item.run.runId === id)?.run
        if (!run) continue
        const messageIds = new Set(
          messages
            .filter((message) => {
              const metadata = record(message.content.metadata)
              return (
                [
                  ...Object.values(record(metadata.suspendedTools)),
                  ...Object.values(record(metadata.pendingToolApprovals))
                ].some((entry) => record(entry).runId === id) ||
                (message.content.parts ?? []).some((part) => record(record(part).data).runId === id)
              )
            })
            .map((message) => message.id)
        )
        let finish!: () => void
        const done = new Promise<void>((resolve) => {
          finish = resolve
        })
        this.active.set(id, {
          token,
          threadId,
          run,
          messageIds,
          done,
          release: finish,
          stop: () => stop()
        })
      }
      if (this.changingThreads.has(threadId)) throw new AskUserHttpError(409, 'thread-busy')
      return { selected, release, bindStop }
    } catch (error) {
      release()
      throw error
    }
  }

  async claim(
    threadId: string,
    runId: string,
    toolCallId: string,
    resumeData: unknown
  ): Promise<StreamLease & { answer: AskUserAnswer }> {
    const claim = await this.acquire(threadId, [{ runId, toolCallId, approval: false }])
    try {
      const answer = validateAskUserAnswer(
        validateAskUserInput(claim.selected[0].tool.suspendPayload),
        resumeData
      )
      return { answer, release: claim.release, bindStop: claim.bindStop }
    } catch (error) {
      claim.release()
      throw new AskUserHttpError(400, error instanceof Error ? error.message : 'invalid-answer')
    }
  }

  async claimApprovals(
    threadId: string,
    targets: Array<{ runId: string; toolCallId: string }>
  ): Promise<StreamLease> {
    const claim = await this.acquire(
      threadId,
      targets.map((target) => ({ ...target, approval: true })),
      { tolerateConsumedApprovals: true }
    )
    return { release: claim.release, bindStop: claim.bindStop }
  }

  async withThreadChange<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    if (this.changingThreads.has(threadId)) throw new AskUserHttpError(409, 'thread-busy')
    this.changingThreads.add(threadId)
    try {
      await this.cancelLocked(threadId)
      return await operation()
    } finally {
      if (
        ![...this.initial.values(), ...this.active.values()].some(
          (active) => active.threadId === threadId
        )
      )
        this.changingThreads.delete(threadId)
    }
  }

  async cancel(
    threadId: string,
    runId?: string
  ): Promise<{ status: 'cancelled'; runIds: string[] }> {
    if (this.changingThreads.has(threadId)) throw new AskUserHttpError(409, 'thread-busy')
    this.changingThreads.add(threadId)
    try {
      return await this.cancelLocked(threadId, runId)
    } finally {
      if (
        ![...this.initial.values(), ...this.active.values()].some(
          (active) => active.threadId === threadId
        )
      )
        this.changingThreads.delete(threadId)
    }
  }

  private async cancelLocked(
    threadId: string,
    runId?: string
  ): Promise<{ status: 'cancelled'; runIds: string[] }> {
    const thread = await this.memory.getThreadById({ threadId })
    if (!thread || thread.resourceId !== LOCAL_USER_RESOURCE_ID)
      throw new AskUserHttpError(409, 'stale-thread')
    const initial = [...this.initial.values()].filter((active) => active.threadId === threadId)
    const activeRuns = [...this.active].filter(
      ([id, active]) => active.threadId === threadId && (!runId || id === runId)
    )
    const targets = new Map(
      (await this.runs(threadId))
        .filter((run) => !runId || run.runId === runId)
        .map((run) => [run.runId, run])
    )
    this.agent.abortThreadStream({ threadId, resourceId: LOCAL_USER_RESOURCE_ID })
    for (const active of initial) {
      await active.stop()
      active.release()
    }
    const activeMessages = new Map<string, Set<string>>()
    for (const [id, active] of activeRuns) {
      if (active.run.threadId !== threadId || (runId && id !== runId)) continue
      targets.set(id, active.run)
      activeMessages.set(id, active.messageIds)
      this.agent.abortRunStream(id)
      await active.stop()
      active.release()
    }
    for (const run of await this.runs(threadId))
      if (!runId || run.runId === runId) targets.set(run.runId, run)
    await this.memory.settled()
    const { messages } = await this.memory.recall({ threadId, perPage: false, hideSignals: false })
    if (runId && targets.size === 0) {
      if (
        messages.some((message) =>
          strings(record(message.content.metadata).askUserCancelledRuns).includes(runId)
        ) ||
        strings(record(thread.metadata).cancelledInteractionRuns).includes(runId)
      )
        return { status: 'cancelled', runIds: [runId] }
      throw new AskUserHttpError(409, 'stale-run')
    }
    const ids = new Set(targets.keys())
    const changed = messages.flatMap((message) => {
      if (message.role !== 'assistant') return []
      const metadata = { ...message.content.metadata }
      const localToolIds = new Set<string>()
      const localRunIds = new Set<string>()
      for (const [id, target] of targets) {
        const matchesTool = (message.content.parts ?? []).some(
          (part) =>
            part.type === 'tool-invocation' &&
            target.toolCalls.some((tool) => tool.toolCallId === part.toolInvocation.toolCallId)
        )
        if (!activeMessages.get(id)?.has(message.id) && !matchesTool) continue
        localRunIds.add(id)
        for (const tool of target.toolCalls) if (tool.toolCallId) localToolIds.add(tool.toolCallId)
      }
      for (const key of ['suspendedTools', 'pendingToolApprovals']) {
        const entries = record(metadata[key])
        metadata[key] = Object.fromEntries(
          Object.entries(entries).filter(([toolId, entry]) => {
            const run = String(record(entry).runId ?? '')
            if (!ids.has(run)) return true
            localToolIds.add(String(record(entry).toolCallId ?? toolId))
            localRunIds.add(run)
            return false
          })
        )
      }
      for (const part of message.content.parts ?? []) {
        const data = record(record(part).data)
        if (ids.has(String(data.runId ?? ''))) {
          localRunIds.add(String(data.runId))
          if (typeof data.toolCallId === 'string') localToolIds.add(data.toolCallId)
        }
      }
      if (message.id === messages.findLast((item) => item.role === 'assistant')?.id)
        for (const id of ids) localRunIds.add(id)
      if (localRunIds.size === 0) return []
      metadata.askUserCancelledRuns = [
        ...new Set([...strings(metadata.askUserCancelledRuns), ...localRunIds])
      ]
      const parts = (message.content.parts ?? []).flatMap((part) => {
        const data = record(record(part).data)
        if (
          (part.type === 'data-tool-call-suspended' || part.type === 'data-tool-call-approval') &&
          ids.has(String(data.runId ?? ''))
        )
          return []
        if (
          part.type === 'tool-invocation' &&
          localToolIds.has(String(record(record(part).toolInvocation).toolCallId ?? ''))
        ) {
          return [
            {
              ...part,
              toolInvocation: {
                ...part.toolInvocation,
                state: 'result' as const,
                result: { status: 'cancelled' }
              }
            }
          ]
        }
        return [part]
      })
      return [{ ...message, content: { ...message.content, metadata, parts } }]
    })
    if (changed.length) await this.memory.saveMessages({ messages: changed })
    if (ids.size)
      await this.memory.updateThread({
        id: threadId,
        title: thread.title ?? '',
        metadata: {
          ...thread.metadata,
          cancelledInteractionRuns: [
            ...new Set([...strings(record(thread.metadata).cancelledInteractionRuns), ...ids])
          ]
        }
      })
    const workflows = await this.storage.getStore('workflows')
    if (!workflows) throw new Error('workflow storage unavailable')
    const stored = await workflows.listWorkflowRuns({
      resourceId: LOCAL_USER_RESOURCE_ID,
      perPage: false
    })
    for (const run of stored.runs)
      if (ids.has(run.runId))
        await workflows.deleteWorkflowRunById({ runId: run.runId, workflowName: run.workflowName })
    await this.memory.settled()
    return { status: 'cancelled', runIds: [...ids] }
  }
}
