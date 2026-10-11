/**
 * Git Bash / git 可执行文件的探测链（**共享件**：bash 工具、git 工具、工作台终端三处用同一套口径）。
 *
 * 本模块是从 `mastra/tools/bash.ts` 提取出来的（工作台的「终端」工具要起真 PTY，不能 import
 * 一个挂着 @mastra/core 的工具模块）——口径与行为一字未改，bash.ts 继续 re-export 这些名字。
 *
 * 探测顺序（成功结果缓存）：
 *   1. 环境变量 `KYCLAW_GIT_BASH`（显式指定，给自定义安装位留的口子）；
 *   2. Windows 常见安装位：`%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\...`、
 *      `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`；
 *   3. PATH 上的 `git` 推导：`<git 所在目录>\bash.exe`、`..\bin\bash.exe`、`..\..\bin\bash.exe`、
 *      `..\..\..\bin\bash.exe` —— 覆盖 `<root>\cmd\git.exe`、`<root>\mingw64\bin\git.exe`、
 *      `<root>\usr\bin\git.exe` 三种 Git for Windows 布局（本机的 D:\Git 走这条）；
 *   4. 非 Windows：`/bin/bash`。
 *
 * round 33 **回落口径**（用户口径："系统有就用，没有就回落"，对齐 Claude Code）：
 * `findGitBash`（纯 Git Bash 探测）语义不变；调用方改用 `resolveShell()` —— Git Bash 优先，
 * 找不到时在 Windows 上回落 PowerShell（PATH 上 `pwsh.exe` 优先，否则 `%SystemRoot%\System32\
 * WindowsPowerShell\v1.0\powershell.exe`；Windows 一定有，所以那条"请装 Git"的死路没了）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
 * 解析 Git Bash 的可执行文件路径；找不到回 null（**不回落其它 shell** —— 回落口径在
 * `resolveShell`，调用方一般用它）。探测链见文件头注；成功结果缓存（用户现装 Git 的话，
 * 重启应用后生效）。
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

/**
 * 解析出来的执行 shell（round 33）：调用方按 kind 给正确的执行口径（argv、输出编码、
 * 进程组杀、工具描述与系统指令的措辞）。
 */
export type ResolvedShell =
  { kind: 'git-bash'; path: string } | { kind: 'powershell'; path: string }

/** 探测结果（round 33）：Git Bash 与 PowerShell 的路径都可以注入假件 */
export interface ShellProbe extends BashProbe {
  /** PATH 上 pwsh.exe 的完整路径（找不到回 null） */
  findPwsh(): string | null
}

export function defaultShellProbe(): ShellProbe {
  return {
    ...defaultBashProbe(),
    findPwsh: () => findExecutableOnPath(process.env.PATH, process.platform, 'pwsh.exe')
  }
}

/**
 * shell 解析（round 33，用户口径："系统有就用，没有就回落"）：
 *   - **Git Bash 优先**：探测链与从前一字不差（`findGitBash`）；
 *   - Windows 上找不到 Git Bash 就回落 PowerShell：PATH 上 `pwsh.exe`（PowerShell 7）优先，
 *     否则 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（Windows 自带）；
 *   - 非 Windows 没有 Git Bash 就回 null（没有等价的"一定有"的回落对象）。
 * 找不到任何 shell 时调用方给 `SHELL_MISSING`（已经是极罕见的死路）。
 */
export function resolveShell(probe: Partial<ShellProbe> = {}): ResolvedShell | null {
  const { platform, env, exists, findGit, findPwsh } = { ...defaultShellProbe(), ...probe }

  const bash = findGitBash({ platform, env, exists, findGit })
  if (bash !== null) return { kind: 'git-bash', path: bash }
  if (platform !== 'win32') return null

  const pwsh = findPwsh()
  if (pwsh !== null) return { kind: 'powershell', path: pwsh }

  // Windows 一定有 Windows PowerShell：SystemRoot 缺失时用系统盘兜底
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const legacy = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (exists(legacy)) return { kind: 'powershell', path: legacy }
  return null
}

/** 探测结果的缓存（只缓存成功；失败每次重探 —— 几次 existsSync，可忽略） */
let cachedShell: ResolvedShell | null = null

/** 本次运行使用的 shell（探测结果缓存版；调用方一般用它，而不是每次 resolveShell） */
export function currentShell(probe: Partial<ShellProbe> = {}): ResolvedShell | null {
  cachedShell ??= resolveShell(probe)
  return cachedShell
}

/** 测试用：清掉探测缓存 */
export function resetShellCache(): void {
  cachedShell = null
}

export const GIT_BASH_MISSING =
  '找不到 Git Bash（未检测到 Git for Windows）：请安装 Git（https://git-scm.com/download/win）后重试；' +
  '自定义安装位置可以用环境变量 KYCLAW_GIT_BASH 指向 bash.exe。'

export const SHELL_MISSING =
  '找不到可用的 shell：这台机器上既没有 Git Bash，也没有 PowerShell。' +
  '请安装 Git（https://git-scm.com/download/win）后重试，或用 KYCLAW_GIT_BASH 指向 bash.exe。'

export const GIT_MISSING =
  '找不到 git 可执行文件：请安装 Git for Windows 并确保 git 在 PATH 里（或把 Git 装到默认位置）。'

/** PATH 扫描：Windows 用 `;` 分隔（不能按 `:` 切，盘符里就有冒号）；exists 可注入（测试） */
export function findGitOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync
): string | null {
  const exe = platform === 'win32' ? 'git.exe' : 'git'
  return findExecutableOnPath(pathValue, platform, exe, exists)
}

/** 在 PATH 上找一个可执行文件（名称含扩展名；Windows 用 `;` 分隔，其余用 `:`） */
export function findExecutableOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  executable: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  if (pathValue === undefined) return null
  const separator = platform === 'win32' ? ';' : ':'
  for (const raw of pathValue.split(separator)) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (dir === '') continue
    const candidate = join(dir, executable)
    if (exists(candidate)) return candidate
  }
  return null
}

/** git 可执行文件探测的可注入面（测试用假件打探测链） */
export interface GitProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
}

/**
 * git 可执行文件解析：`KYCLAW_GIT` → PATH 扫描 → Git Bash 安装位推导；找不到回 null
 * （调用方给中文错误）。推导时把 findGit 置空，避免与 findGitBash 的推导互相递归。
 */
export function findGit(probe: Partial<GitProbe> = {}): string | null {
  const platform = probe.platform ?? process.platform
  const env = probe.env ?? process.env
  const exists = probe.exists ?? existsSync

  const explicit = env.KYCLAW_GIT?.trim()
  if (explicit !== undefined && explicit !== '' && exists(explicit)) return explicit

  const fromPath = findGitOnPath(env.PATH, platform, exists)
  if (fromPath !== null) return fromPath

  const bash = findGitBash({ platform, env, exists, findGit: () => null })
  if (bash === null) return null
  const dir = dirname(bash)
  const exe = platform === 'win32' ? 'git.exe' : 'git'
  const candidates = [
    join(dir, exe),
    join(dir, '..', 'cmd', exe),
    join(dir, '..', 'mingw64', 'bin', exe),
    join(dir, '..', 'usr', 'bin', exe)
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/** 探测结果的缓存（只缓存成功；失败每次重探） */
let cachedGit: string | null = null

export function gitExecutable(probe: Partial<GitProbe> = {}): string | null {
  cachedGit ??= findGit(probe)
  return cachedGit
}

/** 测试用：清掉探测缓存 */
export function resetGitExecutableCache(): void {
  cachedGit = null
}
