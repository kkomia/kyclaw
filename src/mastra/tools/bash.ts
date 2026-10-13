/**
 * bash 工具：经解析出来的 shell 执行命令（round28 模块 1；round 33 加 PowerShell 回落）。
 *
 * shell 探测链在 `main/git-bash.ts`（工作台的终端工具也要用同一套），这里 re-export 保持既有
 * 导入路径不变。**Git Bash 优先；没有 Git Bash 的 Windows 回落 PowerShell**（用户口径："系统有
 * 就用，没有就回落"，见 `resolveShell`），所以"装了 Git 才有这个能力"的死路没了。
 *
 * 执行口径按 shell 分两套：
 *   - **Git Bash**：`bash -c '<wrapper>' bash <command>`。wrapper 做三件事：先把 `$$:pgid` 写到
 *     输出第一行（随机 token 前缀，命令猜不到，超时时用它做 MSYS 进程组杀），把 stderr 并进
 *     stdout（`exec 2>&1`，输出保真交错），再 `eval` 命令本体。
 *     - **为什么 -c 而不是 -lc**：本机实测 -lc 每次要跑 /etc/profile（多 ~0.5s，且有把用户
 *       profile 输出混进结果的风险）；-c 下 PATH 里已含 Git 自带的 /mingw64/bin:/usr/bin 与
 *       Windows PATH，git / node / pnpm 都找得到。用户 .bashrc 里的额外 PATH 不生效 ——
 *       Windows 上的 PATH 修改本来就在系统环境里，能继承到。
 *     - **为什么杀 MSYS 进程组**：Git Bash fork 出来的子进程在 Windows 父链上跟 shell 脱钩
 *       （实测 `taskkill /T` 打不到），超时只杀 launcher 会留下占着输出管道的孤儿。包装器报出
 *       `pgid == $$`（非交互 bash 自成一组的实测口径）时对负 pid 组杀，配合 taskkill /T 兜底。
 *   - **PowerShell**：`pwsh|powershell -NoLogo -NoProfile -NonInteractive -Command '<script>'`。
 *     script = UTF-8 输出编码声明 + 用户命令 + `exit $LASTEXITCODE`：
 *     - **为什么先声明输出编码**：不声明时 cmdlet 的输出按系统 ANSI（本机 936）出去，管道里
 *       拿到的就是 GBK 字节，按 UTF-8 解出来是乱码（本机实测：中文 → `d6d0 cec4…`）；
 *       声明后是干净的 UTF-8（实测 `e4b8 ad…`）。
 *     - **为什么 `exit $LASTEXITCODE`**：PowerShell 对原生命令的非零退出码默认不往进程退出码
 *       传（实测 `cmd /c exit 7` 出来是 1），显式 exit 才能把 7 带回来；纯 cmdlet 时该变量为空，
 *       exit 0（实测）。
 *     - 超时不另做进程组杀：PowerShell 的子进程在 Windows 父链上，`taskkill /T /F` 的通用杀法
 *       能覆盖（Git Bash 那套 MSYS 组杀不适用）。
 *
 * 契约：`$ command`（PowerShell 下落 `PS> command`）+ `[cwd: ...]` + 合并输出 + `[退出码 N]`；
 * 超时换成 `[已超时：...]`；用户中止（round 72，停止键）换成 `[已被用户中止：...]`；输出超
 * 32KB 首尾保留（见 `BASH_MAX_OUTPUT_BYTES`，round 71 从 64KB 收到 32KB：上下文是真实成本），
 * 截断说明后面附一句"怎么拿到剩余部分"；默认超时 120s、上限 600s。cd 到工作区之外、以及跑任意
 * 命令本身都允许 —— 这正是「工作区之外」的主通道，审批兜底。
 */
import { realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { currentShell, SHELL_MISSING, type ResolvedShell } from '../../main/git-bash'
import { formatSeconds, runProcess, type RunResult } from './exec'
import {
  approvalSessionOf,
  needsApproval,
  NO_WORKSPACE_REASON,
  sessionKey,
  workspaceRoots,
  type ToolContext
} from './guard'

// 探测链住在 main/git-bash.ts（工作台终端与 git 工具共用同一份）；这里 re-export，
// 既有的 `from './bash'` 导入（git.ts / bash.spec.ts）一字不改。
export {
  defaultBashProbe,
  defaultShellProbe,
  findExecutableOnPath,
  findGitBash,
  findGitOnPath,
  gitBashPath,
  GIT_BASH_MISSING,
  resetGitBashCache,
  resetShellCache,
  resolveShell,
  currentShell,
  SHELL_MISSING,
  type BashProbe,
  type ResolvedShell,
  type ShellProbe
} from '../../main/git-bash'

/** 默认超时（毫秒） */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000
/** 超时上限（毫秒）：600 秒 */
export const BASH_MAX_TIMEOUT_MS = 600_000

/**
 * bash 单条输出的保留上限（字节）：**32KB**（round 71，从 64KB 收下来）。
 *
 * 为什么单给 bash 一档（exec.MAX_OUTPUT_BYTES 仍是 64KB，git / fetch / render-ppt 走那一档）：
 * bash 是最容易吐出巨量文本的一件（RSS / XML / 目录递归 / 构建日志），而一条结果就是一条
 * 上下文成本——实测一轮里两条 64KB 级结果（各 ≈16K token）吃掉了整轮 57% 的上下文。
 * 32KB ≈ 8K token 量级，常规命令的输出仍读得全，巨量输出则退化成"头尾 + 怎么取"。
 * read / grep / glob 是另一套上限（256KB / 100 / 200），不在这一档。
 */
export const BASH_MAX_OUTPUT_BYTES = 32 * 1024

/**
 * 截断说明后面那句"下一步"（round 71）：告诉模型**怎么拿到被省掉的部分**。
 * 只说"已截断"没用——模型会重跑同一条命令再撞一次上限；给出取样手法它才会换手段。
 * 命令名按当前 shell 给（bash 的 head/tail/grep、PowerShell 的 Select-Object/Select-String），
 * 免得在回落 PowerShell 的机器上劝它敲 bash 命令。
 */
export function bashTruncationHint(shell: ResolvedShell): string {
  const sample =
    shell.kind === 'powershell'
      ? '用 Select-Object -First / -Last 取头尾、Select-String 过滤'
      : '用 head / tail / grep 精确取样'
  return (
    '要拿到其余部分：把命令的输出面收窄（更精确的路径或筛选条件、只取需要的字段），' +
    `${sample}，或者把完整输出写进文件再用 read 分段读。`
  )
}

export const bashInputSchema = z.object({
  command: z
    .string()
    .min(1)
    // round 70 瘦身：写哪种语法由本工具的**顶层描述**（按当前解析出的 shell 现算）与系统指令的
    // 运行时快照一起说清，字段这一层再抄一遍只是重复
    .describe('Shell command to run'),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Working directory; defaults to the session workspace, and an absolute path may point outside it'
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(BASH_MAX_TIMEOUT_MS)
    .optional()
    .describe(
      'Timeout in milliseconds; defaults to 120000, maximum 600000. On timeout the whole process tree is terminated'
    )
})

export type BashInput = z.infer<typeof bashInputSchema>

export interface BashToolOptions {
  /** 覆盖 shell 解析（测试注入用；缺省走真实探测 + 缓存） */
  resolveShell?: () => ResolvedShell | null
}

/** 命令回显的前缀：Git Bash 用 `$`（既有口径不变），PowerShell 用 `PS>` */
export function shellPromptMarker(shell: ResolvedShell): string {
  return shell.kind === 'powershell' ? 'PS>' : '$'
}

/**
 * 工具描述（round 33）：按当前解析出来的 shell 给正确口径 —— 不能让模型拿 bash 语法往
 * PowerShell 里灌。`shell === null` = 一个 shell 都没有（极罕见），如实说，省得白试一次。
 * 其余内容（cwd / 超时 / 输出截断 / 审批）两套口径一致；上限按 `BASH_MAX_OUTPUT_BYTES` 现算
 * （不写死数字，改上限只改那一处）。
 */
export function bashToolDescription(shell: ResolvedShell | null): string {
  if (shell === null) {
    return 'Run a shell command. This machine has neither Git Bash nor PowerShell, so commands cannot run.'
  }
  const tail =
    `Returns merged output and exit code; the working directory defaults to the session workspace. Output over ${BASH_MAX_OUTPUT_BYTES / 1024}KB keeps the head and the tail and drops the middle, and the result says how many bytes were dropped. ` +
    'Send independent commands as separate bash calls in the same turn instead of chaining them; join dependent steps with `&&` (`;` only when an earlier failure does not matter), never with a newline. ' +
    'Confirm the parent directory before writing into it, do not `sleep`-poll a service you started in the background, and never run an interactive command, which hangs until the timeout.'
  if (shell.kind === 'powershell') {
    return (
      'Run a shell command in Windows PowerShell, since this machine has no Git Bash and falls back to it, so write PowerShell syntax rather than bash. ' +
      tail +
      ' Run a long-lived service in the background with Start-Process.'
    )
  }
  return (
    'Run a shell command in Git Bash, using bash syntax rather than PowerShell. ' +
    tail +
    ' Start a long-lived service by redirecting output to a file and appending &.'
  )
}

/**
 * 系统指令快照里的"当前 shell 是什么、该怎么写"（round 33；按解析结果现算）。
 *
 * 两处平台陷阱逐条编码（round 69，DSH 的做法）：
 *   - PowerShell 回落时，**含空格的路径**必须用 `&` 调用运算符或逐个加引号（`& "C:\Program Files\x.exe"`）——
 *     这是 PowerShell 与 bash / cmd 最容易踩混的一处，光说"写 PowerShell 语法"指不到具体位置；
 *   - Git Bash 侧给**路径写法**（正斜杠；含空格或中文时整体加引号），同样只写这条环境真会遇到的。
 */
export function shellGuidance(shell: ResolvedShell | null): string {
  if (shell === null) {
    return '- bash is unavailable: this machine has neither Git Bash nor PowerShell, so commands cannot run; say so when a task needs a command line.'
  }
  if (shell.kind === 'powershell') {
    return (
      '- bash runs Windows PowerShell, since this machine has no Git Bash and falls back to it: write PowerShell syntax, ' +
      'not bash (`Get-ChildItem`, `Select-String`). Quote a path that contains spaces, or invoke it with the `&` operator: ' +
      '`& "C:\\Program Files\\x.exe" -Arg`. Start a long-lived service with Start-Process.'
    )
  }
  return (
    '- bash runs Git Bash: write bash syntax, not PowerShell; background a long-lived service with `&` and redirect its output ' +
    'to a file; use forward slashes in paths, and quote any path containing spaces or non-ASCII characters.'
  )
}

export async function createBashTool(
  ctx: ToolContext,
  options: BashToolOptions = {}
): Promise<Tool<BashInput, string>> {
  const { createTool } = await import('@mastra/core/tools')
  const resolve = options.resolveShell ?? currentShell
  // 描述在创建时按当时的 shell 定（agent 的 tools 是每轮现取的函数形态，所以装 Git / 换环境
  // 下一轮就反映出来；见 agents/kyclaw.ts 的装配）
  const description = bashToolDescription(resolve())

  return createTool({
    id: 'bash',
    description,
    inputSchema: bashInputSchema,
    outputSchema: z.string(),
    // 审批按会话判（round 46）：回调第二参带得到线程 id → 没给 cwd 时按会话根判区，
    // 见 guard.approvalSessionOf 与 guard.ts 头注（round 75 起按"目标落在哪个区"分档，
    // 旧的"无目标一律全免"那一档已经没有了）
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'bash', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const shell = resolve()
      if (shell === null) throw new Error(SHELL_MISSING)

      const session = sessionKey(context)
      const cwd = resolveBashCwd(ctx, session, input.cwd)
      const timeoutMs = input.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS
      // 截断说明里那句"下一步"按当前 shell 给（两套 shell 的取样命令名不一样）
      const hint = bashTruncationHint(shell)
      // 用户点停止（round 72）：mastra 把请求的 abortSignal 交给工具 execute，一路传给
      // runProcess —— 收到就杀掉整棵命令树，不再只停 UI
      const signal = context.abortSignal

      const result =
        shell.kind === 'git-bash'
          ? await runInGitBash(shell.path, input.command, cwd, timeoutMs, hint, signal)
          : await runInPowerShell(shell.path, input.command, cwd, timeoutMs, hint, signal)

      if (result.spawnError !== null) {
        throw new Error(`bash 启动失败：${result.spawnError.message}`)
      }

      // CRLF 归一（PowerShell 的管道输出是 \r\n；统一成 LF，模型看到的就是普通换行）
      const body = result.body.replace(/\r\n/g, '\n').replace(/[\r\n]+$/, '')
      const lines = [
        `${shellPromptMarker(shell)} ${input.command}`,
        `[cwd: ${cwd}]`,
        '',
        body === '' ? '（无输出）' : body,
        ''
      ]
      if (result.aborted) {
        // 用户中止：与"裸退出码=被终止"同一口径，但明说原因 —— 模型不该把它读成命令自己失败
        lines.push(`[已被用户中止：命令已终止（退出码 ${result.exitCode ?? '未知'}）]`)
      } else if (result.timedOut) {
        lines.push(`[已超时：超过 ${formatSeconds(timeoutMs)} 秒，已终止进程]`)
      } else if (result.streamHeldOpen) {
        lines.push('[命令已结束；输出管道仍被后台进程占用，后续输出不会带回]')
      } else {
        lines.push(`[退出码 ${result.exitCode ?? '未知'}]`)
      }
      return lines.join('\n')
    }
  })
}

/** 环境：继承应用进程的环境；LANG/LC_ALL 都没设时补 LANG=C.UTF-8（MSYS 输出保持 UTF-8） */
function bashEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (env.LANG === undefined && env.LC_ALL === undefined) env.LANG = 'C.UTF-8'
  return env
}

/** 一次执行的结果：原始结果 + 已经剥掉 shell 私有前缀的正文 */
interface ShellRunResult extends RunResult {
  body: string
}

/**
 * Git Bash 执行：包装器（合并 stderr + 报 `$$:pgid` 握手行）+ MSYS 进程组杀。
 * 口径与 round28 一字不差（见文件头注）——这里只是把那段代码收进函数。
 */
async function runInGitBash(
  bash: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  truncationHint: string,
  signal?: AbortSignal
): Promise<ShellRunResult> {
  const token = randomBytes(6).toString('hex')
  const marker = `kyclaw-pid-${token}:`
  // 包装器：合并 stderr → 报 $$ 与 pgid（第一行）→ exec 前清空位置参数 → eval 命令本体
  const wrapper =
    `cmd="$1"; set --; exec 2>&1; ` +
    `printf '${marker}%s:%s\\n' "$$" "$(cat /proc/$$/pgid 2>/dev/null)"; ` +
    `eval "$cmd"`

  let handshake: { pid: string; pgid: string } | null = null
  let seen = ''
  let parseDone = false

  const result = await runProcess({
    command: bash,
    args: ['-c', wrapper, 'bash', command],
    cwd,
    env: bashEnv(),
    timeoutMs,
    maxOutputBytes: BASH_MAX_OUTPUT_BYTES,
    truncationHint,
    signal,
    onData: (chunk) => {
      // 握手行只在开头：解析出结果、或第一行明显超长（bash 没跑到 printf）就停手
      if (parseDone || handshake !== null) return
      seen += chunk.toString('utf8')
      const newline = seen.indexOf('\n')
      if (newline === -1) {
        if (seen.length > 4096) parseDone = true
        return
      }
      handshake = parseHandshake(seen.slice(0, newline), marker)
      parseDone = true
    },
    killExtra: () => {
      // 没拿到握手行（bash 还没跑到 printf 就被杀）时只剩 taskkill 兜底，不做别的
      if (process.platform === 'win32' && handshake !== null) killMsysTree(bash, handshake)
    }
  })

  return { ...result, body: stripHandshake(result.text, marker) }
}

/** PowerShell 脚本：UTF-8 输出编码 + 用户命令 + 透传原生命令退出码（机理见文件头注） */
export function powershellScript(command: string): string {
  return (
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n' +
    `${command}\n` +
    'exit $LASTEXITCODE'
  )
}

/** PowerShell 执行：`-NoLogo -NoProfile -NonInteractive -Command <script>`；超时走 taskkill /T */
async function runInPowerShell(
  ps: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  truncationHint: string,
  signal?: AbortSignal
): Promise<ShellRunResult> {
  const result = await runProcess({
    command: ps,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScript(command)],
    cwd,
    env: { ...process.env },
    timeoutMs,
    maxOutputBytes: BASH_MAX_OUTPUT_BYTES,
    truncationHint,
    signal
  })
  return { ...result, body: result.text }
}

/** 解析包装器写出的第一行：`<marker><msys pid>:<pgid>` */
export function parseHandshake(line: string, marker: string): { pid: string; pgid: string } | null {
  if (!line.startsWith(marker)) return null
  const [pid, pgid] = line.slice(marker.length).split(':')
  if (pid === undefined || !/^\d+$/.test(pid)) return null
  return { pid, pgid: pgid !== undefined && /^\d+$/.test(pgid) ? pgid : '' }
}

/** 去掉输出第一行的握手行（命令失败到没跑起来时可能没有，交给 parse 判定） */
export function stripHandshake(text: string, marker: string): string {
  if (!text.startsWith(marker)) return text
  const newline = text.indexOf('\n')
  return newline === -1 ? '' : text.slice(newline + 1)
}

/**
 * MSYS 进程树杀：`kill -9 -<pgid>`（组杀，覆盖 fork 出来的子孙）+ `kill -9 <pid>`。
 * 只在 `pgid === pid`（该 bash 自成一组的实测口径）时做组杀 —— 组号拿不准时不赌，
 * 让 taskkill /T 兜底。信号用 argv 传给 helper，不做字符串拼接。
 */
function killMsysTree(bash: string, handshake: { pid: string; pgid: string }): void {
  if (handshake.pgid !== handshake.pid) {
    spawnSync(bash, ['-c', 'kill -9 "$1" 2>/dev/null; exit 0', 'bash', handshake.pid], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000
    })
    return
  }
  spawnSync(
    bash,
    [
      '-c',
      'kill -9 -"$2" 2>/dev/null; kill -9 "$1" 2>/dev/null; exit 0',
      'bash',
      handshake.pid,
      handshake.pgid
    ],
    { windowsHide: true, stdio: 'ignore', timeout: 10_000 }
  )
}

/**
 * cwd 解析：
 *   - 缺省 = 会话工作区（恰好一个；多个工作区要显式给 cwd —— 与 scanRoot 同口径）；
 *   - 相对路径以会话工作区为基准，过引擎（`..` 逃逸会被拒；工作区之外的目录请用绝对路径）；
 *   - 绝对路径不设边界（bash 就是「工作区之外」的主通道，审批兜底），但必须存在且是目录。
 */
export function resolveBashCwd(ctx: ToolContext, session: string, requested?: string): string {
  const cwd = requested?.trim()

  if (cwd !== undefined && cwd !== '') {
    if (isAbsolute(cwd)) return canonicalDirectory(cwd)
    const roots = workspaceRoots(ctx, session)
    if (roots.length === 0) throw new Error(NO_WORKSPACE_REASON)
    if (roots.length > 1) {
      throw new Error(
        `有多个授权工作区，cwd 请用绝对路径指定：${roots.map((workspace) => workspace.path).join('、')}`
      )
    }
    const resolved = resolveInsideWorkspace(roots[0].path, cwd)
    if (!resolved.ok) {
      throw new Error(`cwd 不在工作区内（${resolved.reason}）：工作区之外的目录请用绝对路径`)
    }
    return canonicalDirectory(resolved.abs)
  }

  const roots = workspaceRoots(ctx, session)
  if (roots.length === 0) throw new Error(NO_WORKSPACE_REASON)
  if (roots.length > 1) {
    throw new Error(
      `有多个授权工作区，请用 cwd 指定在哪个里运行：${roots.map((workspace) => workspace.path).join('、')}`
    )
  }
  const resolved = resolveInsideWorkspace(roots[0].path, '.')
  if (!resolved.ok) throw new Error(`工作区不可用：${resolved.reason}`)
  return canonicalDirectory(resolved.abs)
}

function canonicalDirectory(path: string): string {
  try {
    const real = realpathSync.native(path)
    if (!statSync(real).isDirectory()) throw new Error('not a directory')
    return real
  } catch {
    throw new Error(`cwd 不存在或不是目录：${path}`)
  }
}
