// @vitest-environment node
/**
 * B3.4 持久化/resume 的**聚焦测试**：不需要真内核二进制，mock 掉传输层（RPC + WS mux），
 * 只验证 `kernel-adapter` 的会话状态机与文案映射。真机端到端仍在
 * `b3-4-persistence.integration.spec.ts`（`KYCLAW_KERNEL_E2E=1` 才跑）。
 *
 * 覆盖三条硬要求：
 *   1. 刷新后 reattach 续接：opening 用内核自带的 `startedAfterSeq`/`nextIndex`，
 *      在跑的一轮挂到新流上、旧流的迟到帧不重复；
 *   2. 多 session 不串号：`threadId` 直接当内核 `sessionId`，两个 thread 的帧各归各的；
 *   3. writer-held / conflict / agent-busy 文案映射：当一等错误上报，不静默吞掉。
 *
 * fake 的语义按内核行为建模（`session/create` 复用规则、单写者 `session/writer-held`、
 * 跨目录 `session/conflict`、follow opening 带 `assistantStream.activeAttempt`）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sameCwd, startKernelAdapter, type KernelAdapter } from '../kernel-adapter'
import { InteractionHub, feedKernelEvent } from '../interaction-hub'
import { approvalOutcomeCopy } from '../interaction-hub'

const kernel = vi.hoisted(() => {
  interface FakeSession {
    sessionId: string
    cwd: string
    running: boolean
    blank: boolean
    activeAttempt?: { attemptId: string; startedAfterSeq: number; nextIndex: number }
    /** 内核 session/projections 里的 goal / plan（每会话独立，用来验证命令面不串号） */
    goal?: {
      goal: {
        id: string
        objective: string
        phase: 'active' | 'paused' | 'blocked' | 'complete'
        maxGoalRounds: number
        revision: number
      }
      roundsStarted: number
      createdAt: number
      updatedAt: number
    }
    plan?: { active: boolean; pending: boolean }
  }

  /** 内核 rc.2 实测的命令清单（docs: 见 bao/b3-3-commands-goal.md §1） */
  const COMMANDS = ['compact', 'export', 'feedback', 'goal', 'permission', 'plan']

  const state = {
    sessions: new Map<string, FakeSession>(),
    /** streamId → 订阅的 session */
    streams: new Map<string, string>(),
    sent: [] as Array<Record<string, unknown>>,
    prompts: [] as Array<{ sessionId: string; text: string }>,
    creates: [] as Array<{ cwd: string; sessionId?: string }>,
    /** commands/execute 真的被调用的记录（验证未知命令没被发给内核） */
    executes: [] as Array<{ agentId: string; line: string }>,
    /** 这些 sessionId 的 prompt 会被内核以 session/writer-held 拒绝 */
    writerHeld: new Set<string>(),
    /** 这些 sessionId 的 create 会被内核以 session/conflict 拒绝 */
    createConflicts: new Set<string>(),
    /** 这些 sessionId 的 follow open 直接回 error 帧 */
    followErrors: new Map<string, { code: string; message: string }>(),
    /** 覆盖 session/list 里回给宿主的 cwd 写法（模拟内核归一化差异） */
    listCwdOverride: new Map<string, string>(),
    /** commands/list 是否失败（验证清单拉不到时不阻断已知命令） */
    listCommandsFails: false,
    /** PB-025：`$events` 流（交互 waterfall） */
    eventsStreams: [] as string[],
    eventsOpens: [] as Array<Record<string, unknown>>,
    remoteResults: [] as Array<Record<string, unknown>>,
    continuedAnswers: [] as Array<{ agentId: string; callId: string; answer: unknown }>,
    /** 是否在 $events open 时立刻发 ready 帧（测"没就绪就应答"时关掉） */
    autoReady: true,
    /** 模拟内核 fail-closed：非法审批值归一成 unavailable，记生效值 */
    effectiveApprovals: [] as string[],
    seq: 100,
    autoSession: 0,
    attemptCount: 0,
    commandCount: 0
  }

  let onMessage: ((text: string) => void) | undefined
  let onClose: ((error?: Error) => void) | undefined

  const emit = (message: unknown): void => {
    onMessage?.(JSON.stringify(message))
  }
  const item = (streamId: string, value: unknown): void => {
    emit({ type: 'item', streamId, value })
  }
  /** 某 session 当前还没被 cancel 的 follow 流（正常只有一条） */
  const openStreams = (sessionId: string): string[] =>
    [...state.streams.entries()].filter(([, id]) => id === sessionId).map(([streamId]) => streamId)

  const snapshotValue = (sessionId: string): Record<string, unknown> => {
    const session = state.sessions.get(sessionId)
    const attempt = session?.activeAttempt
    return {
      type: 'snapshot',
      cursor: state.seq,
      records: [],
      hasMore: false,
      // 真机空闲会话的 opening 只有 revision（见 fixtures/kernel-follow-frames.json）；
      // 正在跑的一轮由 activeAttempt 带出 startedAfterSeq / nextIndex
      assistantStream:
        attempt === undefined
          ? { revision: 1 }
          : {
              revision: 1,
              activeAttempt: {
                attemptId: attempt.attemptId,
                startedAfterSeq: attempt.startedAfterSeq,
                nextIndex: attempt.nextIndex
              }
            }
    }
  }

  const frame = (streamId: string, attemptId: string, chunk: unknown): void => {
    item(streamId, { type: 'assistant-stream', frame: { type: 'chunk', attemptId, chunk } })
  }

  /** 内核把一轮的帧推给所有 follow 流，然后事件流收口 */
  const finishTurn = (sessionId: string, text: string, kind: 'completed' | 'cancelled'): void => {
    const session = state.sessions.get(sessionId)
    const attemptId = session?.activeAttempt?.attemptId ?? 'attempt-missing'
    for (const streamId of openStreams(sessionId)) {
      if (kind === 'completed') {
        item(streamId, { type: 'assistant-stream', frame: { type: 'start', attemptId } })
        frame(streamId, attemptId, { type: 'block-start', index: 0, blockType: 'text' })
        frame(streamId, attemptId, { type: 'text-delta', index: 0, text })
        frame(streamId, attemptId, { type: 'block-end', index: 0 })
        frame(streamId, attemptId, { type: 'finish', reason: { kind: 'stop' } })
        item(streamId, { type: 'assistant-stream', frame: { type: 'end', attemptId } })
      }
      state.seq += 1
      item(streamId, {
        type: 'event',
        event: { type: 'turn/end', seq: state.seq, data: { reason: { kind } } }
      })
    }
    if (session !== undefined) {
      session.running = false
      session.activeAttempt = undefined
    }
  }

  const rpc = async (endpoint: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const request = (args.request ?? {}) as Record<string, unknown>
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
    switch (endpoint) {
      case 'session/create': {
        const cwd = String(request.cwd ?? '')
        if (sessionId !== undefined) state.creates.push({ cwd, sessionId })
        const conflict = (): Error =>
          new Error(
            'kernel rpc: session/create failed (session/conflict): session id belongs to another cwd'
          )
        if (sessionId !== undefined && state.createConflicts.has(sessionId)) throw conflict()
        if (sessionId !== undefined) {
          const existing = state.sessions.get(sessionId)
          if (existing !== undefined) {
            if (existing.cwd !== cwd) throw conflict()
            return { sessionId }
          }
        }
        const created = sessionId ?? `auto-session-${String((state.autoSession += 1))}`
        state.sessions.set(created, { sessionId: created, cwd, running: false, blank: true })
        return { sessionId: created }
      }
      case 'session/list':
        return {
          items: [...state.sessions.values()].map((session) => ({
            sessionId: session.sessionId,
            cwd: state.listCwdOverride.get(session.sessionId) ?? session.cwd,
            running: session.running,
            blank: session.blank
          }))
        }
      case 'session/prompt': {
        const id = sessionId ?? ''
        const session = state.sessions.get(id)
        if (session === undefined)
          throw new Error('kernel rpc: session/prompt failed (gateway/internal): unknown session')
        if (state.writerHeld.has(id))
          throw new Error(
            `kernel rpc: session/prompt failed (session/writer-held): another writer holds ${id}`
          )
        const content = Array.isArray(request.content) ? request.content : []
        const first = content[0] as { text?: unknown } | undefined
        const text = typeof first?.text === 'string' ? first.text : ''
        state.attemptCount += 1
        state.prompts.push({ sessionId: id, text })
        session.running = true
        session.blank = false
        session.activeAttempt = {
          attemptId: `attempt-${String(state.attemptCount)}`,
          startedAfterSeq: state.seq,
          nextIndex: 0
        }
        return {}
      }
      case 'session/cancel': {
        finishTurn(sessionId ?? '', '', 'cancelled')
        return {}
      }
      case 'session/projections': {
        // 投影按 session 分开返回：命令面/投影面"传 threadId 不串号"靠这里验
        const session = state.sessions.get(sessionId ?? '')
        return {
          values: {
            goal: session?.goal ?? null,
            plan: session?.plan ?? { active: false, pending: false }
          }
        }
      }
      case 'test/echo':
        // PB-024：裸 rpcCall 透传用（原样回显 method 收到的 payload）
        return { received: args }
      case 'test/boom':
        throw new Error('kernel rpc: test/boom failed (gateway/internal): boom')
      case '$events/result': {
        // PB-025：模拟网关校验 + 内核 fail-closed（非法审批值 → unavailable）
        state.remoteResults.push(args)
        const outcome = args.outcome as { kind?: unknown; value?: unknown } | undefined
        if (outcome?.kind === 'result') {
          const value = outcome.value
          const raw = typeof value === 'string' ? value : undefined
          const effective = ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(
            raw ?? ''
          )
            ? (raw as string)
            : 'unavailable'
          state.effectiveApprovals.push(effective)
        }
        return {}
      }
      case 'userQuestions/answer': {
        const agentId = typeof args.agentId === 'string' ? args.agentId : ''
        const callId = typeof args.callId === 'string' ? args.callId : ''
        state.continuedAnswers.push({ agentId, callId, answer: args.answer })
        return false
      }
      case 'commands/list': {
        if (state.listCommandsFails)
          throw new Error('kernel rpc: commands/list failed (gateway/internal): boom')
        return COMMANDS.map((name) => ({ name, description: `${name} command` }))
      }
      case 'commands/execute': {
        // 真实内核语义：只认已知命令；未识别行**返回 undefined 且不发事件**（Eve 的 F2 实证）
        const agentId = typeof args.agentId === 'string' ? args.agentId : ''
        const line = typeof args.line === 'string' ? args.line : ''
        const session = state.sessions.get(agentId)
        if (session === undefined) return undefined
        state.executes.push({ agentId, line })
        const name = line.trim().replace(/^\//u, '').split(/\s+/u)[0] ?? ''
        if (!COMMANDS.includes(name)) return undefined
        state.commandCount += 1
        const commandId = `cmd-${String(state.commandCount)}`
        if (name === 'goal') {
          const rest = line.trim().replace(/^\/goal\s*/u, '')
          if (rest === 'pause' || rest === 'resume') {
            if (session.goal !== undefined) {
              session.goal.goal.phase = rest === 'pause' ? 'paused' : 'active'
              session.goal.goal.revision += 1
            }
            return { commandId, result: { kind: 'success', text: `Goal ${rest}d.` } }
          }
          if (rest === '' || rest === 'clear') {
            return {
              commandId,
              result: {
                kind: 'success',
                text: 'No goal is currently set.\nUsage: /goal <objective>'
              }
            }
          }
          session.goal = {
            goal: {
              id: `goal-${agentId}`,
              objective: rest,
              phase: 'active',
              maxGoalRounds: 16,
              revision: 1
            },
            roundsStarted: 0,
            createdAt: 0,
            updatedAt: 0
          }
          return {
            commandId,
            result: { kind: 'success', text: `Goal created\nObjective: ${rest}\nRounds: 0/16` }
          }
        }
        if (name === 'plan') {
          const off = /\boff\b/u.test(line)
          session.plan = off ? { active: false, pending: false } : { active: true, pending: false }
          return {
            commandId,
            result: { kind: 'success', text: off ? 'Plan mode off.' : 'Plan mode on.' }
          }
        }
        return { commandId, result: { kind: 'success', text: `${name} ok` } }
      }
      default:
        return []
    }
  }

  const ws = {
    url: 'ws://127.0.0.1:1/fake-mux',
    send(text: string): void {
      const parsed = JSON.parse(text) as {
        type?: string
        streamId?: string
        endpoint?: string
        payload?: { args?: { request?: { address?: { sessionId?: string } } } }
      }
      state.sent.push(parsed as Record<string, unknown>)
      if (parsed.type === 'cancel') {
        if (parsed.streamId !== undefined) state.streams.delete(parsed.streamId)
        return
      }
      if (parsed.type !== 'open' || parsed.streamId === undefined) return
      // PB-025：$events（交互 waterfall）流
      if (parsed.endpoint === '$events') {
        state.eventsOpens.push(parsed as unknown as Record<string, unknown>)
        state.eventsStreams.push(parsed.streamId)
        if (state.autoReady)
          item(parsed.streamId, { type: 'ready', clientId: 'evt-client-1', host: {} })
        return
      }
      const sessionId = parsed.payload?.args?.request?.address?.sessionId ?? ''
      const error = state.followErrors.get(sessionId)
      if (error !== undefined) {
        emit({ type: 'error', streamId: parsed.streamId, error })
        return
      }
      /**
       * 真内核语义（PB-047 探针实测）：对**不存在的 session** 调 `session/follow` 回
       * `session/not-found` 错误帧（不会替你建会话）。fake 必须同样严谨，否则
       * `ensureSession` 的"先 follow 再 create"顺序在测试里会被误判成不需要 create。
       */
      if (!state.sessions.has(sessionId)) {
        emit({
          type: 'error',
          streamId: parsed.streamId,
          error: { code: 'session/not-found', message: `unknown session ${sessionId}` }
        })
        return
      }
      state.streams.set(parsed.streamId, sessionId)
      item(parsed.streamId, snapshotValue(sessionId))
    },
    close(): void {
      onClose?.()
    },
    onMessage(listener: (text: string) => void): void {
      onMessage = listener
    },
    onClose(listener: (error?: Error) => void): void {
      onClose = listener
    }
  }

  return {
    state,
    ws,
    rpc,
    openStreams,
    finishTurn,
    /** 直接往某条流推一帧（模拟"取消前已经在路上的迟到帧"） */
    pushTextDelta(streamId: string, text: string): void {
      frame(streamId, 'attempt-late', { type: 'text-delta', index: 0, text })
    },
    /** 内核主动终止某 session 的 follow 流（如 writer 被抢、会话被归档） */
    failStreams(sessionId: string, error: { code: string; message: string }): void {
      for (const streamId of openStreams(sessionId)) {
        emit({ type: 'error', streamId, error })
        state.streams.delete(streamId)
      }
    },
    /** 往某 session 的 follow 流推一条内核事件（审批/提问等） */
    emitSessionEvent(
      sessionId: string,
      event: { type: string; seq?: number; data?: Record<string, unknown> }
    ): void {
      for (const streamId of openStreams(sessionId)) item(streamId, { type: 'event', event })
    },
    /** PB-025：往 `$events` 流推一帧（ready 之外的 waterfall/emit） */
    emitRemoteFrame(value: Record<string, unknown>): void {
      for (const streamId of state.eventsStreams) item(streamId, value)
    },
    reset(): void {
      state.sessions.clear()
      state.streams.clear()
      state.sent.length = 0
      state.prompts.length = 0
      state.creates.length = 0
      state.executes.length = 0
      state.writerHeld.clear()
      state.createConflicts.clear()
      state.followErrors.clear()
      state.listCwdOverride.clear()
      state.listCommandsFails = false
      state.eventsStreams.length = 0
      state.eventsOpens.length = 0
      state.remoteResults.length = 0
      state.continuedAnswers.length = 0
      state.autoReady = true
      state.effectiveApprovals.length = 0
      state.seq = 100
      state.autoSession = 0
      state.attemptCount = 0
      state.commandCount = 0
      onMessage = undefined
      onClose = undefined
    }
  }
})

vi.mock('../kernel-process', () => ({
  startKernelProcess: async () => ({
    baseUrl: 'http://127.0.0.1:43210',
    token: 'start-token',
    pid: 4242,
    stop: async () => {}
  })
}))

vi.mock('../kernel-auth', () => ({
  connectKernelPeer: async () => ({ cookie: 'dsh-auth-test', muxUrl: 'ws://127.0.0.1:43210/fake' })
}))

vi.mock('../kernel-rpc', () => ({
  KernelRpcClient: class {
    call(endpoint: string, args: Record<string, unknown> = {}): Promise<unknown> {
      return kernel.rpc(endpoint, args)
    }
  }
}))

vi.mock('../ws-mux', () => ({ connectWebSocket: async () => kernel.ws }))

const started: KernelAdapter[] = []
const dirs: string[] = []

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kyclaw-b34-${label}-`))
  dirs.push(dir)
  return dir
}

async function startAdapter(
  appDataDir: string,
  extras: {
    onSessionEvent?: (threadId: string, event: { type: string }) => void
    onInteractionEvent?: (event: import('../kernel-interactions').KernelInteractionEvent) => void
    resolveCwd?: (threadId?: string) => string
  } = {}
): Promise<KernelAdapter> {
  const adapter = await startKernelAdapter({
    electronExecutable: 'fake-electron',
    asarPath: 'fake.asar',
    appDataDir,
    dshHome: join(appDataDir, 'home'),
    turnTimeoutMs: 5_000,
    ...extras
  })
  started.push(adapter)
  return adapter
}

/** follow 流就绪 + prompt 已发给内核之后，测试才推帧（不跟实现赛跑） */
async function waitReady(threadId: string, promptCount = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(kernel.openStreams(threadId).length).toBeGreaterThan(0)
    expect(kernel.state.prompts.filter((prompt) => prompt.sessionId === threadId)).toHaveLength(
      promptCount
    )
  })
}

beforeEach(() => {
  kernel.reset()
})

afterEach(async () => {
  for (const adapter of started.splice(0)) await adapter.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('B3.4 threadId = 内核 sessionId', () => {
  it('create 请求带的就是 threadId；同 thread 复用同一会话；多 session 不串号', async () => {
    const adapter = await startAdapter(tempDir('a'))

    const turnA1 = adapter.startTurn('A 的第一问', { threadId: 'thread-A' })
    const turnB1 = adapter.startTurn('B 的第一问', { threadId: 'thread-B' })
    await waitReady('thread-A')
    await waitReady('thread-B')

    // A 的帧只进 A 的轮次，B 的只进 B 的
    kernel.finishTurn('thread-B', '只属于 B 的回答', 'completed')
    expect((await turnB1).text).toBe('只属于 B 的回答')
    kernel.finishTurn('thread-A', '只属于 A 的回答', 'completed')
    expect((await turnA1).text).toBe('只属于 A 的回答')

    // threadId 原样进 session/create（没有额外映射表）
    expect(kernel.state.creates).toContainEqual({ cwd: expect.any(String), sessionId: 'thread-A' })
    expect(kernel.state.creates).toContainEqual({ cwd: expect.any(String), sessionId: 'thread-B' })

    // 内核可见会话列表里能查到这两个 id
    const listed = await adapter.listKernelSessions()
    expect(listed.map((session) => session.sessionId)).toEqual(
      expect.arrayContaining(['thread-A', 'thread-B'])
    )

    // 第二轮同一 thread：复用同一会话（没有第二次 create），上下文由内核会话自带
    const turnA2 = adapter.startTurn('A 的第二问', { threadId: 'thread-A' })
    await waitReady('thread-A', 2)
    kernel.finishTurn('thread-A', 'A 的第二答', 'completed')
    expect((await turnA2).text).toBe('A 的第二答')
    expect(kernel.state.creates.filter((item) => item.sessionId === 'thread-A')).toHaveLength(1)
    expect(kernel.state.prompts.filter((prompt) => prompt.sessionId === 'thread-A')).toHaveLength(2)
    expect(kernel.state.prompts.filter((prompt) => prompt.sessionId === 'thread-B')).toHaveLength(1)
  })

  it('同一 thread 上一轮还在跑时再发一轮 → agent-busy 文案（不并发写同一会话）', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const running = adapter.startTurn('第一问', { threadId: 'thread-A' })
    await waitReady('thread-A')
    await expect(adapter.startTurn('第二问', { threadId: 'thread-A' })).rejects.toThrow(
      /session\/agent-busy/
    )
    kernel.finishTurn('thread-A', '第一答', 'completed')
    expect((await running).text).toBe('第一答')
  })
})

describe('PB-004 交互事件生产（adapter → InteractionHub）', () => {
  it('内核 approval/asked + approval/decided 经 onSessionEvent 到 hub，四态成型', async () => {
    const hub = new InteractionHub()
    const adapter = await startAdapter(tempDir('a'), {
      onSessionEvent: (threadId, event) => {
        feedKernelEvent(hub, threadId, event)
      }
    })
    const turn = adapter.startTurn('触发审批', { threadId: 'thread-A' })
    await waitReady('thread-A')

    kernel.emitSessionEvent('thread-A', {
      type: 'approval/asked',
      seq: 5,
      data: { id: 'ap-1', toolName: 'bash', callId: 'call-1', reason: '需要写权限' }
    })
    expect(hub.hasPending('thread-A')).toBe(true)
    expect(hub.snapshot('thread-A').approvals.pending[0]?.toolName).toBe('bash')

    kernel.emitSessionEvent('thread-A', {
      type: 'approval/decided',
      seq: 6,
      data: { id: 'ap-1', outcome: 'unavailable' }
    })
    const result = hub.snapshot('thread-A').approvals.results[0]
    expect(result?.outcome).toBe('unavailable')
    // 红线：自动拒绝不许写成「你拒绝」，且标记为系统发起
    expect(`${result?.copy.title}${result?.copy.detail}`).not.toContain('你拒绝')
    expect(result?.systemInitiated).toBe(true)

    kernel.finishTurn('thread-A', '答', 'completed')
    expect((await turn).text).toBe('答')
  })
})

describe('B3.4 刷新重接（reattach）', () => {
  it('opening 带内核自带的 startedAfterSeq/nextIndex；在跑的一轮挂到新流上且不重复', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const running = adapter.startTurn('慢轮问题', { threadId: 'thread-A' })
    await waitReady('thread-A')
    const oldStream = kernel.openStreams('thread-A')[0]
    expect(oldStream).toBeDefined()
    const attempt = kernel.state.sessions.get('thread-A')?.activeAttempt
    expect(attempt).toBeDefined()

    const opening = await adapter.reattach('thread-A')
    // 内核给的重接位置：我们只透传，不自造 cursor
    expect(opening.cursor).toBeTypeOf('number')
    expect(opening.assistantStreamKeys).toContain('activeAttempt')
    expect(opening.startedAfterSeq).toBe(attempt?.startedAfterSeq)
    expect(opening.nextIndex).toBe(0)

    // 旧流已被摘掉：同一会话只剩一条 follow 流
    expect(kernel.openStreams('thread-A')).toHaveLength(1)
    expect(kernel.state.sent.filter((message) => message.type === 'cancel')).toHaveLength(1)

    // 旧流上迟到的一帧不能重复进这一轮（若旧流映射没摘，这里会多出 '迟到帧'）
    kernel.pushTextDelta(oldStream ?? '', '迟到帧')

    // 新流把这一轮收口：reattach 前发起的 startTurn 必须能正常结算
    kernel.finishTurn('thread-A', '接上的回答', 'completed')
    const result = await running
    expect(result.text).toBe('接上的回答')
    expect(result.text).not.toContain('迟到帧')
  })

  it('刷新=取消旧轮：cancelTurn 按取消结算；之后同 thread 新轮照常', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const running = adapter.startTurn('第一问', { threadId: 'thread-A' })
    await waitReady('thread-A')
    await adapter.cancelTurn('thread-A')
    const cancelled = await running
    expect(cancelled.cancelled).toBe(true)

    const next = adapter.startTurn('刷新后第二问', { threadId: 'thread-A' })
    await waitReady('thread-A', 2)
    kernel.finishTurn('thread-A', '第二答', 'completed')
    expect((await next).text).toBe('第二答')
    expect(kernel.state.creates.filter((item) => item.sessionId === 'thread-A')).toHaveLength(1)
  })

  it('reattach 冷会话（重启后、内存没见过）→ 按 id 直接 follow，不 create', async () => {
    const first = await startAdapter(tempDir('a'))
    const turn = first.startTurn('建会话', { threadId: 'thread-cold' })
    await waitReady('thread-cold')
    kernel.finishTurn('thread-cold', '答', 'completed')
    await turn

    // 新 adapter = 进程重启后的状态（内存 states 空，但内核会话还在）
    const second = await startAdapter(tempDir('a'))
    const before = kernel.state.creates.length
    const opening = await second.reattach('thread-cold')
    expect(opening.cursor).toBeTypeOf('number')
    // 关键：读路径不许为"重启后没见过的会话"建新会话（旧实现会给非空会话 mint 新 id）
    expect(kernel.state.creates.length).toBe(before)
    // 两个 adapter 各一条 follow（fake 内核里同时存在），至少新 adapter 接上了这条会话
    expect(kernel.openStreams('thread-cold').length).toBeGreaterThanOrEqual(1)
  })

  it('reattach 一个内核里不存在的 thread → not-found 原样抛，不 create', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const before = kernel.state.creates.length
    await expect(adapter.reattach('thread-never')).rejects.toThrow(/not-found/)
    expect(kernel.state.creates.length).toBe(before)
    expect(kernel.state.creates.some((item) => item.sessionId === 'thread-never')).toBe(false)
  })
})

describe('B3.4 占用/冲突文案（当一等错误，不吞）', () => {
  it('writer-held → 明确提示另一个窗口/进程占用', async () => {
    const adapter = await startAdapter(tempDir('a'))
    kernel.state.writerHeld.add('thread-W')
    await expect(adapter.startTurn('写一下', { threadId: 'thread-W' })).rejects.toThrow(
      /另一个窗口\/进程占用.*session\/writer-held/su
    )
  })

  it('conflict（预检 session/list 发现属于别的目录）→ 提示已属于另一个目录', async () => {
    const dirA = tempDir('a')
    const dirB = tempDir('b')
    const a = await startAdapter(dirA)
    const first = a.startTurn('A 的会话', { threadId: 'thread-shared' })
    await waitReady('thread-shared')
    kernel.finishTurn('thread-shared', 'A 答', 'completed')
    await first

    const b = await startAdapter(dirB)
    await expect(b.startTurn('跨目录续接', { threadId: 'thread-shared' })).rejects.toThrow(
      /另一个目录.*session\/conflict/su
    )
    // 预检就挡住了，没往内核发这个 thread 的 create。
    // （PB-051 起 adapter 启动会自动建/复用**带显式稳定 id** 的默认会话，它也会出现在 creates 里；
    //   这里只排除默认会话，断言 intent 不变：thread-shared 没有被跨目录 create。）
    expect(
      kernel.state.creates.filter(
        (item) => item.cwd === dirB && item.sessionId !== b.defaultSessionId
      )
    ).toHaveLength(0)
    expect(kernel.state.creates.filter((item) => item.sessionId === 'thread-shared')).toHaveLength(
      1
    )
  })

  it('conflict（内核 create 直接拒绝）→ 同样映射成可读文案', async () => {
    const adapter = await startAdapter(tempDir('a'))
    kernel.state.createConflicts.add('thread-C')
    await expect(adapter.startTurn('建会话', { threadId: 'thread-C' })).rejects.toThrow(
      /另一个目录.*session\/conflict/su
    )
  })

  it('内核回 cwd 大小写/分隔符不同，不算 conflict（sameCwd 归一化）', async () => {
    const dirA = tempDir('a')
    const first = await startAdapter(dirA)
    const turn = first.startTurn('第一问', { threadId: 'thread-case' })
    await waitReady('thread-case')
    kernel.finishTurn('thread-case', '第一答', 'completed')
    await turn

    // 模拟内核返回同一目录的另一种写法（大写 + 反斜杠 + 尾部分隔符）
    kernel.state.listCwdOverride.set('thread-case', `${dirA.toUpperCase().replace(/\//gu, '\\')}\\`)

    // 第二个进程/窗口用同一目录接手：预检看到的是上面那种写法，归一化后不算冲突
    const second = await startAdapter(dirA)
    const nextTurn = second.startTurn('第二问', { threadId: 'thread-case' })
    await waitReady('thread-case', 2)
    kernel.finishTurn('thread-case', '第二答', 'completed')
    expect((await nextTurn).text).toBe('第二答')
  })

  it('内核终止 follow 流后，同一 thread 下一轮自动重新 follow（不死在超时上）', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const running = adapter.startTurn('第一问', { threadId: 'thread-F' })
    await waitReady('thread-F')
    kernel.failStreams('thread-F', {
      code: 'session/writer-held',
      message: 'another writer holds thread-F'
    })
    await expect(running).rejects.toThrow(/另一个窗口\/进程占用/su)

    kernel.state.followErrors.clear()
    const next = adapter.startTurn('第二问', { threadId: 'thread-F' })
    await waitReady('thread-F', 2)
    kernel.finishTurn('thread-F', '第二答', 'completed')
    expect((await next).text).toBe('第二答')
  })
})

/**
 * PB-024：`rpcCall` 是**裸透传**（只给 main 侧模块用）。
 * 只验证两条：method/payload 原样到内核、内核错误原样抛出（不吞成 undefined）。
 */
describe('PB-024 rpcCall 透传', () => {
  it('method/payload 原样转发，返回值原样拿回', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const echoed = await adapter.rpcCall<{ received: Record<string, unknown> }>('test/echo', {
      kind: 'session',
      sessionId: 'thread-x'
    })
    expect(echoed.received).toEqual({ kind: 'session', sessionId: 'thread-x' })
    // 不传 payload 时给空对象（不透传 undefined 让内核自己炸）
    const empty = await adapter.rpcCall<{ received: Record<string, unknown> }>('test/echo')
    expect(empty.received).toEqual({})
  })

  it('内核错误原样抛出（不吞成 undefined）', async () => {
    const adapter = await startAdapter(tempDir('a'))
    await expect(adapter.rpcCall('test/boom')).rejects.toThrow(/test\/boom failed/u)
  })
})

describe('PB-025 $events 交互 waterfall（mock 传输层；形状取自一手取证）', () => {
  it('给 onInteractionEvent 才开 $events；payload 恰好 {args:{}}；waterfall → 结构化事件', async () => {
    const received: Array<{ kind: string; eventId: string; threadId: string; toolName?: string }> =
      []
    const adapter = await startAdapter(tempDir('a'), {
      onInteractionEvent: (event) => received.push(event)
    })
    // payload 必须恰好 {args:{}}（多一个键内核会回 gateway/arguments-invalid）
    const open = kernel.state.eventsOpens[0]
    expect(open?.['endpoint']).toBe('$events')
    expect(open?.['payload']).toEqual({ args: {} })

    kernel.emitRemoteFrame({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'e-1',
      agentId: 'session-x',
      request: { toolName: 'bash', callId: 'call-1', reason: '要写权限' }
    })
    expect(received).toEqual([
      {
        kind: 'approval',
        eventId: 'e-1',
        threadId: 'session-x',
        toolName: 'bash',
        callId: 'call-1',
        reason: '要写权限'
      }
    ])
    expect(adapter.sessionId).not.toBe('')
  })

  it('没给 onInteractionEvent 就不开 $events（不多开常驻流）', async () => {
    await startAdapter(tempDir('a'))
    expect(kernel.state.eventsOpens).toHaveLength(0)
  })

  it('审批应答：args 恰好 {clientId,eventId,outcome}，value = 裸四态字符串（不套 args）', async () => {
    const adapter = await startAdapter(tempDir('a'), { onInteractionEvent: () => undefined })
    await adapter.respondInteraction({ eventId: 'e-1', kind: 'approval', outcome: 'allowed-once' })
    await adapter.respondInteraction({ eventId: 'e-2', kind: 'approval', outcome: 'rejected' })
    expect(kernel.state.remoteResults).toEqual([
      {
        clientId: 'evt-client-1',
        eventId: 'e-1',
        outcome: { kind: 'result', value: 'allowed-once' }
      },
      { clientId: 'evt-client-1', eventId: 'e-2', outcome: { kind: 'result', value: 'rejected' } }
    ])
    // 红线：绝不能出现 args.args（那是踩过的坑）
    expect(kernel.state.remoteResults.some((args) => 'args' in args)).toBe(false)
  })

  it('提问应答：value = {answers:[{id,selected,custom?}]}', async () => {
    const adapter = await startAdapter(tempDir('a'), { onInteractionEvent: () => undefined })
    await adapter.respondInteraction({
      eventId: 'e-3',
      kind: 'question',
      answer: { answers: [{ id: 'q1', selected: ['A'] }] }
    })
    expect(kernel.state.remoteResults[0]).toEqual({
      clientId: 'evt-client-1',
      eventId: 'e-3',
      outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['A'] }] } }
    })
  })

  it('还没收到 ready 帧就应答 → 可诊断错误（不静默丢）', async () => {
    kernel.state.autoReady = false
    const adapter = await startAdapter(tempDir('a'), { onInteractionEvent: () => undefined })
    await expect(
      adapter.respondInteraction({ eventId: 'e-1', kind: 'approval', outcome: 'rejected' })
    ).rejects.toThrow(/events 流尚未就绪/u)
    expect(kernel.state.remoteResults).toHaveLength(0)
  })

  it('continued 补答：userQuestions/answer 带 agentId/callId/answer，返回内核 boolean', async () => {
    const adapter = await startAdapter(tempDir('a'))
    // PB-030 之后：补答要求 thread 已物化（读/写都不许为未知 thread 懒建会话）
    const turn = adapter.startTurn('先建会话', { threadId: 'thread-A' })
    await waitReady('thread-A')
    kernel.finishTurn('thread-A', '答', 'completed')
    await turn
    const stillContinued = await adapter.answerContinuedQuestion('thread-A', 'call-1', {
      answers: [{ id: 'q1', selected: ['A'], custom: '其它' }]
    })
    expect(stillContinued).toBe(false)
    expect(kernel.state.continuedAnswers[0]).toEqual({
      agentId: expect.any(String),
      callId: 'call-1',
      answer: { answers: [{ id: 'q1', selected: ['A'], custom: '其它' }] }
    })
  })

  it('内核 fail-closed：非法审批值 → unavailable，文案不含「你拒绝」（负向）', async () => {
    const adapter = await startAdapter(tempDir('a'), { onInteractionEvent: () => undefined })
    // 绕过类型（模拟未来某个调用点写错形状）：内核按 OUTCOMES.includes 归一成 unavailable
    await adapter.rpcCall('$events/result', {
      clientId: 'evt-client-1',
      eventId: 'e-9',
      outcome: { kind: 'result', value: 'definitely-not-an-outcome' }
    })
    expect(kernel.state.effectiveApprovals).toEqual(['unavailable'])
    const copy = approvalOutcomeCopy('unavailable')
    expect(`${copy.title}${copy.detail}`).not.toContain('你拒绝')
    expect(copy.attribution).toBe('system')
    expect(copy.canRetry).toBe(true)
  })
})

/** PB-024（Eve P0）：cwd 唯一来源 + 默认会话 id 只读暴露 */
describe('PB-024 cwd 钩子与 defaultSessionId', () => {
  it('cwdOf：create 过的 thread 同步取到 cwd；list 过的也记；未知返回 undefined（不发 RPC）', async () => {
    const appDir = tempDir('a')
    const adapter = await startAdapter(appDir)
    // 默认会话在启动时 create 过 → 已记录
    expect(adapter.cwdOf(adapter.defaultSessionId)).toBe(appDir)
    // 未见过 → undefined（不回落 appDir）
    expect(adapter.cwdOf('thread-never-seen')).toBeUndefined()

    // 内核侧多出一个会话（直接 rpcCall 建，不经过 adapter 的 createSession）→ list 后应能取到
    const extra = await adapter.rpcCall<{ sessionId: string }>('session/create', {
      request: { cwd: join(appDir, 'extra'), sessionId: 'thread-listed' }
    })
    expect(extra.sessionId).toBe('thread-listed')
    expect(adapter.cwdOf('thread-listed')).toBeUndefined()
    await adapter.listKernelSessions()
    expect(adapter.cwdOf('thread-listed')).toBe(join(appDir, 'extra'))
  })

  it('resolveCwd 给 workspace cwd：create/startTurn 都走它，不再 conflict', async () => {
    const appDir = tempDir('a')
    const workspace = tempDir('ws')
    const adapter = await startAdapter(appDir, { resolveCwd: () => workspace })

    const turn = adapter.startTurn('用 workspace 物化', { threadId: 'thread-W' })
    await waitReady('thread-W')
    kernel.finishTurn('thread-W', '答', 'completed')
    expect((await turn).text).toBe('答')

    // 内核收到的是 workspace cwd（不是 appDataDir）
    expect(kernel.state.creates).toContainEqual({ cwd: workspace, sessionId: 'thread-W' })
    expect(kernel.state.creates.some((item) => item.cwd === appDir)).toBe(false)
    // 同一 thread 第二轮复用同一会话（没有第二次 create、不 conflict）
    const again = adapter.startTurn('第二轮', { threadId: 'thread-W' })
    await waitReady('thread-W', 2)
    kernel.finishTurn('thread-W', '答2', 'completed')
    expect((await again).text).toBe('答2')
    expect(kernel.state.creates.filter((item) => item.sessionId === 'thread-W')).toHaveLength(1)
  })

  it('钩子的 cwd 就是内核里那份：同 id 换回 appDataDir 会被内核判 conflict（反证）', async () => {
    const dirA = tempDir('a')
    const workspace = tempDir('ws')
    const hooked = await startAdapter(dirA, { resolveCwd: () => workspace })

    const turn = hooked.startTurn('钩子侧', { threadId: 'thread-shared' })
    await waitReady('thread-shared')
    kernel.finishTurn('thread-shared', '答', 'completed')
    await turn

    const listed = await hooked.listKernelSessions()
    expect(listed.find((item) => item.sessionId === 'thread-shared')?.cwd).toBe(workspace)
    // 直接拿 appDataDir 去建同一个 id → 内核拒绝（说明"各写一份 cwd"正是 conflict 的来源）
    await expect(
      hooked.rpcCall('session/create', { request: { cwd: dirA, sessionId: 'thread-shared' } })
    ).rejects.toThrow(/session\/conflict/u)
  })

  it('defaultSessionId 只读暴露（threads 列表过滤幽灵会话用）；PB-051 起是稳定 id，不再每次启动 mint', async () => {
    const dirA = tempDir('a')
    const adapter = await startAdapter(dirA)
    expect(adapter.defaultSessionId).toBe(adapter.sessionId)
    // PB-051（预期行为变化）：默认会话 id = 从 cwd 派生的稳定 id。
    // 旧实现是内核每次启动 mint 的 `auto-session-N`，于是每次启动多一个 blank 会话。
    expect(adapter.defaultSessionId).toMatch(/^kyclaw-default-[0-9a-f]{16}$/u)
    const listed = await adapter.listKernelSessions()
    expect(listed.some((item) => item.sessionId === adapter.defaultSessionId)).toBe(true)
  })
})

/**
 * PB-030：**读路径不得建会话**。
 * renderer 在没有真实会话时用占位 threadId（`kyclaw-pending`）轮询投影/命令；读接口若懒建会话，
 * 内核里会多出幽灵 `session-<uuid>`（侧栏多一行、`/api/threads` 带出来）。
 */
describe('PB-030 读路径不建会话', () => {
  it('未知 thread 的 goal/plan/commands/补答都返回空态，且内核 create 计数不变', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const before = kernel.state.creates.length
    expect(await adapter.readGoalState('kyclaw-pending')).toBeNull()
    expect(await adapter.readPlanState('kyclaw-pending')).toBeNull()
    expect(await adapter.listCommands('kyclaw-pending')).toEqual([])
    expect(await adapter.answerContinuedQuestion('kyclaw-pending', 'call-1', { answers: [] })).toBe(
      false
    )
    // 内核侧零新增：既没有 session/create，也没有这个 id 的会话
    expect(kernel.state.creates.length).toBe(before)
    expect(kernel.state.creates.some((item) => item.sessionId === 'kyclaw-pending')).toBe(false)
  })

  it('已知 thread（物化过的）读路径照常工作（不因为防懒建而丢能力）', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const turn = adapter.startTurn('建会话', { threadId: 'thread-known' })
    await waitReady('thread-known')
    kernel.finishTurn('thread-known', '答', 'completed')
    await turn
    expect(await adapter.readPlanState('thread-known')).toEqual({ active: false, pending: false })
    expect((await adapter.listCommands('thread-known')).map((c) => c.name)).toContain('goal')
  })
})

describe('sameCwd（冲突预检的比较归一化）', () => {
  it('分隔符与大小写差异视为同一目录；真不同目录判 false', () => {
    expect(sameCwd('C:\\Users\\me\\app', 'c:/users/ME/app/', true)).toBe(true)
    expect(sameCwd('C:\\Users\\me\\app', 'C:\\Users\\me\\app')).toBe(true)
    expect(sameCwd('/home/me/app', '/home/me/app/', false)).toBe(true)
    expect(sameCwd('/home/me/app', '/home/me/App', false)).toBe(false)
    expect(sameCwd('/home/me/app', '/home/me/app2', false)).toBe(false)
  })
})

/**
 * PB-004 前置：命令/投影面按 threadId 走（Cyrus 的 renderer 命令菜单要吃这个）。
 * 多点两层：缺省 = 默认会话（旧调用零变化）；传 threadId = 该 thread 的内核 session。
 */
describe('PB-004 命令/投影面 threadId：不传走默认会话，传了不串号', () => {
  it('goal/plan 投影按 threadId 隔离；缺省仍是默认会话', async () => {
    const adapter = await startAdapter(tempDir('a'))

    // 默认会话：没建过 goal，plan 未开
    expect(await adapter.readGoalState()).toBeNull()
    expect(await adapter.readPlanState()).toEqual({ active: false, pending: false })

    // thread-A 建 goal；thread-B 读不到
    const created = await adapter.executeCommand('/goal 目标-A', 'thread-A')
    expect(created).toMatchObject({ result: { kind: 'success' } })
    const goalA = await adapter.readGoalState('thread-A')
    expect(goalA?.goal.objective).toBe('目标-A')
    expect(goalA?.goal.phase).toBe('active')
    expect(await adapter.readGoalState('thread-B')).toBeNull()
    expect(await adapter.readGoalState()).toBeNull()

    // thread-B 开 plan；thread-A 的 plan 仍是关的（不是同一会话的投影）
    await adapter.executeCommand('/plan', 'thread-B')
    expect(await adapter.readPlanState('thread-B')).toEqual({ active: true, pending: false })
    expect(await adapter.readPlanState('thread-A')).toEqual({ active: false, pending: false })
    expect(await adapter.readPlanState()).toEqual({ active: false, pending: false })

    // **反向**：thread-A 里的 goal 状态变化不影响 thread-B 的 goal（B 仍无 goal）
    await adapter.executeCommand('/goal pause', 'thread-A')
    expect((await adapter.readGoalState('thread-A'))?.goal.phase).toBe('paused')
    expect(await adapter.readGoalState('thread-B')).toBeNull()

    // 命令真的发到了各自的内核 session（agentId 就是 threadId）
    expect(kernel.state.executes.map((item) => item.agentId)).toContain('thread-A')
    expect(kernel.state.executes.map((item) => item.agentId)).toContain('thread-B')
  })

  it('listCommands(threadId)：未知 thread 空清单且不建会话；物化后走内核清单；不额外挂 follow', async () => {
    const adapter = await startAdapter(tempDir('a'))
    // PB-030：读路径不建会话 → 未知 thread 返回空清单
    expect(await adapter.listCommands('thread-menu')).toEqual([])
    expect(kernel.state.creates.some((item) => item.sessionId === 'thread-menu')).toBe(false)

    // 物化（真实会话起来了）之后：读命令走内核清单
    const turn = adapter.startTurn('建会话', { threadId: 'thread-menu' })
    await waitReady('thread-menu')
    kernel.finishTurn('thread-menu', '答', 'completed')
    await turn
    const names = (await adapter.listCommands('thread-menu')).map((command) => command.name)
    expect(names).toContain('goal')
    expect(names).toContain('plan')
    // 命令面不额外开 follow：默认会话 + thread-menu 各一条，共 2
    expect(kernel.state.streams.size).toBe(2)
    // 缺省调用仍走默认会话（行为不变）
    expect((await adapter.listCommands()).map((command) => command.name)).toEqual(names)
  })
})

/**
 * PB-005-F2：未知命令**不再静默丢弃**（adapter 层；纯函数见 kernel-commands.spec.ts）。
 */
describe('PB-005-F2 未知命令可诊断', () => {
  it('未知命令 → 结构化 error（与内核同形），且**没发给内核**', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const result = (await adapter.executeCommand('/eve-nope-command')) as {
      commandId: string
      result: { kind: string; text: string }
    }
    expect(result.commandId).toMatch(/^kyclaw-unknown-/u)
    expect(result.result.kind).toBe('error')
    expect(result.result.text).toContain('/eve-nope-command')
    expect(result.result.text).toContain('/goal')
    // 内核没收到这一行（否则又会是"返回 undefined 的静默丢弃"）
    expect(
      kernel.state.executes.filter((item) => item.line.includes('eve-nope-command'))
    ).toHaveLength(0)
  })

  it('已知命令原样透传内核结果（不缺诊断层）', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const result = (await adapter.executeCommand('/goal 目标-A')) as {
      commandId: string
      result: { kind: string; text: string }
    }
    expect(result.commandId).toMatch(/^cmd-/u)
    expect(result.result.kind).toBe('success')
    expect(kernel.state.executes).toContainEqual({
      agentId: expect.any(String),
      line: '/goal 目标-A'
    })
  })

  it('不带 / 的行（Eve P3）：即使命令名已注册也判未知，不发给内核', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const result = (await adapter.executeCommand('goal')) as {
      result: { kind: string; text: string }
    }
    expect(result.result.kind).toBe('error')
    expect(result.result.text).toContain('命令要以 / 开头')
    expect(kernel.state.executes.filter((item) => item.line === 'goal')).toHaveLength(0)
  })

  it('命令清单拉不到时不阻断（内核仍是权威），只告警', async () => {
    const adapter = await startAdapter(tempDir('a'))
    kernel.state.listCommandsFails = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = (await adapter.executeCommand('/goal 目标-B')) as {
        result: { kind: string }
      }
      expect(result.result.kind).toBe('success')
      expect(warn.mock.calls.some((call) => String(call[0]).includes('跳过未知命令校验'))).toBe(
        true
      )
    } finally {
      warn.mockRestore()
    }
  })
})
