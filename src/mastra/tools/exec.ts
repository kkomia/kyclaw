/**
 * 子进程执行内核（bash / git 两个能力共用）：抓输出、超时杀进程树、输出按字节截断。
 *
 * 三件事：
 *   1. **输出捕获**：stdout/stderr 收进同一个采集器，按字节保留「前一半 + 后一半」；
 *      超过 maxOutputBytes 时中间省略并标注（截断点收在 UTF-8 字符边界上，不吐半个汉字，
 *      与 read/grep 的截断纪律一致）；捕获总量有硬上限，超长输出的进程不会把内存撑爆。
 *   2. **超时杀进程树**：先跑调用方给的 killExtra（bash 用它做 MSYS 进程组杀 —— Git Bash
 *      fork 出来的子进程不在 Windows 父链上，taskkill /T 打不到它们，实测），再 taskkill /T /F
 *      （非 Windows：detached 进程组 kill）。杀完给一小段宽限等 close，仍不关就关掉读端收尾，
 *      不让一次超时把调用卡死。
 *   3. **退出判定**：正常路径等 close（输出收全）；命令本身已退出、但输出管道被 `&` 起的
 *      后台进程占着时，等一小段宽限就不再等（报告 streamHeldOpen），避免 `cmd &` 把调用
 *      拖到超时。stderr 与 stdout 的**真实交错顺序**依赖调用方在子进程侧先做 fd 合并
 *      （bash 的包装器里有 `exec 2>&1`）；不做合并的调用方（git）两条管道分别按到达顺序收录。
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** 输出上限（字节）：超过就首尾保留、中间省略。模型看到的就是这个量级 */
export const MAX_OUTPUT_BYTES = 64 * 1024

/** 超时杀完之后等 close 的宽限：超了就不再等 */
const KILL_GRACE_MS = 3000

/** 命令已退出、但管道仍被后台进程占用时等 close 的宽限 */
const DETACHED_GRACE_MS = 1000

/** 遥测：捕获器最多留多少原始字节（首尾各半）——再多的输出只计数、不留内容 */
const CAPTURE_LIMIT_BYTES = MAX_OUTPUT_BYTES * 4

export interface RunResult {
  /** 合并后的输出（已按上限做首尾截断，截断说明内嵌在文本里） */
  text: string
  /** 输出总字节数（含没保留的部分） */
  totalBytes: number
  truncated: boolean
  /** 子进程退出码；被信号杀 / spawn 失败时为 null */
  exitCode: number | null
  timedOut: boolean
  /** 命令已结束、但输出管道仍被后台进程占用（如 `cmd &` 起的常驻进程） */
  streamHeldOpen: boolean
  /** 启动失败（命令不存在等）；此时 text 为空、exitCode 为 null */
  spawnError: Error | null
}

export interface RunOptions {
  command: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  /** 输出上限（字节），缺省 MAX_OUTPUT_BYTES */
  maxOutputBytes?: number
  /** 每收到一段原始输出就回调（bash 用它当场解析握手行） */
  onData?: (chunk: Buffer) => void
  /** 超时后、通用杀法之前的额外杀法（bash：MSYS 进程组），同步实现 */
  killExtra?: (pid: number | undefined) => void
}

/** 按码点边界拼接的截断说明（bash / fetch 共用同一句话） */
export function truncationNote(totalBytes: number, headBytes: number, tailBytes: number): string {
  return `[输出已截断：共 ${totalBytes} 字节，仅保留前 ${headBytes} 字节与后 ${tailBytes} 字节]`
}

/** 超时秒数的显示口径（整数秒不给小数点；120000 → 120、1500 → 1.5） */
export function formatSeconds(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? String(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1)
}

/**
 * 把一段已解码文本按字节上限做"首尾保留"截断（fetch 的正文回传用；与子进程输出同口径，
 * 截断点收在 UTF-8 字符边界上）。
 */
export function clipText(
  text: string,
  maxBytes: number = MAX_OUTPUT_BYTES
): { text: string; truncated: boolean } {
  const total = Buffer.byteLength(text, 'utf8')
  if (total <= maxBytes) return { text, truncated: false }

  const headBytes = Math.floor(maxBytes / 2)
  const tailBytes = maxBytes - headBytes
  const bytes = Buffer.from(text, 'utf8')
  const headText = new StringDecoder('utf8').write(bytes.subarray(0, headBytes))
  const tailText = decodeFromBoundary(bytes.subarray(bytes.length - tailBytes))
  const note = truncationNote(total, headBytes, tailBytes)
  return { text: `${headText}\n${note}\n${tailText}`, truncated: true }
}

export async function runProcess(options: RunOptions): Promise<RunResult> {
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const headTarget = Math.floor(maxBytes / 2)
  const tailTarget = maxBytes - headTarget
  const capture = new Capture(headTarget, tailTarget, CAPTURE_LIMIT_BYTES)

  return await new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 非 Windows：自成进程组，超时用负 pid 组杀（Git Bash 之外同样有 fork 子孙）
        ...(process.platform === 'win32' ? {} : { detached: true })
      })
    } catch (error) {
      resolve(spawnFailed(error))
      return
    }

    let settled = false
    let timedOut = false
    let streamHeldOpen = false
    let spawnError: Error | null = null
    let graceTimer: NodeJS.Timeout | undefined
    let detachTimer: NodeJS.Timeout | undefined

    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      if (detachTimer !== undefined) clearTimeout(detachTimer)
      const { text, truncated } = capture.result(maxBytes)
      resolve({
        text,
        totalBytes: capture.totalBytes,
        truncated,
        exitCode,
        timedOut,
        streamHeldOpen,
        spawnError
      })
    }

    // 超时计时器：回调用到的 settle / graceTimer 都在闭包里延迟执行，放到后面定义不影响
    const timeoutTimer = setTimeout(() => {
      if (settled) return
      timedOut = true
      try {
        options.killExtra?.(child.pid)
      } catch {
        // 额外杀法失败不挡通用杀法
      }
      killProcessTree(child.pid)
      graceTimer = setTimeout(() => {
        if (settled) return
        // 树没杀干净 / 管道没关：关掉读端收尾（工具不卡死；残留进程的输出去向已断）
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle(null)
      }, KILL_GRACE_MS)
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      capture.push(chunk)
      options.onData?.(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      capture.push(chunk)
      options.onData?.(chunk)
    })

    child.on('error', (error) => {
      spawnError = error
      settle(null)
    })

    child.on('exit', (code) => {
      if (timedOut || settled) return
      // 直接子进程退出了，但 close 还没来：可能只是管道里还有尾巴，也可能是 `&` 起的
      // 后台进程占着写端。给一小段宽限，超了就当"命令已结束"收尾，不再挂到超时。
      detachTimer = setTimeout(() => {
        if (settled) return
        streamHeldOpen = true
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle(code)
      }, DETACHED_GRACE_MS)
    })

    child.on('close', (code) => settle(code))
  })
}

function spawnFailed(error: unknown): RunResult {
  return {
    text: '',
    totalBytes: 0,
    truncated: false,
    exitCode: null,
    timedOut: false,
    streamHeldOpen: false,
    spawnError: error instanceof Error ? error : new Error(String(error))
  }
}

/** 通用杀法：Windows taskkill /T /F；非 Windows 对 detached 进程组发 SIGKILL */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => {})
      killer.unref()
    } catch {
      // taskkill 都不在 PATH 时无计可施：调用方的 killExtra 已尽力
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经死了
    }
  }
}

/** 只计数、按需保留首尾的字节采集器 */
class Capture {
  readonly head: Buffer[] = []
  readonly tail: Buffer[] = []
  headBytes = 0
  tailBytes = 0
  totalBytes = 0

  constructor(
    private readonly headTarget: number,
    private readonly tailTarget: number,
    private readonly limit: number
  ) {}

  push(chunk: Buffer): void {
    const before = this.totalBytes
    this.totalBytes += chunk.length
    if (before >= this.limit) return

    let rest = chunk
    if (this.headBytes < this.headTarget) {
      const take = Math.min(this.headTarget - this.headBytes, rest.length)
      this.head.push(rest.subarray(0, take))
      this.headBytes += take
      rest = rest.subarray(take)
    }
    if (rest.length === 0) return

    this.tail.push(rest)
    this.tailBytes += rest.length
    while (this.tailBytes > this.tailTarget) {
      const first = this.tail[0] as Buffer
      const excess = this.tailBytes - this.tailTarget
      if (first.length <= excess) {
        this.tail.shift()
        this.tailBytes -= first.length
      } else {
        this.tail[0] = first.subarray(excess)
        this.tailBytes -= excess
      }
    }
  }

  /** 全部数据（未超上限）或「头 + 截断说明 + 尾」；头尾解码都收在 UTF-8 字符边界上 */
  result(maxBytes: number): { text: string; truncated: boolean } {
    const truncated = this.totalBytes > maxBytes
    if (!truncated) {
      return { text: Buffer.concat([...this.head, ...this.tail]).toString('utf8'), truncated }
    }
    const headText = new StringDecoder('utf8').write(Buffer.concat(this.head))
    const tailText = decodeFromBoundary(Buffer.concat(this.tail))
    const note = truncationNote(this.totalBytes, this.headBytes, this.tailBytes)
    return { text: `${headText}\n${note}\n${tailText}`, truncated }
  }
}

/** 跳过开头最多 3 个 UTF-8 续字节：从字节流中间起重解码时，不把半个字符吐成 U+FFFD */
function decodeFromBoundary(buffer: Buffer): string {
  let start = 0
  while (start < 3 && start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start++
  }
  return buffer.subarray(start).toString('utf8')
}
