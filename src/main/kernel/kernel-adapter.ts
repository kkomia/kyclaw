/**
 * B3.1a：真内核适配层（**只在 feature flag 开启时才会被实例化**）。
 *
 * 一次流程：
 *   startKernelProcess（Electron-as-node + asar 内 bin；隔离 DSH_HOME）
 *   → connectKernelPeer（`/connect` 换 API cookie + mux 地址）
 *   → RPC `session/create`
 *   → WS `/api/remote.mux` 打开 `session/follow`（assistantStream: true）
 *   → RPC `session/prompt` 发一条消息
 *   → 内核帧经 `KernelSseMapper` 映射成**现有 renderer SSE 帧**
 *   → `stop()` 关 WS + 停子进程（不留孤儿）。
 *
 * 安全（D1）：内核 token/cookie 只在本模块内部；`KernelAdapter` 不暴露它们。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectKernelPeer } from './kernel-auth'
import { startKernelProcess } from './kernel-process'
import { KernelRpcClient } from './kernel-rpc'
import { KernelSseMapper, type KernelFollowValue, type RendererSseFrame } from './sse-map'
import type { KernelGoalState } from './goal-projection'
import { connectWebSocket, type WebSocketClient } from './ws-mux'

export interface KernelAdapterOptions {
  electronExecutable: string
  asarPath: string
  /** 应用数据目录（内核 home 会建在其下 `dsh-kernel-home`；不含用户 `~/.dsh`） */
  appDataDir: string
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
  /** 逐帧 `data: <json>`（与现有 chat SSE 的写法一致） */
  sse: string
  text: string
  /** 内核错误轮（工具错误码等）；**已交付的文本帧仍在 frames 里**，错误帧追加在末尾 */
  error?: { code?: string; message: string }
  /** 内核侧取消（文本同样保留） */
  cancelled?: boolean
}

export interface StartTurnOptions {
  /** 增量送出：每产生一帧立刻回调（B3.2 边收边发；不传 = 只返回整轮结果） */
  onFrame?: (frame: RendererSseFrame) => void
}

export interface KernelAdapter {
  readonly sessionId: string
  /** 诊断用：内核进程 pid（不含 token/cookie） */
  readonly pid: number | undefined
  /** 诊断用：内核回环端口（不含 token/cookie） */
  readonly port: number
  /** B3.3：只读命令平面（内核已注册的命令，含 goal/plan） */
  listCommands(): Promise<readonly { name: string; description?: string }[]>
  /** B3.3：执行一条内核命令（不产生模型消息）；goal/plan 都由内核处理 */
  executeCommand(line: string): Promise<unknown>
  /** B3.3：读内核 goal 快照（内核权威；我方只投影，不写） */
  readGoalState(): Promise<KernelGoalState | null>
  /** B3.3：读内核 plan 状态（只读投影；真正 plan 模式由内核 /plan 命令/工具处理） */
  readPlanState(): Promise<{ active: boolean; pending: boolean } | null>
  startTurn(text: string, options?: StartTurnOptions): Promise<KernelTurnResult>
  /** 取消当前轮（协作式；文本保留，由内核 `session/cancel` 结算） */
  cancelTurn(): Promise<void>
  stop(): Promise<void>
}

export function framesToSse(frames: readonly RendererSseFrame[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

interface TurnState {
  frames: RendererSseFrame[]
  resolve: (result: KernelTurnResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  onFrame?: (frame: RendererSseFrame) => void
}

/**
 * B3.3b：把 maxGoalRounds 钉进**我们生成的 profile patch**（不改内核包）。
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

export async function startKernelAdapter(options: KernelAdapterOptions): Promise<KernelAdapter> {
  const dshHome = join(options.appDataDir, 'dsh-kernel-home')
  ensureGoalRoundCap(dshHome, options.goalMaxRounds ?? 16)
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
    const created = await rpc.call<{ sessionId: string }>('session/create', {
      request: { cwd: options.appDataDir }
    })
    const sessionId = created.sessionId

    ws = await connectWebSocket({ url: auth.muxUrl, cookie: auth.cookie })
    const streamId = `kyclaw-follow-${randomUUID()}`
    let mapper = new KernelSseMapper()
    let latestSeq = 0
    let turn: TurnState | undefined
    let snapshot: (() => void) | undefined
    let closed = false

    const settleTurn = (
      failure?: Error,
      outcome?: { error?: KernelTurnResult['error']; cancelled?: boolean }
    ): void => {
      if (turn === undefined) return
      const current = turn
      turn = undefined
      clearTimeout(current.timer)
      if (failure !== undefined) {
        current.reject(failure)
        return
      }
      const text = current.frames
        .flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : []))
        .join('')
      current.resolve({
        frames: current.frames,
        sse: framesToSse(current.frames),
        text,
        ...(outcome?.error === undefined ? {} : { error: outcome.error }),
        ...(outcome?.cancelled === true ? { cancelled: true } : {})
      })
    }

    ws.onClose((error) => {
      if (closed) return
      closed = true
      settleTurn(error ?? new Error('kernel adapter: mux socket closed'))
    })

    ws.onMessage((text) => {
      let parsed: { type?: string; streamId?: string; value?: KernelFollowValue }
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch {
        return
      }
      if (parsed.type !== 'item' || parsed.streamId !== streamId || parsed.value === undefined)
        return
      const value = parsed.value
      options.onFollowValue?.(value)
      if (value.type === 'snapshot') {
        if (typeof (value as { cursor?: unknown }).cursor === 'number')
          latestSeq = Math.max(latestSeq, (value as { cursor: number }).cursor)
        snapshot?.()
        return
      }
      if (turn === undefined) return
      const frames = mapper.push(value)
      turn.frames.push(...frames)
      // 增量：到一帧发一帧（B3.2）；回调异常不能打断内核流
      if (turn.onFrame !== undefined) {
        for (const frame of frames) {
          try {
            turn.onFrame(frame)
          } catch {
            // 下游（HTTP 客户端）已断开：忽略，等 cancel/stop 收尾
          }
        }
      }
      if (value.type === 'event' && typeof value.event.seq === 'number')
        latestSeq = Math.max(latestSeq, value.event.seq)
      if (value.type === 'event' && value.event.type === 'turn/end') {
        const reason = value.event.data?.reason as
          { kind?: string; error?: { code?: string; message?: string } } | undefined
        // 错误/取消：**保留已交付帧**（R11 基线），只把结算信息带回去；只有传输层错误才 reject
        if (reason?.kind === 'cancelled') settleTurn(undefined, { cancelled: true })
        else if (reason?.kind === 'completed') settleTurn()
        else
          settleTurn(undefined, {
            error: {
              ...(reason?.error?.code === undefined ? {} : { code: reason.error.code }),
              message:
                reason?.error?.message ?? `kernel turn ended with ${reason?.kind ?? 'unknown'}`
            }
          })
      }
    })

    ws.send(
      JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: {
          args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } }
        }
      })
    )

    // 等首帧 snapshot，确认 follow 已被内核接纳（避免 prompt 先于订阅）
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('kernel adapter: session/follow did not become ready'))
      }, 10_000)
      snapshot = () => {
        clearTimeout(timer)
        resolve()
      }
    })

    let stopped = false
    return {
      sessionId,
      pid: kernel.pid,
      port: Number(new URL(kernel.baseUrl).port),
      async startTurn(
        text: string,
        startOptions: StartTurnOptions = {}
      ): Promise<KernelTurnResult> {
        if (stopped) throw new Error('kernel adapter: adapter is stopped')
        if (turn !== undefined) throw new Error('kernel adapter: a turn is already running')
        mapper = new KernelSseMapper()
        const timeoutMs = options.turnTimeoutMs ?? 120_000
        const promise = new Promise<KernelTurnResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            settleTurn(new Error(`kernel adapter: turn timed out after ${String(timeoutMs)}ms`))
          }, timeoutMs)
          turn = {
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
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text }]
            }
          })
        } catch (error) {
          settleTurn(error instanceof Error ? error : new Error(String(error)))
        }
        return promise
      },
      async listCommands() {
        const result = await rpc.call<Array<{ name: string; description?: string }>>(
          'commands/list',
          {
            agentId: sessionId
          }
        )
        return result
      },
      async executeCommand(line: string) {
        return rpc.call('commands/execute', {
          agentId: sessionId,
          line,
          submittedAttachments: []
        })
      },
      async readGoalState(): Promise<KernelGoalState | null> {
        const projections = await rpc.call<{
          values?: { goal?: KernelGoalState | null; plan?: { active?: boolean; pending?: boolean } }
        }>('session/projections', { request: { sessionId } })
        return projections.values?.goal ?? null
      },
      async readPlanState() {
        const projections = await rpc.call<{
          values?: { plan?: { active?: boolean; pending?: boolean } }
        }>('session/projections', { request: { sessionId } })
        const plan = projections.values?.plan
        if (plan === undefined) return null
        return { active: plan.active === true, pending: plan.pending === true }
      },
      async cancelTurn(): Promise<void> {
        if (stopped) return
        try {
          await rpc.call('session/cancel', { request: { sessionId } })
        } catch (error) {
          // 取消是尽力而为：内核未接受时不要盖住原始流错误
          console.warn('[kyclaw] kernel adapter: cancel failed', error)
        }
      },
      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        closed = true
        settleTurn(new Error('kernel adapter: stopped'))
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
    throw error
  }
}
