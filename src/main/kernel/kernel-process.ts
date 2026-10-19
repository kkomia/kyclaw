/**
 * B3.1a：内核子进程生命周期（Electron-as-node 跑 asar 内 `dsh/lib/bin.js web`）。
 *
 * 安全边界（D1）：启动令牌只在本对象与 `kernel-auth` 之间流转；**不写日志、不进 renderer 帧**。
 * 隔离：`DSH_HOME` 由调用方指到应用数据目录下的子目录，绝不指用户 `~/.dsh`。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chooseKernelScript, planKernelLaunch } from './kernel-entry'
import { KernelStartupError, assertKernelLaunchConfigured } from './kernel-startup'

export interface StartKernelProcessOptions {
  electronExecutable: string
  /** 内核根（旧布局 = app.asar 根；新布局 = 版本目录 `<resources/kernel>/<version>`） */
  asarPath: string
  /** 可选：显式内核树根（给了就优先按 `<root>/node_modules/...` 找入口） */
  kernelRoot?: string
  /** 应用数据目录下的**专用** home（调用方保证不在用户 `~/.dsh`） */
  dshHome: string
  extraEnv?: Readonly<Record<string, string>>
  readyTimeoutMs?: number
  /** stderr 只用于诊断（会去掉可能的 URL/token 行） */
  onStderr?: (chunk: string) => void
  /**
   * PB-043：ready **之后**进程退出（运行期崩溃）的回调。
   * 启动期的 exit 由 ready 的 Promise 自己接；这一条是给「用着用着内核没了」留的观察点。
   */
  onExit?: (info: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
}

export interface KernelProcessHandle {
  readonly baseUrl: string
  /** 启动令牌：只允许传给 `connectKernelPeer`，不得记录或下发 renderer */
  readonly token: string
  readonly pid: number | undefined
  stop(): Promise<void>
}

const READY_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+))/

/**
 * 诊断脱敏（H1/Eve 验收）：stderr 进 Error.message / 日志前必须过这一层。
 *
 * 防线：即使当前内核 stderr 恰好不打印 token，未来任何一行带上 URL/token/cookie，
 * 也不能原样进入错误卡（B3.1b 接通后错误文本会到用户眼前）。
 * - `token=…`（query 参数）→ `token=<redacted>`
 * - `dsh-auth-…=…`（API cookie）→ `<redacted>`
 * - `Authorization: Bearer …` / `Cookie: …`  整段值 → `<redacted>`
 */
export function redactKernelDiagnostics(text: string): string {
  return text
    .replace(/([?&]token=)[^\s"'&]+/giu, '$1<redacted>')
    .replace(/(dsh-auth-[A-Za-z0-9_-]+=)[^\s;"']+/gu, '$1<redacted>')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/giu, '$1<redacted>')
    .replace(/(Cookie:\s*)[^\r\n"']+/giu, '$1<redacted>')
}

/** 起内核并等到它打印带 token 的回环 URL；超时/提前退出都会 reject 并已清理子进程 */
export async function startKernelProcess(
  options: StartKernelProcessOptions
): Promise<KernelProcessHandle> {
  // PB-017：spawn 之前先校验（空串交给 spawn 会同步抛 TypeError；见 kernel-startup.ts）
  assertKernelLaunchConfigured({
    electronExecutable: options.electronExecutable,
    kernelRoot: options.asarPath
  })
  // PB-006：两种布局按"入口实际存在"选（不靠版本号/flag 猜）；都不存在时抛 KERNEL_ENTRY_MISSING
  const script = chooseKernelScript({
    asarPath: options.asarPath,
    ...(options.kernelRoot === undefined ? {} : { kernelRoot: options.kernelRoot }),
    exists: existsSync
  })
  const plan = planKernelLaunch({
    electronExecutable: options.electronExecutable,
    asarPath: options.asarPath,
    ...(options.kernelRoot === undefined ? {} : { kernelRoot: options.kernelRoot }),
    scriptPath: script.scriptPath,
    dshHome: options.dshHome,
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv })
  })
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(plan.executable, [...plan.args], {
      env: { ...process.env, ...plan.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    throw spawnFailedError(error, plan.scriptPath)
  }
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
    options.onStderr?.(redactKernelDiagnostics(text))
  })

  const ready = await new Promise<{ baseUrl: string; token: string }>((resolve, reject) => {
    let buffer = ''
    const timeoutMs = options.readyTimeoutMs ?? 30_000
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new KernelStartupError(
          'KERNEL_NOT_READY',
          `内核进程就绪超时（KERNEL_NOT_READY）：${String(timeoutMs)}ms 内没有打印回环 URL；入口：${plan.scriptPath}${stderrTail === '' ? '' : `；stderr: ${redactKernelDiagnostics(stderrTail.slice(-1200))}`}`,
          { scriptPath: plan.scriptPath }
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
        new KernelStartupError(
          'KERNEL_EXITED',
          `内核进程提前退出（KERNEL_EXITED）：exitCode=${String(code)}，signal=${String(signal)}；入口：${plan.scriptPath}${stderrTail === '' ? '' : `；stderr: ${redactKernelDiagnostics(stderrTail.slice(-1200))}`}`,
          {
            exitCode: code,
            signal,
            ...(stderrTail === '' ? {} : { stderrTail: redactKernelDiagnostics(stderrTail) }),
            scriptPath: plan.scriptPath
          }
        )
      )
    }
    // spawn 的异步失败（ENOENT/EACCES…）走 'error' 事件：不接会把主进程直接带崩。
    const onError = (error: Error): void => {
      cleanup()
      reject(spawnFailedError(error, plan.scriptPath))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  }).catch(async (error: unknown) => {
    await stopChild(child, 2_000)
    throw error
  })

  // P3（Eve 验收建议）：ready 之后原先的 spawn 'error' 监听会随 cleanup 摘掉；运行期再来的
  // EPERM/EACCES（杀进程失败、句柄异常等）不该变成未捕获事件把主进程带崩 —— 留一个永久 log-only。
  // 它不改变任何状态：服务已建立，错误只记录，由上层重试/重启应用兜底。
  child.on('error', (error: Error) => {
    console.warn('[kyclaw] 内核进程运行期错误（已建立的服务不受影响；持续出现请重启应用）', error)
  })
  // PB-043：ready 之后保留 exit 监听（不改变任何状态，只上报——用户可见面由上层决定）。
  if (options.onExit !== undefined) {
    child.once('exit', (code, signal) => {
      options.onExit?.({ exitCode: code, signal })
    })
  }

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

/** spawn 失败（同步抛或 'error' 事件）统一成带 code 的可诊断错误（PB-017/PB-006） */
function spawnFailedError(error: unknown, scriptPath: string): KernelStartupError {
  const detail = error instanceof Error ? error.message : String(error)
  return new KernelStartupError(
    'KERNEL_SPAWN_FAILED',
    `内核进程启动失败（KERNEL_SPAWN_FAILED）：${detail}；入口：${scriptPath}`,
    { scriptPath }
  )
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
