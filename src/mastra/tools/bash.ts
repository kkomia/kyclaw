/**
 * bash 工具：经 **Git Bash** 执行 shell 命令（round28 模块 1；用户口径：AI 用 PowerShell 不顺手）。
 *
 * Git Bash 解析（探测顺序，成功结果缓存；不做静默回落 —— 找不到 cmd/PowerShell 的替代品，
 * 直接给中文错误让用户装 Git）：
 *   1. 环境变量 `KYCLAW_GIT_BASH`（显式指定，给自定义安装位留的口子）；
 *   2. Windows 常见安装位：`%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\...`、
 *      `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`；
 *   3. PATH 上的 `git` 推导：`<git 所在目录>\bash.exe`、`..\bin\bash.exe`、`..\..\bin\bash.exe`、
 *      `..\..\..\bin\bash.exe` —— 覆盖 `<root>\cmd\git.exe`、`<root>\mingw64\bin\git.exe`、
 *      `<root>\usr\bin\git.exe` 三种 Git for Windows 布局（本机的 D:\Git 走这条）；
 *   4. 非 Windows：`/bin/bash`。
 *
 * 执行：`bash -c '<wrapper>' bash <command>`。wrapper 做三件事：先把 `$$:pgid` 写到输出第一行
 * （随机 token 前缀，命令猜不到，超时时用它做 MSYS 进程组杀），把 stderr 并进 stdout
 * （`exec 2>&1`，输出保真交错），再 `eval` 命令本体。
 *   - **为什么 -c 而不是 -lc**：本机实测 -lc 每次要跑 /etc/profile（多 ~0.5s，且有把用户
 *     profile 输出混进结果的风险）；-c 下 PATH 里已含 Git 自带的 /mingw64/bin:/usr/bin 与
 *     Windows PATH，git / node / pnpm 都找得到。用户 .bashrc 里的额外 PATH 不生效 ——
 *     Windows 上的 PATH 修改本来就在系统环境里，能继承到。
 *   - **为什么杀 MSYS 进程组**：Git Bash fork 出来的子进程在 Windows 父链上跟 shell 脱钩
 *     （实测 `taskkill /T` 打不到），超时只杀 launcher 会留下占着输出管道的孤儿。包装器报出
 *     `pgid == $$`（非交互 bash 自成一组的实测口径）时对负 pid 组杀，配合 taskkill /T 兜底。
 *
 * 契约：`$ command` + `[cwd: ...]` + 合并输出 + `[退出码 N]`；超时换成 `[已超时：...]`；
 * 输出超 64KB 首尾保留（见 exec.MAX_OUTPUT_BYTES）；默认超时 120s、上限 600s。
 * cd 到工作区之外、以及跑任意命令本身都允许 —— 这正是「工作区之外」的主通道，审批兜底。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { formatSeconds, MAX_OUTPUT_BYTES, runProcess } from './exec'
import {
  needsApproval,
  NO_WORKSPACE_REASON,
  sessionKey,
  workspaceRoots,
  type ToolContext
} from './guard'

/** 默认超时（毫秒） */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000
/** 超时上限（毫秒）：600 秒 */
export const BASH_MAX_TIMEOUT_MS = 600_000

export const bashInputSchema = z.object({
  command: z.string().min(1).describe('要执行的 shell 命令（bash 语法）'),
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

/** Git Bash 探测的可注入面（缺省全部走真实系统；测试用假件打探测链） */
export interface BashProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
  /** PATH 上 git 可执行文件的完整路径（找不到回 null） */
  findGit(): string | null
}

export function defaultBashProbe(): BashProbe {
  return {
    platform: process.platform,
    env: process.env,
    exists: (path) => existsSync(path),
    findGit: () => findGitOnPath(process.env.PATH, process.platform)
  }
}

/**
 * 解析 Git Bash 的可执行文件路径；找不到回 null（调用方给中文错误，不回落其它 shell）。
 * 探测链见文件头注；成功结果缓存（用户现装 Git 的话，重启应用后生效）。
 */
export function findGitBash(probe: Partial<BashProbe> = {}): string | null {
  const { platform, env, exists, findGit } = { ...defaultBashProbe(), ...probe }
  const exe = platform === 'win32' ? 'bash.exe' : 'bash'

  const explicit = env.KYCLAW_GIT_BASH?.trim()
  if (explicit !== undefined && explicit !== '' && exists(explicit)) return explicit

  if (platform === 'win32') {
    const roots = [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'Programs')
    ]
    for (const root of roots) {
      if (root === undefined || root === '') continue
      const candidate = join(root, 'Git', 'bin', exe)
      if (exists(candidate)) return candidate
    }
  } else if (exists('/bin/bash')) {
    return '/bin/bash'
  }

  // PATH 上的 git → 推导同安装的 bash（Git for Windows 的几种 bin 布局）
  const git = findGit()
  if (git !== null) {
    const dir = dirname(git)
    const candidates = [
      join(dir, exe),
      join(dir, '..', 'bin', exe),
      join(dir, '..', '..', 'bin', exe),
      join(dir, '..', '..', '..', 'bin', exe)
    ]
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate
    }
  }

  return null
}

/** 探测结果的缓存（只缓存成功；失败每次重探 —— 几次 existsSync，可忽略） */
let cachedBash: string | null = null

export function gitBashPath(probe: Partial<BashProbe> = {}): string | null {
  cachedBash ??= findGitBash(probe)
  return cachedBash
}

/** 测试用：清掉探测缓存 */
export function resetGitBashCache(): void {
  cachedBash = null
}

export const GIT_BASH_MISSING =
  '找不到 Git Bash（未检测到 Git for Windows）：请安装 Git（https://git-scm.com/download/win）后重试；' +
  '自定义安装位置可以用环境变量 KYCLAW_GIT_BASH 指向 bash.exe。'

/** PATH 扫描：Windows 用 `;` 分隔（不能按 `:` 切，盘符里就有冒号）；exists 可注入（测试） */
export function findGitOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync
): string | null {
  if (pathValue === undefined) return null
  const exe = platform === 'win32' ? 'git.exe' : 'git'
  const separator = platform === 'win32' ? ';' : ':'
  for (const raw of pathValue.split(separator)) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (dir === '') continue
    const candidate = join(dir, exe)
    if (exists(candidate)) return candidate
  }
  return null
}

export interface BashToolOptions {
  /** 覆盖 Git Bash 解析（测试注入用；缺省走真实探测 + 缓存） */
  resolveBash?: () => string | null
}

export async function createBashTool(
  ctx: ToolContext,
  options: BashToolOptions = {}
): Promise<Tool<BashInput, string>> {
  const { createTool } = await import('@mastra/core/tools')
  const resolveBash = options.resolveBash ?? gitBashPath

  return createTool({
    id: 'bash',
    description:
      '在 Git Bash 里执行 shell 命令（bash 语法，不是 PowerShell），返回合并后的输出与退出码。' +
      '默认工作目录 = 会话工作区，可用 cwd 指定（绝对路径可到工作区之外）。默认超时 120 秒' +
      '（timeout_ms 可调，上限 600 秒），超时会终止整个进程树；输出超过 64KB 时保留首尾。' +
      '执行前会请求用户批准。长驻服务（dev server 等）请重定向输出到文件并在末尾加 &，不要前台常驻。',
    inputSchema: bashInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'bash', input),
    execute: async (input, context) => {
      const bash = resolveBash()
      if (bash === null) throw new Error(GIT_BASH_MISSING)

      const session = sessionKey(context)
      const cwd = resolveBashCwd(ctx, session, input.cwd)
      const timeoutMs = input.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS

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
        args: ['-c', wrapper, 'bash', input.command],
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

      if (result.spawnError !== null) {
        throw new Error(`bash 启动失败：${result.spawnError.message}`)
      }

      const body = stripHandshake(result.text, marker).replace(/[\r\n]+$/, '')
      const lines = [
        `$ ${input.command}`,
        `[cwd: ${cwd}]`,
        '',
        body === '' ? '（无输出）' : body,
        ''
      ]
      if (result.timedOut) {
        lines.push(`[已超时：超过 ${formatSeconds(timeoutMs)} 秒，已终止进程]`)
      } else if (result.streamHeldOpen) {
        lines.push('[命令已结束；输出管道仍被后台进程占用（& 起的长驻进程），后续输出不会带回]')
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
