/**
 * git 工具（round28 模块 1）：五个薄封装 —— status / diff / log 只读，add / commit 写类（默认问）。
 *
 * 执行：直接 spawn git 可执行文件（argv 数组，不经 shell —— 提交信息/路径没有注入面），
 * `git -C <仓库目录>` 钉住仓库；仓库目录走 guard.scanRoot（工作区内、缺省 = 会话工作区）。
 * git 可执行文件的解析：PATH 扫描 → 由 Git Bash 安装位推导（<bash>\git.exe、..\cmd\git.exe、
 * ..\mingw64\bin\git.exe、..\usr\bin\git.exe），找不到时给中文错误（提示装 Git）。
 *
 * 契约与取舍：
 *   - 非零退出（不在仓库里、nothing to commit、无提交历史…）**不抛错**：git 自己的输出就是
 *     最好的解释，原样带回并附退出码；只有 spawn 失败才抛，超时/挂后台只加标注。
 *   - 输出超过 64KB 首尾保留（exec.MAX_OUTPUT_BYTES）；单条命令超时 60s 后杀进程树。
 *   - `core.quotepath=false`：中文文件名在 status/log 里不转义成 \344\270\255。
 *   - **v1 明确不做 push**（远程写）：远程交互面（凭据、冲突策略）不在本轮契约里。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { findGitOnPath, findGitBash } from './bash'
import { formatSeconds, runProcess, type RunResult } from './exec'
import {
  needsApproval,
  scanRoot,
  sessionKey,
  statOrNull,
  type ResolvedTarget,
  type ToolContext
} from './guard'

/** 单次 git 命令的超时（毫秒）：提交钩子/大 diff 也够用 */
export const GIT_TIMEOUT_MS = 60_000

/** git 提交历史的条数上限 */
export const GIT_LOG_MAX = 100

export const GIT_MISSING =
  '找不到 git 可执行文件：请安装 Git for Windows 并确保 git 在 PATH 里（或把 Git 装到默认位置）。'

const repoSchema = z
  .string()
  .min(1)
  .optional()
  .describe('仓库所在目录（工作区内）；缺省 = 会话工作区（有多个工作区时必须给）')

export const gitStatusInputSchema = z.object({ path: repoSchema })
export const gitDiffInputSchema = z.object({
  path: repoSchema,
  staged: z.boolean().optional().describe('true = 看已暂存的改动（git diff --staged）'),
  file: z.string().min(1).optional().describe('只看这个路径的改动（相对仓库）')
})
export const gitLogInputSchema = z.object({
  path: repoSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(GIT_LOG_MAX)
    .optional()
    .describe(`最多显示多少条提交（缺省 20，上限 ${GIT_LOG_MAX}）`)
})
export const gitAddInputSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe('要加入暂存区的路径（相对仓库；用 "." 表示全部）'),
  path: repoSchema
})
export const gitCommitInputSchema = z.object({
  message: z.string().min(1).describe('提交信息'),
  path: repoSchema
})

export type GitStatusInput = z.infer<typeof gitStatusInputSchema>
export type GitDiffInput = z.infer<typeof gitDiffInputSchema>
export type GitLogInput = z.infer<typeof gitLogInputSchema>
export type GitAddInput = z.infer<typeof gitAddInputSchema>
export type GitCommitInput = z.infer<typeof gitCommitInputSchema>

/** 五件套的显式类型：异质工具表用 Record<string, Tool> 会因 execute 逆变编译不过 */
export interface GitToolset {
  git_status: Tool<GitStatusInput, string>
  git_diff: Tool<GitDiffInput, string>
  git_log: Tool<GitLogInput, string>
  git_add: Tool<GitAddInput, string>
  git_commit: Tool<GitCommitInput, string>
}

/** git 可执行文件探测的可注入面（测试用假件打探测链） */
export interface GitProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
}

/**
 * git 可执行文件解析：PATH 扫描 → Git Bash 安装位推导；找不到回 null（调用方给中文错误）。
 * 推导时把 findGit 置空，避免与 findGitBash 的推导互相递归。
 */
export function findGit(probe: Partial<GitProbe> = {}): string | null {
  const platform = probe.platform ?? process.platform
  const env = probe.env ?? process.env
  const exists = probe.exists ?? existsSync

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

export interface GitToolOptions {
  /** 覆盖 git 可执行文件解析（测试注入用；缺省走真实探测） */
  resolveGit?: () => string | null
  /** 单次命令超时（毫秒），缺省 GIT_TIMEOUT_MS */
  timeoutMs?: number
}

export async function createGitTools(
  ctx: ToolContext,
  options: GitToolOptions = {}
): Promise<GitToolset> {
  const { createTool } = await import('@mastra/core/tools')
  const resolveGit = options.resolveGit ?? gitExecutable
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS

  const gitStatus = createTool({
    id: 'git_status',
    description:
      '查看工作区 git 仓库的短格式状态（当前分支 + 变更清单，只读）。仓库目录缺省 = 会话工作区。',
    inputSchema: gitStatusInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'git_status', input),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      return await runGitCommand(resolveGit, timeoutMs, repo.abs, [
        '-c',
        'core.quotepath=false',
        'status',
        '--short',
        '--branch'
      ])
    }
  })

  const gitDiff = createTool({
    id: 'git_diff',
    description: '查看工作区 git 仓库的改动 diff（缺省未暂存；staged=true 看已暂存；只读）。',
    inputSchema: gitDiffInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'git_diff', input),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      const args = [
        '-c',
        'core.quotepath=false',
        'diff',
        ...(input.staged === true ? ['--staged'] : [])
      ]
      if (input.file !== undefined && input.file.trim() !== '') {
        args.push('--', resolveSpec(repo, input.file))
      }
      return await runGitCommand(resolveGit, timeoutMs, repo.abs, args)
    }
  })

  const gitLog = createTool({
    id: 'git_log',
    description: '查看工作区 git 仓库的提交历史（--oneline，缺省 20 条，只读）。',
    inputSchema: gitLogInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'git_log', input),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      return await runGitCommand(resolveGit, timeoutMs, repo.abs, [
        '-c',
        'core.quotepath=false',
        'log',
        '--oneline',
        '-n',
        String(input.limit ?? 20)
      ])
    }
  })

  const gitAdd = createTool({
    id: 'git_add',
    description:
      '把工作区 git 仓库里的文件加入暂存区（paths 必填，如 ["."] 或 ["src/index.ts"]；' +
      '执行前会请求用户批准）。',
    inputSchema: gitAddInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'git_add', input),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      const specs = input.paths.map((spec) => resolveSpec(repo, spec))
      return await runGitCommand(
        resolveGit,
        timeoutMs,
        repo.abs,
        ['add', '--', ...specs],
        () => `已暂存：${input.paths.join('、')}`
      )
    }
  })

  const gitCommit = createTool({
    id: 'git_commit',
    description:
      '提交已暂存的改动（message 必填；执行前会请求用户批准）。先 git_add 再 commit；' +
      '本工具不 push（需要推到远端请让用户自己做）。',
    inputSchema: gitCommitInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'git_commit', input),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      return await runGitCommand(resolveGit, timeoutMs, repo.abs, ['commit', '-m', input.message])
    }
  })

  return {
    git_status: gitStatus,
    git_diff: gitDiff,
    git_log: gitLog,
    git_add: gitAdd,
    git_commit: gitCommit
  }
}

/** 仓库目录：scanRoot（工作区内 / 缺省会话工作区）+ 必须是目录 */
async function gitRepo(
  ctx: ToolContext,
  session: string,
  path: string | undefined
): Promise<ResolvedTarget> {
  const base = scanRoot(ctx, path, session)
  const stats = await statOrNull(ctx, base.abs)
  if (stats === null || !stats.isDirectory()) {
    throw new Error(`git 失败：${path ?? base.abs} 不是目录`)
  }
  return base
}

/** 把模型给的相对/绝对路径解析成仓库内的绝对路径（fail closed） */
function resolveSpec(repo: ResolvedTarget, spec: string): string {
  const resolved = resolveInsideWorkspace(repo.abs, spec)
  if (!resolved.ok) throw new Error(`git 失败：路径不在仓库内（${spec}）：${resolved.reason}`)
  return resolved.abs
}

async function runGitCommand(
  resolveGit: () => string | null,
  timeoutMs: number,
  repoAbs: string,
  args: string[],
  receipt?: () => string
): Promise<string> {
  const git = resolveGit()
  if (git === null) throw new Error(GIT_MISSING)

  const result = await runProcess({
    command: git,
    args: ['-C', repoAbs, ...args],
    cwd: repoAbs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs
  })
  if (result.spawnError !== null) throw new Error(`git 启动失败：${result.spawnError.message}`)
  return renderGitResult(result, timeoutMs, receipt?.())
}

/** 结果渲染：输出 + 退出码（非零不抛错 —— git 的输出就是解释）；超时/挂后台换成说明 */
export function renderGitResult(result: RunResult, timeoutMs: number, receipt?: string): string {
  const body = result.text.replace(/[\r\n]+$/, '')
  const head = receipt !== undefined && result.exitCode === 0 ? receipt : ''
  const content = [head, body].filter((part) => part !== '').join('\n\n')

  const lines = [content === '' ? '（无输出）' : content, '']
  if (result.timedOut) {
    lines.push(`[已超时：超过 ${formatSeconds(timeoutMs)} 秒，已终止进程]`)
  } else if (result.streamHeldOpen) {
    lines.push('[命令已结束；输出管道仍被后台进程占用]')
  } else {
    lines.push(`[退出码 ${result.exitCode ?? '未知'}]`)
  }
  return lines.join('\n')
}
