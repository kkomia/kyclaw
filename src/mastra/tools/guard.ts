/**
 * 文件工具的公共防线（T11）：把 T10 的引擎包成工具装配用得到的三件事。
 *
 *   1. **路径解析**：目标只认授权工作区列表里的根；解析成功时给出的 `abs` 只来自引擎
 *      （`resolveInsideWorkspace`），调用方拿它去碰文件系统——绝不回退到模型给的原始字符串
 *      （原始串里的链接与 `..` 由系统解释，是另一条逃逸通道，见 permission/realpath.ts 头注释）。
 *   2. **审批判定**（spec §5.2）：只读放行；危险（delete/move）永远问；写类默认问，
 *      只有写操作的目标明确落在 mode='full' 的工作区、或落了"永久允许"规则（T13，粒度
 *      工具 + 工作区）时才放行。
 *   3. **会话状态**：edit 的"未读先改"记录（按会话隔离，会话键 = agent 线程 id）+
 *      同文件串行队列（并发 edit 不丢更新）。
 *
 * fs 可注入（测试用延迟/故障模拟），默认实现就是 node:fs——真实行为由各工具自己的用例钉。
 */
import { globSync } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import type { PermissionRule, Workspace } from '../../shared/settings'
import { isAllowedByRules } from '../../shared/permissions'
import { isWorkspaceFileTool, type ToolClass } from '../../main/permission/classify'
import { resolveInsideWorkspace } from '../../main/permission/realpath'

/** 工具分级函数（T10 的 classifyToolCall；测试可注入别的实现） */
export type ToolClassifier = (tool: string, input?: unknown) => ToolClass

export interface DirEntry {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface PathStat {
  size: number
  isFile(): boolean
  isDirectory(): boolean
}

/** 工具用到的文件系统面（可注入；默认 nodeToolFs） */
export interface ToolFs {
  /** 读文件内容；给了 maxBytes 就最多读这么多字节（大文件不整个进内存） */
  readFile(path: string, maxBytes?: number): Promise<Buffer>
  writeFile(path: string, data: string): Promise<void>
  stat(path: string): Promise<PathStat>
  /** 递归创建目录 */
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<readonly DirEntry[]>
  /** 以 cwd 为基准的 glob；结果可能是相对 cwd 的路径，也可能是绝对路径（调用方两者都收） */
  glob(pattern: string, cwd: string): Promise<readonly string[]>
  /**
   * 删除：文件 unlink；目录 recursive=false 只删空目录（非空抛错，调用方翻成人话）、
   * recursive=true 整树删。目标不存在时抛错（调用方先 stat 过，这里不做静默 no-op）。
   */
  remove(path: string, options: { recursive: boolean }): Promise<void>
  /** 重命名/移动（同卷语义：目标已存在的行为由调用方负责，先删还是拒绝由工具决定） */
  rename(from: string, to: string): Promise<void>
}

export const nodeToolFs: ToolFs = {
  async readFile(path, maxBytes) {
    if (maxBytes === undefined) return readFile(path)
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  },
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  stat: (path) => stat(path),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  readdir: (path) => readdir(path, { withFileTypes: true }),
  glob: async (pattern, cwd) => globSync(pattern, { cwd }),
  async remove(path, options) {
    const stats = await stat(path)
    if (!stats.isDirectory()) {
      await unlink(path)
      return
    }
    if (options.recursive) await rm(path, { recursive: true })
    else await rmdir(path)
  },
  rename: (from, to) => fsRename(from, to)
}

/** 拿不到线程 id 时的会话键（单测、无记忆运行都落这一桶） */
export const DEFAULT_SESSION = 'default'

/** 会话状态：read 记录（未读先改）+ 同文件队列（并发串行化）。每个工具集共享一份 */
export class ToolState {
  private readonly reads = new Map<string, Set<string>>()
  private readonly tails = new Map<string, Promise<unknown>>()

  markRead(session: string, abs: string): void {
    const files = this.reads.get(session) ?? new Set<string>()
    files.add(abs)
    this.reads.set(session, files)
  }

  wasRead(session: string, abs: string): boolean {
    return this.reads.get(session)?.has(abs) ?? false
  }

  /** 同一目标上的操作排成一条队列：先来的先跑，前一个失败也轮到下一个 */
  runExclusive<T>(target: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(target) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(target, tail)
    void tail.then(() => {
      if (this.tails.get(target) === tail) this.tails.delete(target)
    })
    return result
  }
}

/**
 * 授权工作区来源：数组，或"按会话现取"的取值函数（T18：会话的项目/默认工作区中途变，下一轮就跟着变）。
 * 取值函数收到 `session === undefined` 时给的是**审批口径**——实现方（agents/kyclaw.ts）给的是
 * **整份授权列表**（超集）。为什么审批不按会话收窄：Mastra 的 `requireApproval` 回调只拿得到
 * `(input, { requestContext, workspace })`，**没有线程 id**，判不了"这个会话的项目是哪个"。
 * 取超集只可能多问，不会漏问——真正能落盘的写必须经执行层的会话根（子集）解析，
 * 所以不存在"审批放行、执行越界"的组合（方向判据见 needsApproval 头注）。
 */
export type WorkspaceRoots =
  readonly Workspace[] | ((session: string | undefined) => readonly Workspace[])

/** "永久允许"规则来源（T13）：批准过"永久允许"的 (工具, 工作区) 落在这里；现读设置 */
export type PermissionRuleSource = () => readonly PermissionRule[]

export interface ToolContext {
  roots: WorkspaceRoots
  classify: ToolClassifier
  fs: ToolFs
  state: ToolState
  permissionRules: PermissionRuleSource
}

export function createToolContext(options: {
  roots: WorkspaceRoots
  classify: ToolClassifier
  fs?: ToolFs
  /** 缺省 = 没有任何"永久允许"规则（工具单测的默认口径） */
  permissionRules?: PermissionRuleSource
}): ToolContext {
  return {
    roots: options.roots,
    classify: options.classify,
    fs: options.fs ?? nodeToolFs,
    state: new ToolState(),
    permissionRules: options.permissionRules ?? (() => [])
  }
}

export function workspaceRoots(ctx: ToolContext, session?: string): readonly Workspace[] {
  return typeof ctx.roots === 'function' ? ctx.roots(session) : ctx.roots
}

/** 会话键 = agent 线程 id（Mastra 的 tool 执行上下文里带着它）；拿不到就落公共桶 */
export function sessionKey(context: unknown): string {
  const agent = (context as { agent?: { threadId?: unknown } } | undefined)?.agent
  const threadId = agent?.threadId
  return typeof threadId === 'string' && threadId !== '' ? threadId : DEFAULT_SESSION
}

export const NO_WORKSPACE_REASON = '还没有授权工作区：请先在「设置 → 工作区」里添加一个文件夹'

export interface ResolvedTarget {
  abs: string
  workspace: Workspace
}

export type TargetResolution = ({ ok: true } & ResolvedTarget) | { ok: false; reason: string }

/**
 * 目标 → 落在哪个工作区、归一后的绝对路径；一个都落不上就带着原因返回（不抛）。
 * `session` 决定用哪份根（T18）：工具执行时传 `sessionKey(context)`（会话的项目/默认工作区）；
 * **不传 = 审批口径**（整份授权列表，见 WorkspaceRoots 头注）。
 */
export function resolveTarget(
  ctx: ToolContext,
  target: string,
  session?: string
): TargetResolution {
  const roots = workspaceRoots(ctx, session)
  if (roots.length === 0) return { ok: false, reason: NO_WORKSPACE_REASON }

  let firstReason = ''
  for (const workspace of roots) {
    const resolved = resolveInsideWorkspace(workspace.path, target)
    if (resolved.ok) return { ok: true, abs: resolved.abs, workspace }
    if (firstReason === '') firstReason = resolved.reason
  }
  return { ok: false, reason: `不在任何授权工作区内（${firstReason}）` }
}

/** 越界时的可行动指引（round28 模块 1）：别让模型反复换写法死循环，告诉它下一步 */
export const OUT_OF_WORKSPACE_HINT =
  '；可以用 bash 工具在任意路径下操作（会请求用户审批），或在「设置 → 工作区」里添加该文件夹'

/** 工具里用这个：解析不到直接抛（错误进工具卡，模型看到原因与下一步） */
export function toolTarget(ctx: ToolContext, target: string, session?: string): ResolvedTarget {
  const resolved = resolveTarget(ctx, target, session)
  if (!resolved.ok) {
    const hint = resolved.reason.includes('工作区之外') ? OUT_OF_WORKSPACE_HINT : ''
    throw new Error(`无法使用路径「${target}」：${resolved.reason}${hint}`)
  }
  return { abs: resolved.abs, workspace: resolved.workspace }
}

/**
 * glob/grep 的起始目录：没给 path 时，恰好一个工作区就用它；多个工作区必须显式指定
 * （默默挑第一个会让模型搜错根还以为搜过了）。
 */
export function scanRoot(ctx: ToolContext, target?: string, session?: string): ResolvedTarget {
  if (target !== undefined && target.trim() !== '') return toolTarget(ctx, target, session)

  const roots = workspaceRoots(ctx, session)
  if (roots.length === 0) throw new Error(NO_WORKSPACE_REASON)
  if (roots.length > 1) {
    throw new Error(
      `有多个授权工作区，请用 path 指定搜索哪一个：${roots.map((w) => w.path).join('、')}`
    )
  }

  const workspace = roots[0]
  const resolved = resolveInsideWorkspace(workspace.path, '.')
  if (!resolved.ok) throw new Error(`工作区不可用：${resolved.reason}`)
  return { abs: resolved.abs, workspace }
}

/**
 * 审批判定（spec §5.2）：
 *   - 只读（classify）→ 放行；
 *   - 危险（delete/move）→ 永远问（Full access 与"永久允许"规则都不放行）；
 *   - 写类 → 按工具身份分三档：
 *       · **内置工作区文件工具**（write/edit）：执行路径必过引擎。目标明确落在 mode='full' 的
 *         工作区、或 (工具, 工作区) 命中一条"永久允许"规则才放行；目标解析不到时**不问**
 *         —— 我们的工具马上会 fail closed 拒掉，弹一张"批了也不会执行"的卡只会误导用户。
 *       · **能力类工具**（round28：bash / fetch / git_add / git_commit）：按它们的"显式目标"
 *         字段（bash=cwd、fetch=save_to、git=path）解析；没给目标时执行层的根 = 会话根，
 *         审批层拿不到会话 —— 只有授权列表**恰好一条**时能绑定。规则命中放行；
 *         **full 只对 git 生效**（git 是工作区受限工具），bash/fetch 能碰工作区之外的东西
 *         （bash 能 cd 出去、fetch 能请求任意地址），Full access 管不了它们，只有显式规则能豁免。
 *         目标给了解析不出去：bash 的执行层**允许**在工作区外跑（这正是它的用途）→ 问；
 *         fetch/git 的目标过引擎、执行层会 fail closed → 不问（批了也不执行，弹卡是噪音）。
 *       · **其它写类**（MCP 外部工具、未知工具）：执行不走我们的引擎，无法证明"只碰这个工作区"
 *         （入参里的 path 可能根本不是文件路径）。**一律问**；唯一的放行口子是这个目标能解析进
 *         某个工作区、且该工作区上有一条按**全名**命中的"永久允许"规则（T13，用户对这张卡
 *         显式批准过）。工作区的 Full access 不适用：那是对"这个文件夹里的文件操作"的授权，
 *         不是"放行任意外部工具"。
 *
 * 为什么按工具身份分叉，而不是按目标不可解析的原因（T12 重审）：原因不改变一个外部工具
 * 实际能干什么 —— `mcp__a__write` 带一个工作区外的 path 不代表它只碰那里，它可能只是恰好有个
 * 叫 path 的入参。能证明安全的是"工具自己的执行受引擎约束"（内置五件套），不是"路径看起来
 * 像是不用管的"。v1 曾用"有 path 但解析不出去 → 不问"，对内置工具安全，对 MCP 工具是静默
 * 绕过审批的漏洞，已按此分叉修掉。
 *
 * 能力类工具（bash/fetch/git_*）按**整名**识别：`mcp__shell__bash` 不会被认成内置 bash，
 * 走的是外部工具那一档（一律问，全名规则才放行）。"问一次后可永久允许"的出口对它们是
 * (工具, 工作区) 规则；多工作区且没给显式目标时绑不上工作区，只能每次问（保守方向）。
 *
 * T18（会话根）与这一层的关系：解析用**审批口径**（整份授权列表，= `resolveTarget(ctx, target)`
 * 不传 session）。执行层（工具 execute）用**会话根**（某个项目或默认工作区，见 main/projects.ts
 * 的 sessionRoots）——两者是"超集 / 子集"关系：任何能落盘的写都落在审批看过的那条工作区条目上
 * （同一条目决定 mode 与规则），所以审批不会比执行松；反过来，用户批准一次不在会话范围内的写
 * 会以工具错误收场（fail closed，不落盘），不会静默越界。
 */
export function needsApproval(ctx: ToolContext, tool: string, input: unknown): boolean {
  const toolClass = ctx.classify(tool, input)
  if (toolClass === 'read') return false
  if (toolClass === 'dangerous') return true

  const capability = capabilityOf(tool)
  if (capability !== null) return capabilityNeedsApproval(ctx, capability, tool, input)

  const target = inputPath(input)
  if (target === null) return true
  const resolved = resolveTarget(ctx, target)

  if (!isWorkspaceFileTool(tool)) {
    // 外部/未知工具：目标解析不到 → 问；解析到 → 只有全名规则能放行（full 不适用）
    if (!resolved.ok) return true
    return !isAllowedByRules(ctx.permissionRules(), tool, resolved.workspace.path)
  }

  // 内置文件工具：目标解析不到 → 不问（执行即 fail closed）；full 与规则照旧
  if (!resolved.ok) return false
  if (resolved.workspace.mode === 'full') return false
  return !isAllowedByRules(ctx.permissionRules(), tool, resolved.workspace.path)
}

/** 能力类工具（按整名；MCP 名一律不算） */
type Capability = 'shell' | 'network' | 'git'

function capabilityOf(tool: string): Capability | null {
  switch (tool.trim().toLowerCase()) {
    case 'bash':
      return 'shell'
    case 'fetch':
      return 'network'
    case 'git_add':
    case 'git_commit':
      return 'git'
    default:
      return null
  }
}

/** 每种能力的"显式目标"入参名（bash 的 cwd / fetch 的 save_to / git 的 path） */
function capabilityTarget(capability: Capability, input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const key = capability === 'shell' ? 'cwd' : capability === 'network' ? 'save_to' : 'path'
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function capabilityNeedsApproval(
  ctx: ToolContext,
  capability: Capability,
  tool: string,
  input: unknown
): boolean {
  const target = capabilityTarget(capability, input)
  if (target !== null) {
    const resolved = resolveTarget(ctx, target)
    if (resolved.ok) {
      if (capability === 'git' && resolved.workspace.mode === 'full') return false
      return !isAllowedByRules(ctx.permissionRules(), tool, resolved.workspace.path)
    }
    // 目标解析不出去：bash 的执行层允许在工作区外跑（带审批的主通道）→ 必须问；
    // fetch/git 的目标过引擎，执行层会 fail closed —— 不问（弹"批了也不执行"的卡没意义）
    return capability === 'shell'
  }

  // 没给显式目标：执行层的根 = 会话根，审批层拿不到会话 —— 授权列表恰好一条时可绑定
  const roots = workspaceRoots(ctx)
  if (roots.length !== 1) return true
  const workspace = roots[0]
  if (capability === 'git' && workspace.mode === 'full') return false
  return !isAllowedByRules(ctx.permissionRules(), tool, workspace.path)
}

function inputPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const path = (input as { path?: unknown }).path
  return typeof path === 'string' && path !== '' ? path : null
}

/** 对已知的绝对候选路径再做一次引擎校验（glob/grep 的每个命中都要过它，防链接逃逸） */
export function insideWorkspace(workspace: Workspace, candidate: string): string | null {
  const resolved = resolveInsideWorkspace(workspace.path, candidate)
  return resolved.ok ? resolved.abs : null
}

/** stat 失败（不存在等）当 null：调用方自己决定是"跳过"还是"报错" */
export async function statOrNull(ctx: ToolContext, abs: string): Promise<PathStat | null> {
  try {
    return await ctx.fs.stat(abs)
  } catch {
    return null
  }
}
