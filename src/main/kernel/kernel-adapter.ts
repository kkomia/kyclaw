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
import { join } from 'node:path'
import { connectKernelPeer } from './kernel-auth'
import { startKernelProcess } from './kernel-process'
import { KernelRpcClient } from './kernel-rpc'
import { KernelSseMapper, type KernelFollowValue, type RendererSseFrame } from './sse-map'
import { connectWebSocket, type WebSocketClient } from './ws-mux'

export interface KernelAdapterOptions {
  electronExecutable: string
  asarPath: string
  /** 应用数据目录（内核 home 会建在其下 `dsh-kernel-home`；不含用户 `~/.dsh`） */
  appDataDir: string
  extraEnv?: Readonly<Record<string, string>>
  readyTimeoutMs?: number
  turnTimeoutMs?: number
}

export interface KernelTurnResult {
  frames: RendererSseFrame[]
  /** 逐帧 `data: <json>`（与现有 chat SSE 的写法一致） */
  sse: string
  text: string
}

export interface KernelAdapter {
  readonly sessionId: string
  /** 诊断用：内核进程 pid（不含 token/cookie） */
  readonly pid: number | undefined
  /** 诊断用：内核回环端口（不含 token/cookie） */
  readonly port: number
  startTurn(text: string): Promise<KernelTurnResult>
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
}

export async function startKernelAdapter(options: KernelAdapterOptions): Promise<KernelAdapter> {
  const dshHome = join(options.appDataDir, 'dsh-kernel-home')
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
    let turn: TurnState | undefined
    let snapshot: (() => void) | undefined
    let closed = false

    const settleTurn = (error?: Error): void => {
      if (turn === undefined) return
      const current = turn
      turn = undefined
      clearTimeout(current.timer)
      if (error !== undefined) {
        current.reject(error)
        return
      }
      const text = current.frames
        .flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : []))
        .join('')
      current.resolve({ frames: current.frames, sse: framesToSse(current.frames), text })
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
      if (value.type === 'snapshot') {
        snapshot?.()
        return
      }
      if (turn === undefined) return
      const frames = mapper.push(value)
      turn.frames.push(...frames)
      if (value.type === 'event' && value.event.type === 'turn/end') {
        const reason = value.event.data?.reason as { kind?: string } | undefined
        settleTurn(
          reason?.kind === 'completed'
            ? undefined
            : new Error(`kernel adapter: turn ended with ${reason?.kind ?? 'unknown'}`)
        )
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
      async startTurn(text: string): Promise<KernelTurnResult> {
        if (stopped) throw new Error('kernel adapter: adapter is stopped')
        if (turn !== undefined) throw new Error('kernel adapter: a turn is already running')
        mapper = new KernelSseMapper()
        const timeoutMs = options.turnTimeoutMs ?? 120_000
        const promise = new Promise<KernelTurnResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            settleTurn(new Error(`kernel adapter: turn timed out after ${String(timeoutMs)}ms`))
          }, timeoutMs)
          turn = { frames: [], resolve, reject, timer }
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
