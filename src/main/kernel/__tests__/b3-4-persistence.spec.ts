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

const kernel = vi.hoisted(() => {
  interface FakeSession {
    sessionId: string
    cwd: string
    running: boolean
    blank: boolean
    activeAttempt?: { attemptId: string; startedAfterSeq: number; nextIndex: number }
  }

  const state = {
    sessions: new Map<string, FakeSession>(),
    /** streamId → 订阅的 session */
    streams: new Map<string, string>(),
    sent: [] as Array<Record<string, unknown>>,
    prompts: [] as Array<{ sessionId: string; text: string }>,
    creates: [] as Array<{ cwd: string; sessionId?: string }>,
    /** 这些 sessionId 的 prompt 会被内核以 session/writer-held 拒绝 */
    writerHeld: new Set<string>(),
    /** 这些 sessionId 的 create 会被内核以 session/conflict 拒绝 */
    createConflicts: new Set<string>(),
    /** 这些 sessionId 的 follow open 直接回 error 帧 */
    followErrors: new Map<string, { code: string; message: string }>(),
    /** 覆盖 session/list 里回给宿主的 cwd 写法（模拟内核归一化差异） */
    listCwdOverride: new Map<string, string>(),
    seq: 100,
    autoSession: 0,
    attemptCount: 0
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
      case 'session/projections':
        return { values: { goal: null, plan: { active: false, pending: false } } }
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
      const sessionId = parsed.payload?.args?.request?.address?.sessionId ?? ''
      const error = state.followErrors.get(sessionId)
      if (error !== undefined) {
        emit({ type: 'error', streamId: parsed.streamId, error })
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
    reset(): void {
      state.sessions.clear()
      state.streams.clear()
      state.sent.length = 0
      state.prompts.length = 0
      state.creates.length = 0
      state.writerHeld.clear()
      state.createConflicts.clear()
      state.followErrors.clear()
      state.listCwdOverride.clear()
      state.seq = 100
      state.autoSession = 0
      state.attemptCount = 0
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

async function startAdapter(appDataDir: string): Promise<KernelAdapter> {
  const adapter = await startKernelAdapter({
    electronExecutable: 'fake-electron',
    asarPath: 'fake.asar',
    appDataDir,
    dshHome: join(appDataDir, 'home'),
    turnTimeoutMs: 5_000
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

  it('reattach 一个还没见过的 thread → 用该 id 建会话并返回 opening', async () => {
    const adapter = await startAdapter(tempDir('a'))
    const opening = await adapter.reattach('thread-new')
    expect(opening.cursor).toBeTypeOf('number')
    expect(kernel.state.creates).toContainEqual({ cwd: expect.any(String), sessionId: 'thread-new' })
    expect(kernel.openStreams('thread-new')).toHaveLength(1)
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
    // 预检就挡住了，没往内核发 create
    expect(kernel.state.creates.filter((item) => item.cwd === dirB)).toHaveLength(0)
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

describe('sameCwd（冲突预检的比较归一化）', () => {
  it('分隔符与大小写差异视为同一目录；真不同目录判 false', () => {
    expect(sameCwd('C:\\Users\\me\\app', 'c:/users/ME/app/', true)).toBe(true)
    expect(sameCwd('C:\\Users\\me\\app', 'C:\\Users\\me\\app')).toBe(true)
    expect(sameCwd('/home/me/app', '/home/me/app/', false)).toBe(true)
    expect(sameCwd('/home/me/app', '/home/me/App', false)).toBe(false)
    expect(sameCwd('/home/me/app', '/home/me/app2', false)).toBe(false)
  })
})
