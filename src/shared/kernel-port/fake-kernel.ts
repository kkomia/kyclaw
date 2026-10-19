/**
 * B2 fake kernel：**不启动任何进程**，只按 `SessionEvent` 语义产出事件序列。
 *
 * 用途：
 *   - 让适配层/UI 在 feature flag 关闭的今天也能演练"内核形状"（surfaceOp replace、SessionSeq、
 *     turn/end、工具事件、usage）；
 *   - 给 replay/投影测试提供确定性输入。
 *
 * 语义依据：B1.5 真机 POC（`.superpowers/dev-verify/20261019-0.2.0/bao/poc-kernel-boot.md`）——
 * 一轮 = `session → turn_start → step_start → text → step_end{usage 12/8/20} → turn_end completed → final`；
 * 这里把 headless NDJSON 映射成内核 `SessionEvent` 形状（`session/created` / `user/message` /
 * `assistant/message`（带 `surfaceOp.replace`）/ `tool/call` / `tool/result` / `turn/end`）。
 */
import type {
  GoalMutation,
  InteractionRequest,
  InteractionResponse,
  KernelGoal,
  SessionEvent,
  SessionSeq,
  ToolDescriptor,
  UsageSnapshot
} from './types'
import type { GoalPort, InteractionPort, KernelPort, UsagePort } from './ports'

export interface FakeKernelOptions {
  sessionId?: string
  /** 一轮的最终回答（默认取 POC 实测文本） */
  finalText?: string
  /** 是否插入一次工具调用/结果（默认插入一次 read 工具） */
  withTool?: boolean
  /** 用量；默认 = POC 实测 12/8/20（provider） */
  usage?: UsageSnapshot
}

/** `Omit` 的分布版本：对联合类型的每个成员分别去掉 `seq` */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export interface FakeKernel extends KernelPort {
  readonly sessionId: string
  /** 已产生的事件（只追加） */
  readonly emitted: readonly SessionEvent[]
  readonly usage: UsagePort
  readonly goal: GoalPort
  readonly interaction: InteractionPort
  /** 驱动一轮（返回本轮事件；同时推给订阅者与 replay） */
  runTurn(text: string): Promise<{ events: readonly SessionEvent[]; finalText: string }>
}

const POC_FINAL_TEXT = 'POC-OK：内核会话与事件流可用。'

const POC_USAGE: UsageSnapshot = {
  inputTokens: 12,
  outputTokens: 8,
  totalTokens: 20,
  exactness: 'provider',
  turn: 1
}

export function createFakeKernel(options: FakeKernelOptions = {}): FakeKernel {
  const sessionId = options.sessionId ?? 'session-fake-b2'
  const finalText = options.finalText ?? POC_FINAL_TEXT
  const usage = options.usage ?? POC_USAGE
  const withTool = options.withTool ?? true

  const emitted: SessionEvent[] = []
  const listeners = new Set<(event: SessionEvent) => void>()
  let seq: SessionSeq = 0
  let goal: KernelGoal | null = null
  const interactions: InteractionRequest[] = []
  let interactionResponder: ((response: InteractionResponse) => void) | null = null

  /** 追加事件：补 `seq`、通知订阅者、返回同一个事件对象 */
  const push = (input: DistributiveOmit<SessionEvent, 'seq'>): SessionEvent => {
    seq += 1
    const event = { ...input, seq } as SessionEvent
    emitted.push(event)
    for (const listener of listeners) listener(event)
    return event
  }

  const sessions: KernelPort['sessions'] = {
    async createSession() {
      if (!emitted.some((event) => event.type === 'session/created'))
        push({ type: 'session/created', sessionId })
      return { id: sessionId }
    },
    async postUserMessage(targetSessionId, text) {
      if (targetSessionId !== sessionId)
        throw new Error(`fake kernel: unknown session ${targetSessionId}`)
      push({
        type: 'user/message',
        message: {
          id: `user-${String(seq + 1)}`,
          role: 'user',
          parts: [{ type: 'text', text }],
          createdAt: Date.now()
        }
      })
      return { acceptedSeq: seq }
    },
    async cancel() {
      push({ type: 'turn/end', turn: 1, reason: { kind: 'cancelled', cause: 'fake-cancel' } })
    },
    async close() {
      // no-op：fake kernel 没有进程
    }
  }

  const events: KernelPort['events'] = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async *replay(fromSeq = 1) {
      for (const event of emitted) if (event.seq >= fromSeq) yield event
    }
  }

  const commands: KernelPort['commands'] = {
    list: () => [
      { name: 'compact', title: '压缩上下文', description: '压缩会话历史' },
      { name: 'plan', title: '进入规划模式', description: '先计划再执行' },
      {
        name: 'goal',
        title: '目标',
        description: '设置/管理本会话目标',
        acceptsAttachments: true
      }
    ],
    async execute(name) {
      if (name === 'compact') return { ok: true, text: 'fake: 上下文已压缩' }
      if (name === 'plan') return { ok: true, text: 'fake: 已进入规划模式' }
      if (name === 'goal') return { ok: true, text: 'fake: goal 命令已执行' }
      return { ok: false, message: `fake kernel: 未知命令 ${name}` }
    }
  }

  const toolList: ToolDescriptor[] = [
    { name: 'read', description: '读取文件' },
    { name: 'hindsight_reflect', description: '检索项目记忆（A 级插件注入示例）' }
  ]
  const tools: KernelPort['tools'] = {
    list: () => toolList,
    async invoke(toolName, args) {
      if (!toolList.some((tool) => tool.name === toolName))
        return { ok: false, message: `fake kernel: 未注册工具 ${toolName}` }
      if (toolName === 'read')
        return { ok: true, result: { text: `fake read ${JSON.stringify(args)}` } }
      return { ok: true, result: { memory: 'fake hindsight memory' } }
    }
  }

  const runTurn = async (
    text: string
  ): Promise<{ events: readonly SessionEvent[]; finalText: string }> => {
    const startIndex = emitted.length
    await sessions.createSession()
    await sessions.postUserMessage(sessionId, text)

    if (withTool) {
      push({
        type: 'tool/call',
        toolCallId: 'call-fake-1',
        toolName: 'read',
        args: { path: 'README.md' }
      })
      push({
        type: 'tool/result',
        toolCallId: 'call-fake-1',
        toolName: 'read',
        result: { text: 'fake tool result' }
      })
    }

    // 第一次 assistant 消息（片段），随后用 surfaceOp replace 换成最终消息 —— 内核语义的漂移闸门
    const partial = push({
      type: 'assistant/message',
      message: {
        id: 'assistant-fake-1',
        role: 'assistant',
        parts: [{ type: 'text', text: finalText.slice(0, 3) }],
        createdAt: Date.now()
      }
    })
    push({
      type: 'assistant/message',
      message: {
        id: 'assistant-fake-1',
        role: 'assistant',
        parts: [{ type: 'text', text: finalText }],
        createdAt: Date.now()
      },
      surfaceOp: { op: 'replace', startSeq: partial.seq, endSeq: partial.seq }
    })

    push({ type: 'assistant/attempt', turn: 1, attempt: 1, outcome: 'succeeded' })
    push({ type: 'turn/end', turn: 1, reason: { kind: 'completed' }, usage })

    return { events: emitted.slice(startIndex), finalText }
  }

  const usagePort: UsagePort = {
    async read() {
      const latest = [...emitted].reverse().find((event) => event.type === 'turn/end')
      if (latest?.type === 'turn/end' && latest.usage !== undefined) return latest.usage
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0, exactness: 'unknown' }
    }
  }

  const goalPort: GoalPort = {
    async read() {
      return goal
    },
    async apply(_sessionId: string, mutation: GoalMutation) {
      if (mutation.action === 'create') {
        goal = {
          id: 'goal-fake-1',
          revision: 1,
          objective: mutation.objective,
          phase: 'active',
          roundsStarted: 0,
          maxGoalRounds: mutation.maxGoalRounds ?? 256
        }
        return goal
      }
      if (goal === null) throw new Error('fake kernel: no goal')
      if (mutation.ref.id !== goal.id || mutation.ref.revision !== goal.revision)
        throw new Error('fake kernel: stale goal revision')
      if (mutation.action === 'clear') {
        goal = null
        return null
      }
      const next: KernelGoal = { ...goal, revision: goal.revision + 1 }
      if (mutation.action === 'edit') {
        if (mutation.objective !== undefined) next.objective = mutation.objective
        if (mutation.maxGoalRounds !== undefined) next.maxGoalRounds = mutation.maxGoalRounds
      } else if (mutation.action === 'pause') next.phase = 'paused'
      else if (mutation.action === 'resume') next.phase = 'active'
      else if (mutation.action === 'complete') next.phase = 'complete'
      else if (mutation.action === 'block') {
        next.phase = 'blocked'
        next.blockedReason = mutation.blocked
      }
      goal = next
      return goal
    }
  }

  const interactionPort: InteractionPort = {
    async *requests() {
      for (const request of interactions) yield request
    },
    async respond(response) {
      interactionResponder?.(response)
      interactionResponder = null
    }
  }

  return {
    sessionId,
    emitted,
    events,
    commands,
    tools,
    sessions,
    usage: usagePort,
    goal: goalPort,
    interaction: interactionPort,
    runTurn
  }
}
