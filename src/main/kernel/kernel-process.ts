/**
 * B3.1a：内核子进程生命周期（Electron-as-node 跑 asar 内 `dsh/lib/bin.js web`）。
 *
 * 安全边界（D1）：启动令牌只在本对象与 `kernel-auth` 之间流转；**不写日志、不进 renderer 帧**。
 * 隔离：`DSH_HOME` 由调用方指到应用数据目录下的子目录，绝不指用户 `~/.dsh`。
 */
import { spawn } from 'node:child_process'
import { planKernelLaunch } from './kernel-entry'

export interface StartKernelProcessOptions {
  electronExecutable: string
  asarPath: string
  /** 应用数据目录下的**专用** home（调用方保证不在用户 `~/.dsh`） */
  dshHome: string
  extraEnv?: Readonly<Record<string, string>>
  readyTimeoutMs?: number
  /** stderr 只用于诊断（会去掉可能的 URL/token 行） */
  onStderr?: (chunk: string) => void
}

export interface KernelProcessHandle {
  readonly baseUrl: string
  /** 启动令牌：只允许传给 `connectKernelPeer`，不得记录或下发 renderer */
  readonly token: string
  readonly pid: number | undefined
  stop(): Promise<void>
}

const READY_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+))/

/** 起内核并等到它打印带 token 的回环 URL；超时/提前退出都会 reject 并已清理子进程 */
export async function startKernelProcess(
  options: StartKernelProcessOptions
): Promise<KernelProcessHandle> {
  const plan = planKernelLaunch({
    electronExecutable: options.electronExecutable,
    asarPath: options.asarPath,
    dshHome: options.dshHome,
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv })
  })
  const child = spawn(plan.executable, [...plan.args], {
    env: { ...process.env, ...plan.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const stdout = child.stdout
  const stderr = child.stderr
  if (stdout === null || stderr === null) {
    child.kill()
    throw new Error('kernel process: stdio pipes unavailable')
  }

  let stderrTail = ''
  stderr.on('data', (chunk: Buffer) => {
    const text = String(chunk)
    stderrTail = `${stderrTail}${text}`.slice(-4000)
    options.onStderr?.(text.replace(READY_PATTERN, 'dsh web: <redacted>'))
  })

  const ready = await new Promise<{ baseUrl: string; token: string }>((resolve, reject) => {
    let buffer = ''
    const timeoutMs = options.readyTimeoutMs ?? 30_000
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `kernel process: not ready after ${String(timeoutMs)}ms${stderrTail === '' ? '' : `; stderr: ${stderrTail.slice(-1200)}`}`
        )
      )
    }, timeoutMs)

    const onData = (chunk: Buffer): void => {
      buffer += String(chunk)
      const match = READY_PATTERN.exec(buffer)
      if (match === null) return
      const [, url = '', , token = ''] = match
      cleanup()
      resolve({ baseUrl: new URL(url).origin, token })
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(
        new Error(
          `kernel process: exited before ready (code=${String(code)}, signal=${String(signal)})${stderrTail === '' ? '' : `; stderr: ${stderrTail.slice(-1200)}`}`
        )
      )
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      stdout.off('data', onData)
      child.off('exit', onExit)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
  }).catch(async (error: unknown) => {
    await stopChild(child, 2_000)
    throw error
  })

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await stopChild(child, 3_000)
  }
  return {
    baseUrl: ready.baseUrl,
    token: ready.token,
    pid: child.pid,
    stop
  }
}

/** 先 SIGTERM，宽限期内没退就强杀；无论哪种都不留句柄 */
async function stopChild(child: ReturnType<typeof spawn>, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve()
    })
  })
  try {
    child.kill()
  } catch {
    // 进程可能已退出
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, graceMs)
  await exited
  clearTimeout(timer)
  // 让 stdio 收尾，避免句柄把测试进程吊住
  child.stdout?.destroy()
  child.stderr?.destroy()
}
