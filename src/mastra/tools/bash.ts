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
 * 超时换成 `[已超时：...]`；输出超 64KB 首尾保留（见 exec.MAX_OUTPUT_BYTES）；默认超时 120s、
 * 上限 600s。cd 到工作区之外、以及跑任意命令本身都允许 —— 这正是「工作区之外」的主通道，
 * 审批兜底。
 */
import { realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { currentShell, SHELL_MISSING, type ResolvedShell } from '../../main/git-bash'
import { formatSeconds, MAX_OUTPUT_BYTES, runProcess, type RunResult } from './exec'
import {
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

export const bashInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      '要执行的 shell 命令（Git Bash 环境写 bash 语法；回落 PowerShell 时写 PowerShell 语法）'
    ),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      '工作目录；相对路径以会话工作区为基准，绝对路径可指向工作区之外（缺省 = 会话工作区）'
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(BASH_MAX_TIMEOUT_MS)
    .optional()
    .describe('超时毫秒（缺省 120000，上限 600000）；超时会终止整个进程树')
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
 * 其余内容（cwd / 超时 / 输出截断 / 审批）两套口径一致。
 */
export function bashToolDescription(shell: ResolvedShell | null): string {
  if (shell === null) {
    return '执行 shell 命令；但这台机器上既没有 Git Bash 也没有 PowerShell，命令无法执行。'
  }
  const tail =
    '返回合并后的输出与退出码。默认工作目录 = 会话工作区，可用 cwd 指定（绝对路径可到工作区' +
    '之外）。默认超时 120 秒（timeout_ms 可调，上限 600 秒），超时会终止整个进程树；输出超过' +
    ' 64KB 时保留首尾。执行前会请求用户批准。'
  if (shell.kind === 'powershell') {
    return (
      '在 Windows PowerShell 里执行 shell 命令（**这台机器没有 Git Bash，已回落 PowerShell**：' +
      '命令请写 PowerShell 语法，不是 bash）。' +
      tail +
      '长驻服务（dev server 等）请用 Start-Process 放到后台，不要前台常驻。'
    )
  }
  return (
    '在 Git Bash 里执行 shell 命令（bash 语法，不是 PowerShell）。' +
    tail +
    '长驻服务（dev server 等）请重定向输出到文件并在末尾加 &，不要前台常驻。'
  )
}

/** 系统指令里那行"当前 shell 是什么、该怎么写"（round 33；按解析结果现算） */
export function shellGuidance(shell: ResolvedShell | null): string {
  if (shell === null) {
    return '- bash 工具当前不可用：这台机器上既没有 Git Bash 也没有 PowerShell，命令跑不起来；需要命令行的任务如实告诉用户。'
  }
  if (shell.kind === 'powershell') {
    return (
      '- bash 工具当前运行的是 Windows PowerShell（这台机器没有 Git Bash，已回落）：命令请写' +
      ' PowerShell 语法（不是 bash），例如 `Get-ChildItem`、`Write-Output`、`Select-String`；' +
      '长驻服务用 Start-Process 起后台。'
    )
  }
  return (
    '- bash 工具当前运行的是 Git Bash：命令请写 bash 语法（不是 PowerShell），长驻服务用 `&` ' +
    '放到后台并重定向输出到文件。'
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
    requireApproval: (input) => needsApproval(ctx, 'bash', input),
    execute: async (input, context) => {
      const shell = resolve()
      if (shell === null) throw new Error(SHELL_MISSING)

      const session = sessionKey(context)
      const cwd = resolveBashCwd(ctx, session, input.cwd)
      const timeoutMs = input.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS

      const result =
        shell.kind === 'git-bash'
          ? await runInGitBash(shell.path, input.command, cwd, timeoutMs)
          : await runInPowerShell(shell.path, input.command, cwd, timeoutMs)

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
      if (result.timedOut) {
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
  timeoutMs: number
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
    maxOutputBytes: MAX_OUTPUT_BYTES,
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
  timeoutMs: number
): Promise<ShellRunResult> {
  const result = await runProcess({
    command: ps,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScript(command)],
    cwd,
    env: { ...process.env },
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES
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
