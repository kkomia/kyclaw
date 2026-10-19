/**
 * B3.1a + B3.4：真内核适配层（只在 feature flag 开启时实例化）。
 *
 * 一次流程：
 *   startKernelProcess（Electron-as-node + asar 内 bin；隔离 DSH_HOME）
 *   → connectKernelPeer（`/connect` 换 API cookie + mux 地址）
 *   → `session/create`（B3.4：**threadId 直接当 sessionId**，不建映射表）
 *   → WS `/api/remote.mux` 打开 `session/follow`（assistantStream: true）
 *   → RPC `session/prompt` 发一条消息
 *   → 内核帧经 `KernelSseMapper` 映射成现有 renderer SSE 帧
 *   → `stop()` 关 WS + 停子进程（不留孤儿）。
 *
 * B3.4 持久化：同一会话（threadId）跨请求复用同一个内核 session；
 * `reattach()` 用内核 opening 自带的 `startedAfterSeq`/`nextIndex` 接上正在跑的一轮（不自造 cursor）。
 *
 * 安全（D1）：内核 token/cookie 只在本模块内部；`KernelAdapter` 不暴露它们。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectKernelPeer } from './kernel-auth'
import {
  commandNameFromLine,
  unknownCommandResult,
  type KernelCommandInfo,
  type KernelCommandResult
} from './kernel-commands'
import { startKernelProcess } from './kernel-process'
import { KernelRpcClient } from './kernel-rpc'
import { KernelSseMapper, type KernelFollowValue, type RendererSseFrame } from './sse-map'
import type { KernelGoalState } from './goal-projection'
import { connectWebSocket, type WebSocketClient } from './ws-mux'

export interface KernelAdapterOptions {
  electronExecutable: string
  asarPath: string
  /** 应用数据目录（内核 home 默认在其下 `dsh-kernel-home`；不含用户 `~/.dsh`） */
  appDataDir: string
  /** B3.4：显式指定 DSH_HOME（默认 appDataDir/dsh-kernel-home；两个 adapter 共享时用于冲突/writer-held 测试） */
  dshHome?: string
  extraEnv?: Readonly<Record<string, string>>
  readyTimeoutMs?: number
  turnTimeoutMs?: number
  /** 诊断/测试：每条 follow value 原样回调（不含 token/cookie） */
  onFollowValue?: (value: KernelFollowValue) => void
  /** B3.3b：goal 轮次安全阀（写进隔离 profile 的 cordis.patch.yml；默认 16） */
  goalMaxRounds?: number
}

export interface KernelTurnResult {
  frames: RendererSseFrame[]
  sse: string
  text: string
  error?: { code?: string; message: string }
  cancelled?: boolean
}

export interface StartTurnOptions {
  /** 增量送出：每产生一帧立刻回调（B3.2 边收边发；不传 = 只返回整轮结果） */
  onFrame?: (frame: RendererSseFrame) => void
  /** B3.4：该轮所属 threadId（= 内核 sessionId；缺省用启动时创建的默认会话） */
  threadId?: string
}

export interface KernelSessionInfo {
  sessionId: string
  cwd?: string
  running?: boolean
  blank?: boolean
}

/** follow opening 里内核自带的重接信息（原样透传，不自造 cursor） */
export interface KernelSessionOpening {
  cursor?: number
  startedAfterSeq?: number
  nextIndex?: number
  snapshotKeys?: string[]
  /** 活跃 assistant 流的字段名（内核把 startedAfterSeq/nextIndex 放在 assistantStream 里） */
  assistantStreamKeys?: string[]
}

export interface KernelAdapter {
  readonly sessionId: string
  readonly pid: number | undefined
  readonly port: number
  startTurn(text: string, options?: StartTurnOptions): Promise<KernelTurnResult>
  cancelTurn(threadId?: string): Promise<void>
  stop(): Promise<void>
  /**
   * B3.3/PB-004：命令与投影面按会话走。
   * `threadId` 缺省 = 启动时创建的默认会话（flag 关/旧调用零变化）；传了就按该 thread 的
   * 内核 session 走（与 `body.memory.thread` 当 sessionId 的口径一致）。
   */
  listCommands(threadId?: string): Promise<readonly KernelCommandInfo[]>
  executeCommand(line: string, threadId?: string): Promise<unknown>
  readGoalState(threadId?: string): Promise<KernelGoalState | null>
  readPlanState(threadId?: string): Promise<{ active: boolean; pending: boolean } | null>
  /** B3.4：内核可见会话列表（只读 header） */
  listKernelSessions(): Promise<KernelSessionInfo[]>
  /** B3.4：刷新重接（同一进程内重新 follow）；返回 opening 的 startedAfterSeq/nextIndex */
  reattach(threadId: string): Promise<KernelSessionOpening>
}

export function framesToSse(frames: readonly RendererSseFrame[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

/**
 * B3.3b：把 `defaultMaxGoalRounds` 钉进**我们生成的 profile patch**（不改内核包）。
 * 内核 profile 首次启动会自动初始化；预先写好的 patch 会被保留。
 */
export function ensureGoalRoundCap(dshHome: string, maxGoalRounds: number): string {
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const entry = `- id: goal\n  config:\n    defaultMaxGoalRounds: ${String(maxGoalRounds)}\n`
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, `# kyclaw B3.3b：goal 轮次安全阀（内核权威执行）\n${entry}`, 'utf8')
    return patchPath
  }
  const current = readFileSync(patchPath, 'utf8')
  if (/defaultMaxGoalRounds\s*:/u.test(current)) return patchPath
  if (/^-\s*id:\s*goal\s*$/mu.test(current)) {
    const injected = current.replace(
      /^-\s*id:\s*goal\s*$/mu,
      `- id: goal\n  config:\n    defaultMaxGoalRounds: ${String(maxGoalRounds)}`
    )
    writeFileSync(patchPath, injected, 'utf8')
    return patchPath
  }
  writeFileSync(patchPath, `${current}${current.endsWith('\n') ? '' : '\n'}${entry}`, 'utf8')
  return patchPath
}

interface TurnState {
  frames: RendererSseFrame[]
  resolve: (result: KernelTurnResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  onFrame?: (frame: RendererSseFrame) => void
}

interface SessionState {
  sessionId: string
  streamId: string
  mapper: KernelSseMapper
  latestSeq: number
  opening: KernelSessionOpening
  snapshotResolve?: (opening: KernelSessionOpening) => void
  snapshotReject?: (error: Error) => void
  turn?: TurnState
  /** 这条 follow 流已被内核终止（error 帧 / socket 关闭）：不再复用，下一轮重新 follow */
  dead?: boolean
}

/**
 * 判断两个路径是不是同一个工作目录。
 *
 * 为什么需要：`session/create` 的复用规则要求"sessionId 属于请求的目录"，我们在建会话前先用
 * `session/list` 自查归属；内核回的 `cwd` 与我们传的 `appDataDir` 可能在分隔符/大小写上不同
 * （Windows 常见），直接 `!==` 会把同一目录误判成 `session/conflict`。这里只做比较归一化，
 * 不改任何持久值；真冲突仍以内核返回为准。
 */
export function sameCwd(
  left: string,
  right: string,
  caseInsensitive = process.platform === 'win32'
): boolean {
  const norm = (value: string): string => {
    const slashed = value
      .trim()
      .replace(/\\/gu, '/')
      .replace(/\/{2,}/gu, '/')
      .replace(/\/+$/u, '')
    return caseInsensitive ? slashed.toLowerCase() : slashed
  }
  return norm(left) === norm(right)
}

/** 把内核错误映射成用户能看懂的文案（session/writer-held 等当一等错误，不吞） */
export function kernelUserError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('session/writer-held'))
    return new Error('会话正被另一个窗口/进程占用（session/writer-held）；请关闭占用它的窗口后重试。')
  if (raw.includes('session/conflict'))
    return new Error('会话 id 已属于另一个目录（session/conflict）；不能在这里续接，请新建会话。')
  if (raw.includes('session/agent-busy'))
    return new Error('会话正被子 agent 占用（session/agent-busy）；请稍后再试。')
  return error instanceof Error ? error : new Error(raw)
}

export async function startKernelAdapter(options: KernelAdapterOptions): Promise<KernelAdapter> {
  const dshHome = options.dshHome ?? join(options.appDataDir, 'dsh-kernel-home')
  ensureGoalRoundCap(dshHome, options.goalMaxRounds ?? 16)
  const cwd = options.appDataDir
  const kernel = await startKernelProcess({
    electronExecutable: options.electronExecutable,
    asarPath: options.asarPath,
    dshHome,
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs })
  })

  let ws: WebSocketClient | undefined
  try {
    const auth = await connectKernelPeer({ baseUrl: kernel.baseUrl, token: kernel.token })
    const rpc = new KernelRpcClient(kernel.baseUrl, auth.cookie)
    ws = await connectWebSocket({ url: auth.muxUrl, cookie: auth.cookie })

    const states = new Map<string, SessionState>()
    const byStream = new Map<string, SessionState>()
    let closed = false

    /** 内核已注册的命令（诊断/校验共用一次 RPC；内核是权威，我们不缓存） */
    const listCommandsInternal = (sessionId: string): Promise<readonly KernelCommandInfo[]> =>
      rpc.call<readonly KernelCommandInfo[]>('commands/list', { agentId: sessionId })

    /**
     * 命令/投影面用哪个内核 session：缺省 = 默认会话；给了 threadId 就按该 thread 走。
     * 已经 follow 过的 thread 直接复用；没见过的只 `session/create`（复用或新建），
     * **不额外开 follow**——命令和投影不产生流，没必要给每个 thread 挂一条空订阅。
     */
    const sessionIdFor = async (threadId?: string): Promise<string> => {
      if (threadId === undefined) return defaultSessionId
      const existing = states.get(threadId)
      if (existing !== undefined) return existing.sessionId
      return createSession(threadId)
    }

    const listKernelSessions = async (): Promise<KernelSessionInfo[]> => {
      const result = await rpc.call<{ items?: Array<Record<string, unknown>> }>('session/list', {
        _request: {}
      })
      return (result.items ?? []).map((item) => ({
        sessionId: String(item.sessionId),
        ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
        ...(typeof item.running === 'boolean' ? { running: item.running } : {}),
        ...(typeof item.blank === 'boolean' ? { blank: item.blank } : {})
      }))
    }

    const openFollow = async (sessionId: string): Promise<SessionState> => {
      const state: SessionState = {
        sessionId,
        streamId: `kyclaw-follow-${randomUUID()}`,
        mapper: new KernelSseMapper(),
        latestSeq: 0,
        opening: {}
      }
      const snapshot = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`kernel adapter: session/follow timeout for ${sessionId}`))
        }, 10_000)
        state.snapshotResolve = (opening: KernelSessionOpening): void => {
          clearTimeout(timer)
          state.opening = opening
          resolve()
        }
        state.snapshotReject = (error: Error): void => {
          clearTimeout(timer)
          reject(error)
        }
      })
      byStream.set(state.streamId, state)
      ws?.send(
        JSON.stringify({
          type: 'open',
          streamId: state.streamId,
          endpoint: 'session/follow',
          payload: {
            args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } }
          }
        })
      )
      try {
        await snapshot
      } catch (error) {
        // follow 没接上：这条流不会被内核接受，摘掉映射，别留一个永远收不到帧的 state
        byStream.delete(state.streamId)
        throw error
      }
      return state
    }

    const createSession = async (sessionId?: string): Promise<string> => {
      // B3.4：建会话前先 list 校验归属（同 id 跨目录 → session/conflict）
      if (sessionId !== undefined) {
        const listed = await listKernelSessions().catch(() => [] as KernelSessionInfo[])
        const existing = listed.find((item) => item.sessionId === sessionId)
        if (existing?.cwd !== undefined && !sameCwd(existing.cwd, cwd)) {
          throw kernelUserError(new Error('kernel: session/conflict'))
        }
      }
      try {
        const created = await rpc.call<{ sessionId: string }>('session/create', {
          request: { cwd, ...(sessionId === undefined ? {} : { sessionId }) }
        })
        return created.sessionId
      } catch (error) {
        throw kernelUserError(error)
      }
    }

    /** 同一 threadId（= sessionId）复用同一条 follow；流已死的重新 follow，不新建 session */
    const ensureSession = async (threadId: string): Promise<SessionState> => {
      const existing = states.get(threadId)
      if (existing !== undefined && existing.dead !== true) return existing
      const sessionId = existing?.sessionId ?? (await createSession(threadId))
      const state = await openFollow(sessionId)
      states.set(threadId, state)
      return state
    }

    const settleTurn = (
      state: SessionState,
      failure?: Error,
      outcome?: { error?: KernelTurnResult['error']; cancelled?: boolean }
    ): void => {
      const turn = state.turn
      if (turn === undefined) return
      state.turn = undefined
      clearTimeout(turn.timer)
      if (failure !== undefined) {
        turn.reject(failure)
        return
      }
      const text = turn.frames
        .flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : []))
        .join('')
      turn.resolve({
        frames: turn.frames,
        sse: framesToSse(turn.frames),
        text,
        ...(outcome?.error === undefined ? {} : { error: outcome.error }),
        ...(outcome?.cancelled === true ? { cancelled: true } : {})
      })
    }

    ws.onClose((error) => {
      if (closed) return
      closed = true
      for (const state of states.values()) {
        state.dead = true
        settleTurn(state, error ?? new Error('kernel adapter: mux socket closed'))
      }
    })

    ws.onMessage((text) => {
      let parsed: {
        type?: string
        streamId?: string
        value?: KernelFollowValue
        /** 内核 terminate 帧：{ code, message }（session/writer-held 等） */
        error?: { code?: string; message?: string }
      }
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch {
        return
      }
      if (parsed.type === 'error' && parsed.streamId !== undefined) {
        const state = byStream.get(parsed.streamId)
        if (state !== undefined) {
          // 错误码要在文案映射前留在消息里，映射后的中文文案会丢掉 code 原文
          const raw = parsed.error === undefined ? parsed : parsed.error
          const error = kernelUserError(new Error(JSON.stringify(raw)))
          // 内核终止了这条流：标记为死，下一轮自动重新 follow（否则该 thread 永久收不到帧）
          state.dead = true
          byStream.delete(parsed.streamId)
          state.snapshotReject?.(error)
          settleTurn(state, error)
        }
        return
      }
      if (parsed.type !== 'item' || parsed.streamId === undefined || parsed.value === undefined) return
      const state = byStream.get(parsed.streamId)
      if (state === undefined) return
      const value = parsed.value
      options.onFollowValue?.(value)
      if (value.type === 'snapshot') {
        const raw = value as unknown as Record<string, unknown>
        if (typeof raw.cursor === 'number') state.latestSeq = Math.max(state.latestSeq, raw.cursor)
        const stream = (raw.assistantStream ?? undefined) as Record<string, unknown> | undefined
        const active = (stream?.activeAttempt ?? undefined) as Record<string, unknown> | undefined
        state.snapshotResolve?.({
          ...(typeof raw.cursor === 'number' ? { cursor: raw.cursor } : {}),
          ...(typeof raw.startedAfterSeq === 'number'
            ? { startedAfterSeq: raw.startedAfterSeq }
            : typeof active?.startedAfterSeq === 'number'
              ? { startedAfterSeq: active.startedAfterSeq }
              : {}),
          ...(typeof raw.nextIndex === 'number'
            ? { nextIndex: raw.nextIndex }
            : typeof active?.nextIndex === 'number'
              ? { nextIndex: active.nextIndex }
              : {}),
          snapshotKeys: Object.keys(raw),
          ...(stream === undefined ? {} : { assistantStreamKeys: Object.keys(stream) })
        })
        return
      }
      const turn = state.turn
      if (turn === undefined) return
      const frames = state.mapper.push(value)
      turn.frames.push(...frames)
      if (turn.onFrame !== undefined) {
        for (const frame of frames) {
          try {
            turn.onFrame(frame)
          } catch {
            // 下游断开：等 cancel/stop 收尾
          }
        }
      }
      if (value.type === 'event' && typeof value.event.seq === 'number')
        state.latestSeq = Math.max(state.latestSeq, value.event.seq)
      if (value.type === 'event' && value.event.type === 'turn/end') {
        const reason = value.event.data?.reason as
          { kind?: string; error?: { code?: string; message?: string } } | undefined
        if (reason?.kind === 'cancelled') settleTurn(state, undefined, { cancelled: true })
        else if (reason?.kind === 'completed') settleTurn(state)
        else
          settleTurn(state, undefined, {
            error: {
              ...(reason?.error?.code === undefined ? {} : { code: reason.error.code }),
              message: reason?.error?.message ?? `kernel turn ended with ${reason?.kind ?? 'unknown'}`
            }
          })
      }
    })

    const defaultSessionId = await createSession()
    let defaultState = await openFollow(defaultSessionId)
    states.set(defaultSessionId, defaultState)

    let stopped = false
    return {
      sessionId: defaultSessionId,
      pid: kernel.pid,
      port: Number(new URL(kernel.baseUrl).port),
      async startTurn(text: string, startOptions: StartTurnOptions = {}): Promise<KernelTurnResult> {
        if (stopped) throw new Error('kernel adapter: adapter is stopped')
        if (startOptions.threadId === undefined && defaultState.dead === true) {
          defaultState = await openFollow(defaultSessionId)
          states.set(defaultSessionId, defaultState)
        }
        const state =
          startOptions.threadId === undefined
            ? defaultState
            : await ensureSession(startOptions.threadId)
        if (state.turn !== undefined)
          throw kernelUserError(new Error('session/agent-busy: turn already running'))
        state.mapper = new KernelSseMapper()
        const timeoutMs = options.turnTimeoutMs ?? 120_000
        const promise = new Promise<KernelTurnResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            settleTurn(state, new Error(`kernel adapter: turn timed out after ${String(timeoutMs)}ms`))
          }, timeoutMs)
          state.turn = {
            frames: [],
            resolve,
            reject,
            timer,
            ...(startOptions.onFrame === undefined ? {} : { onFrame: startOptions.onFrame })
          }
        })
        try {
          await rpc.call('session/prompt', {
            request: {
              requestId: randomUUID(),
              sessionId: state.sessionId,
              mode: 'queue',
              content: [{ type: 'text', text }]
            }
          })
        } catch (error) {
          settleTurn(state, kernelUserError(error))
        }
        return promise
      },
      async cancelTurn(threadId?: string) {
        const state = threadId === undefined ? defaultState : states.get(threadId)
        if (state === undefined) return
        try {
          await rpc.call('session/cancel', { request: { sessionId: state.sessionId } })
        } catch (error) {
          console.warn('[kyclaw] kernel adapter: cancel failed', kernelUserError(error).message)
        }
      },
      async listCommands(threadId?: string) {
        return listCommandsInternal(await sessionIdFor(threadId))
      },
      async executeCommand(line: string, threadId?: string): Promise<KernelCommandResult | unknown> {
        // PB-005-F2：内核 `commands/execute` 对未识别行静默丢弃（返回 undefined、无 event），
        // 这里在发 RPC 前先用内核自己的命令清单校验一次，未知命令合成**与内核同形**的 error 结果。
        // 清单拉不到时不阻断（内核仍是权威），只告警。
        const sessionId = await sessionIdFor(threadId)
        const available = await listCommandsInternal(sessionId).catch((error: unknown) => {
          console.warn(
            '[kyclaw] kernel adapter: commands/list 不可用，跳过未知命令校验',
            error instanceof Error ? error.message : String(error)
          )
          return [] as readonly KernelCommandInfo[]
        })
        const name = commandNameFromLine(line)
        if (available.length > 0 && (name === null || !available.some((c) => c.name === name)))
          return unknownCommandResult(line, available)
        return rpc.call<KernelCommandResult>('commands/execute', {
          agentId: sessionId,
          line,
          submittedAttachments: []
        })
      },
      async readGoalState(threadId?: string): Promise<KernelGoalState | null> {
        const projections = await rpc.call<{
          values?: { goal?: KernelGoalState | null }
        }>('session/projections', { request: { sessionId: await sessionIdFor(threadId) } })
        return projections.values?.goal ?? null
      },
      async readPlanState(threadId?: string) {
        const projections = await rpc.call<{
          values?: { plan?: { active?: boolean; pending?: boolean } }
        }>('session/projections', { request: { sessionId: await sessionIdFor(threadId) } })
        const plan = projections.values?.plan
        if (plan === undefined) return null
        return { active: plan.active === true, pending: plan.pending === true }
      },
      async listKernelSessions() {
        return listKernelSessions()
      },
      async reattach(threadId: string): Promise<KernelSessionOpening> {
        const current = states.get(threadId)
        // 新 follow 先接上（拿到 opening 才算接上）；旧流在拿到前仍可收帧
        const next = await openFollow(current?.sessionId ?? (await createSession(threadId)))
        if (current !== undefined) {
          // 旧流立刻摘掉映射：同一会话两条流会把同一帧推两次，宁可少一条重复
          byStream.delete(current.streamId)
          try {
            ws?.send(JSON.stringify({ type: 'cancel', streamId: current.streamId }))
          } catch {
            // ignore
          }
          // 正在跑的一轮挂到新流上：否则 startTurn 的 promise 会一直吊到超时
          if (current.turn !== undefined) {
            next.turn = current.turn
            current.turn = undefined
          }
          // 映射器沿用：text/step 帧的 id 与「已收过哪些帧」不能因为刷新重来一遍
          next.mapper = current.mapper
        }
        states.set(threadId, next)
        return next.opening
      },
      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        closed = true
        for (const state of states.values()) settleTurn(state, new Error('kernel adapter: stopped'))
        settleTurn(defaultState, new Error('kernel adapter: stopped'))
        try {
          ws?.close()
        } catch {
          // ignore
        }
        await kernel.stop()
      }
    }
  } catch (error) {
    try {
      ws?.close()
    } catch {
      // ignore
    }
    await kernel.stop()
    throw kernelUserError(error)
  }
}
