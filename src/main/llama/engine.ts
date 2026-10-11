/**
 * 本机嵌入引擎（模块 3B）：llama.cpp `llama-server` 子进程的生命周期管理。
 *
 * 职责边界（**纯 Node，不 import electron**，所以能在 vitest node 环境里用假二进制真跑）：
 *   - 按需 spawn（懒加载）：第一次 `ensureStarted()` 才起进程；已经是 running 就直接复用；
 *   - spawn 参数在这里拼（`-m` / `--host` / `--port` / `--api-key` / `--embeddings` / `--no-webui`）；
 *   - 健康检查：轮询 `/health`（llama.cpp 在模型加载完之前不监听端口 / 回 503 —— 两种都当"还没好"）；
 *   - **空闲回收**：`idleMs` 内没有请求（由网关 touch）就把进程杀掉 —— 内存 100% 回收；下次请求再起；
 *   - 崩溃自动重拉**一次**（重启额度在健康检查通过后补满），再崩就落到 error 并把原因交出去；
 *   - 单实例：一个引擎只装一个模型（v1 口径）。
 *
 * `--pooling` **不传**：三个候选档的 GGUF 元数据都声明了正确的池化
 * （实测：bge 系 cls=2、Qwen3-Embedding last=3、multilingual-e5 mean=1），而 llama-server 的
 * `--pooling` 缺省就是"用模型元数据"。实测钉过：bge-small-zh 显式传 `--pooling cls` 与不传，
 * 向量逐分量差为 0 —— 显式硬编码反而会把"某个档的池化其实是 mean"这种事写死错。
 *
 * 模型文件与二进制路径都由调用方注入（Electron 侧算路径，这里不碰 app.getPath）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** 引擎相位（与 shared/local-models 的 enginePhaseSchema 同集合） */
export type EnginePhase = 'stopped' | 'starting' | 'running' | 'error'

export interface EngineStatus {
  phase: EnginePhase
  /** 引擎当前加载的模型 id（没起来 = null） */
  modelId: string | null
  /** 一句人话：错误原因 / 空闲回收 / 启动中（正常运行时为 null） */
  detail: string | null
}

export interface LlamaEngineOptions {
  /** `llama-server.exe` 的绝对路径 */
  binaryPath: string
  /** GGUF 的绝对路径 */
  modelPath: string
  /** 界面/状态里显示的模型 id（清单 id 或 `custom`） */
  modelId: string
  /** 引擎自带的 API Key（每次启动新生成；网关转发时带上，别让本机别的进程随便用） */
  apiKey: string
  /** 缺省 30 秒：模型加载（mmap）比进程启动慢得多，1GB 档在慢盘上也要留余量 */
  startupTimeoutMs?: number
  /** 缺省 5 分钟；`0` = 不回收。现读（设置页改了下一轮空闲判定就用新值） */
  idleMs?: () => number
  /** 空闲判定轮询间隔（缺省 20 秒；测试调小） */
  idlePollMs?: number
  /** 端口探测失败时的重试次数（缺省 3） */
  portAttempts?: number
  /**
   * 附加命令行参数（写在 `-m` 之前）。**只给测试用脚手架**：测进程生命周期时，用
   * `node <stub.mjs>` 冒充"二进制"（Windows 上不能直接 spawn 一个 `.mjs`），生产不传。
   */
  extraArgs?: readonly string[]
  /** 日志口（缺省 console.warn 只打事故；正常启动也打一行 info，便于排障） */
  log?: (message: string, error?: unknown) => void
  /** 状态变化的回调（主进程拿它广播给界面；可选） */
  onChange?: (status: EngineStatus) => void
  /** 测试注入：spawn 替身（缺省 node:child_process.spawn） */
  spawnFn?: typeof spawn
}

export interface LlamaEngine {
  /** 确保引擎可用；回实际监听端口。已在跑就直接返回（并刷新空闲计时） */
  ensureStarted(): Promise<{ port: number }>
  status(): EngineStatus
  /** 网关每次转发前后打点：`begin()` 回一个"结束"的函数 */
  begin(): () => void
  /** 最近一次请求时刻（空闲判定的输入） */
  lastUsedAt(): number
  /** 主动停（idle / manual / shutdown）；重复调用是空操作 */
  stop(reason: 'idle' | 'manual' | 'shutdown'): Promise<void>
  /** 停进程 + 清定时器（应用退出） */
  dispose(): Promise<void>
}

/** 引擎日志留最后这些行，作为错误原因的证据（错误只给人话，原文进日志） */
const LOG_TAIL = 12

/** 空闲回收后状态里的那句话（界面直接显示它） */
export const IDLE_DETAIL = '空闲已回收'

function defaultLog(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message)
  else console.warn(message, error)
}

/** 取一个当前空闲的 127.0.0.1 端口（先让 OS 分配再释放；紧接着交给子进程） */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('拿不到空闲端口'))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

/** 一句人话的失败原因：取引擎日志最后一条有用行（没有就给通用文案） */
function reasonFrom(lines: readonly string[]): string {
  const last = [...lines].reverse().find((line) => line.trim().length > 0)
  if (last === undefined) return '引擎没有输出可用信息'
  return last.length > 200 ? `${last.slice(0, 197)}…` : last
}

export function createLlamaEngine(options: LlamaEngineOptions): LlamaEngine {
  const log = options.log ?? defaultLog
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000
  const idlePollMs = options.idlePollMs ?? 20_000
  const portAttempts = Math.max(1, options.portAttempts ?? 3)
  const spawnFn = options.spawnFn ?? spawn

  let child: ChildProcess | undefined
  let port = 0
  /** 启动中的那一次（并发调 ensureStarted 共用它） */
  let starting: Promise<{ port: number }> | undefined
  let phase: EnginePhase = 'stopped'
  let detail: string | null = null
  /** 崩溃自动重拉的额度（健康检查通过后补满；只给一次） */
  let restartsLeft = 1
  let lastUsed = Date.now()
  let inflight = 0
  /** 正在主动停（区分"崩溃"与"我们自己杀的"） */
  let stopping = false
  const tail: string[] = []
  let idleTimer: ReturnType<typeof setInterval> | undefined

  const status = (): EngineStatus => ({
    phase,
    modelId: phase === 'stopped' ? null : options.modelId,
    detail
  })
  const notify = (): void => {
    options.onChange?.(status())
  }

  function pushLog(chunk: Buffer): void {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim()
      if (text === '') continue
      tail.push(text)
      if (tail.length > LOG_TAIL) tail.shift()
    }
  }

  async function healthOnce(candidate: number): Promise<'ok' | 'loading' | 'down'> {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate}/health`, {
        signal: AbortSignal.timeout(3_000)
      })
      if (response.status === 200) {
        const body = (await response.json().catch(() => null)) as { status?: unknown } | null
        return body?.status === 'ok' ? 'ok' : 'loading'
      }
      // 503 = 模型还在加载（llama.cpp 在加载期回这个）
      return 'loading'
    } catch {
      // 连接被拒 = 还没监听（模型加载完才 bind）；超时同理
      return 'down'
    }
  }

  /** 起进程 + 等健康；失败把原因抛出去（调用方决定是否重试端口） */
  async function spawnOnce(candidate: number): Promise<void> {
    const args = [
      ...(options.extraArgs ?? []),
      '-m',
      options.modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(candidate),
      '--api-key',
      options.apiKey,
      // 只做嵌入：不挂 UI、不开对话能力（引擎是内部件，不是给用户访问的服务）
      '--embeddings',
      '--no-webui'
    ]
    const started = spawnFn(options.binaryPath, args, {
      // Windows：不要在用户屏幕上闪一个控制台窗口
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child = started
    port = candidate
    tail.length = 0

    started.stdout?.on('data', (chunk: Buffer) => pushLog(chunk))
    started.stderr?.on('data', (chunk: Buffer) => pushLog(chunk))
    started.on('error', (error) => {
      pushLog(Buffer.from(`spawn 失败：${error.message}`))
      // 起不来（ENOENT 等）就别再等它——把 child 清掉，健康检查那一步立刻按"进程没了"失败
      if (child === started) child = undefined
    })
    started.on('exit', (code, signal) => {
      if (child !== started) return
      child = undefined
      if (stopping) {
        phase = 'stopped'
        notify()
        return
      }
      // 意外退出：记日志，然后按额度自动重拉一次（下一次 ensureStarted 也会再试）
      const why = `引擎进程退出（code=${String(code)}, signal=${String(signal)}）：${reasonFrom(tail)}`
      log(`[kyclaw] 本机嵌入引擎意外退出：${why}`)
      phase = 'error'
      detail = why
      notify()
      if (restartsLeft > 0) {
        restartsLeft -= 1
        starting = undefined
        void restartSoon()
      }
    })

    const deadline = Date.now() + startupTimeoutMs
    for (;;) {
      const state = await healthOnce(candidate)
      if (state === 'ok') return
      if (child === undefined) {
        throw new Error(`引擎进程已退出：${reasonFrom(tail)}`)
      }
      if (Date.now() > deadline) {
        throw new Error(
          `引擎在 ${Math.round(startupTimeoutMs / 1000)} 秒内没有就绪：${reasonFrom(tail)}`
        )
      }
      await delay(150)
    }
  }

  /** 崩溃后重拉一次（不抛：失败就落到 error 状态，等下一次请求再试） */
  async function restartSoon(): Promise<void> {
    await delay(300)
    if (stopping || child !== undefined) return
    try {
      phase = 'starting'
      detail = null
      notify()
      await spawnOnce(port)
      restartsLeft = 1
      phase = 'running'
      detail = null
      lastUsed = Date.now()
      log(`[kyclaw] 本机嵌入引擎已重拉（端口 ${port}）`)
      notify()
    } catch (error) {
      phase = 'error'
      detail = error instanceof Error ? error.message : String(error)
      log('[kyclaw] 本机嵌入引擎重拉失败', error)
      notify()
    }
  }

  async function start(): Promise<{ port: number }> {
    // 二进制不在：立刻回人话（换端口重试没有意义，别拖到超时）
    if (!existsSync(options.binaryPath)) {
      phase = 'error'
      detail = `找不到引擎文件：${options.binaryPath}`
      notify()
      throw new Error(detail)
    }
    phase = 'starting'
    detail = null
    notify()
    let lastError: unknown
    for (let attempt = 1; attempt <= portAttempts; attempt++) {
      let candidate: number
      try {
        candidate = await freePort()
      } catch (error) {
        lastError = error
        break
      }
      try {
        await spawnOnce(candidate)
        restartsLeft = 1
        phase = 'running'
        detail = null
        lastUsed = Date.now()
        log(`[kyclaw] 本机嵌入引擎已启动：127.0.0.1:${port}（模型 ${options.modelId}）`)
        notify()
        return { port }
      } catch (error) {
        lastError = error
        await stop('manual')
        log(`[kyclaw] 本机嵌入引擎启动失败（第 ${attempt} 次）`, error)
      }
    }
    phase = 'error'
    detail = lastError instanceof Error ? lastError.message : String(lastError)
    notify()
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async function stop(reason: 'idle' | 'manual' | 'shutdown'): Promise<void> {
    starting = undefined
    if (child === undefined) {
      if (reason !== 'shutdown') {
        phase = 'stopped'
        detail = reason === 'idle' ? IDLE_DETAIL : detail
        notify()
      }
      return
    }
    stopping = true
    const victim = child
    child = undefined
    try {
      victim.kill()
      // 等它真的走（Windows 上 kill 是 TerminateProcess，很快；给 5 秒兜底）
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5_000)
        victim.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } finally {
      stopping = false
      phase = 'stopped'
      detail = reason === 'idle' ? IDLE_DETAIL : null
      if (reason === 'idle') log('[kyclaw] 本机嵌入引擎空闲回收（内存已释放）')
      notify()
    }
  }

  // 空闲判定：只在"没在跑请求"且"距上次请求超过 idleMs"时回收（idleMs <= 0 = 不回收）
  idleTimer = setInterval(() => {
    const idleMs = options.idleMs?.() ?? 300_000
    if (idleMs <= 0) return
    if (phase !== 'running' || child === undefined || inflight > 0) return
    if (Date.now() - lastUsed < idleMs) return
    void stop('idle').catch((error: unknown) => {
      log('[kyclaw] 本机嵌入引擎空闲回收失败（下次请求仍会重启）', error)
    })
  }, idlePollMs)
  idleTimer.unref?.()

  return {
    ensureStarted: async () => {
      lastUsed = Date.now()
      if (phase === 'running' && child !== undefined) return { port }
      if (starting !== undefined) return await starting
      starting = start()
      try {
        return await starting
      } finally {
        starting = undefined
      }
    },
    status,
    begin: () => {
      inflight += 1
      lastUsed = Date.now()
      let done = false
      return () => {
        if (done) return
        done = true
        inflight = Math.max(0, inflight - 1)
        lastUsed = Date.now()
      }
    },
    lastUsedAt: () => lastUsed,
    stop,
    dispose: async () => {
      if (idleTimer !== undefined) clearInterval(idleTimer)
      idleTimer = undefined
      await stop('shutdown')
    }
  }
}
