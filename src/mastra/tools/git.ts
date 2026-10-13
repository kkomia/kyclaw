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
 *   - **用户中止（round 73）**：`context.abortSignal` 一路传给 `runProcess` —— 用户点停止时
 *     命令树被收掉、回执换成 `[已被用户中止：…]`（与 bash 同一口径，不伪装成 git 自己失败）。
 *   - `core.quotepath=false`：中文文件名在 status/log 里不转义成 \344\270\255。
 *   - **v1 明确不做 push**（远程写）：远程交互面（凭据、冲突策略）不在本轮契约里。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { formatSeconds, runProcess, type RunResult } from './exec'
import {
  approvalSessionOf,
  needsApproval,
  scanRoot,
  sessionKey,
  statOrNull,
  type ResolvedTarget,
  type ToolContext
} from './guard'

// git 可执行文件的探测链住在 main/git-bash.ts（工作台的 Git 工具同一套）；这里 re-export，
// 既有的 `from './git'` 导入（git.spec.ts 等）一字不改。
export {
  findGit,
  GIT_MISSING,
  gitExecutable,
  resetGitExecutableCache,
  type GitProbe
} from '../../main/git-bash'

// re-export 不会把名字带进本模块的作用域，工具执行处还要用它们，所以再 import 一次
import { GIT_MISSING, gitExecutable } from '../../main/git-bash'

/** 单次 git 命令的超时（毫秒）：提交钩子/大 diff 也够用 */
export const GIT_TIMEOUT_MS = 60_000

/** git 提交历史的条数上限 */
export const GIT_LOG_MAX = 100

const repoSchema = z
  .string()
  .min(1)
  .optional()
  // round 70 瘦身：这一串在五件 git 工具里各出现一次（wire 上是五份），措辞压到最短
  .describe(
    'Repository directory inside the workspace; defaults to the session workspace and is required with several workspaces'
  )

export const gitStatusInputSchema = z.object({ path: repoSchema })
export const gitDiffInputSchema = z.object({
  path: repoSchema,
  staged: z.boolean().optional().describe('true = show staged changes only (git diff --staged)'),
  file: z
    .string()
    .min(1)
    .optional()
    .describe('Limit the diff to this path, relative to the repository')
})
export const gitLogInputSchema = z.object({
  path: repoSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(GIT_LOG_MAX)
    .optional()
    .describe(`Maximum number of commits to show; defaults to 20, maximum ${GIT_LOG_MAX}`)
})
export const gitAddInputSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe('Paths to stage, relative to the repository; name them, never "."'),
  path: repoSchema
})
export const gitCommitInputSchema = z.object({
  message: z.string().min(1).describe('Commit message'),
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
      'Short status of the workspace git repository: current branch and changed files, read-only.',
    inputSchema: gitStatusInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'git_status', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      return await runGitCommand(
        resolveGit,
        timeoutMs,
        repo.abs,
        ['-c', 'core.quotepath=false', 'status', '--short', '--branch'],
        undefined,
        context.abortSignal
      )
    }
  })

  const gitDiff = createTool({
    id: 'git_diff',
    description:
      'Diff the workspace git repository: unstaged by default, staged with staged=true, read-only.',
    inputSchema: gitDiffInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'git_diff', input, approvalSessionOf(approval)),
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
      return await runGitCommand(
        resolveGit,
        timeoutMs,
        repo.abs,
        args,
        undefined,
        context.abortSignal
      )
    }
  })

  const gitLog = createTool({
    id: 'git_log',
    description:
      'Commit history of the workspace git repository (--oneline, 20 by default, read-only).',
    inputSchema: gitLogInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'git_log', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      return await runGitCommand(
        resolveGit,
        timeoutMs,
        repo.abs,
        ['-c', 'core.quotepath=false', 'log', '--oneline', '-n', String(input.limit ?? 20)],
        undefined,
        context.abortSignal
      )
    }
  })

  const gitAdd = createTool({
    id: 'git_add',
    description:
      'Stage files in the workspace git repository; paths is required, for example ["src/index.ts"]. ' +
      'Stage the paths you changed by name, never ".".',
    inputSchema: gitAddInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'git_add', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      const specs = input.paths.map((spec) => resolveSpec(repo, spec))
      return await runGitCommand(
        resolveGit,
        timeoutMs,
        repo.abs,
        ['add', '--', ...specs],
        () => `已暂存：${input.paths.join('、')}`,
        context.abortSignal
      )
    }
  })

  const gitCommit = createTool({
    id: 'git_commit',
    description:
      'Commit the staged changes; message is required. Run git_add first. Commit only when the user asked for ' +
      'one; this tool never pushes, so pushing stays with the user.',
    inputSchema: gitCommitInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'git_commit', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const repo = await gitRepo(ctx, sessionKey(context), input.path)
      return await runGitCommand(
        resolveGit,
        timeoutMs,
        repo.abs,
        ['commit', '-m', input.message],
        undefined,
        context.abortSignal
      )
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

/**
 * 跑一条 git 命令。`signal` = `context.abortSignal`（round 73）：用户点停止时命令树会被收掉，
 * 结果带 `aborted: true`，回执明说"已被用户中止"（见 renderGitResult）——不再只停 UI。
 */
async function runGitCommand(
  resolveGit: () => string | null,
  timeoutMs: number,
  repoAbs: string,
  args: string[],
  receipt?: () => string,
  signal?: AbortSignal
): Promise<string> {
  const git = resolveGit()
  if (git === null) throw new Error(GIT_MISSING)

  const result = await runProcess({
    command: git,
    args: ['-C', repoAbs, ...args],
    cwd: repoAbs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs,
    signal
  })
  if (result.spawnError !== null) throw new Error(`git 启动失败：${result.spawnError.message}`)
  return renderGitResult(result, timeoutMs, receipt?.())
}

/**
 * 结果渲染：输出 + 退出码（非零不抛错 —— git 的输出就是解释）；超时 / 用户中止 / 挂后台换成说明。
 * 中止单独一条：与超时分开说，模型才不会把它读成"git 自己失败了"（与 bash 同一口径）。
 */
export function renderGitResult(result: RunResult, timeoutMs: number, receipt?: string): string {
  const body = result.text.replace(/[\r\n]+$/, '')
  const head = receipt !== undefined && result.exitCode === 0 ? receipt : ''
  const content = [head, body].filter((part) => part !== '').join('\n\n')

  const lines = [content === '' ? '（无输出）' : content, '']
  if (result.aborted) {
    lines.push(`[已被用户中止：命令已终止（退出码 ${result.exitCode ?? '未知'}）]`)
  } else if (result.timedOut) {
    lines.push(`[已超时：超过 ${formatSeconds(timeoutMs)} 秒，已终止进程]`)
  } else if (result.streamHeldOpen) {
    lines.push('[命令已结束；输出管道仍被后台进程占用]')
  } else {
    lines.push(`[退出码 ${result.exitCode ?? '未知'}]`)
  }
  return lines.join('\n')
}
