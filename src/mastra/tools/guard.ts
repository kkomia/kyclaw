/**
 * 文件工具的公共防线（T11）：把 T10 的引擎包成工具装配用得到的三件事。
 *
 *   1. **路径解析**：目标只认授权工作区列表里的根；解析成功时给出的 `abs` 只来自引擎
 *      （`resolveInsideWorkspace`），调用方拿它去碰文件系统——绝不回退到模型给的原始字符串
 *      （原始串里的链接与 `..` 由系统解释，是另一条逃逸通道，见 permission/realpath.ts 头注释）。
 *   2. **审批判定**（spec §5.2）：只读放行；危险（delete/move）永远问；写类默认问，
 *      只有写操作的目标明确落在 mode='full' 的工作区时才放行。
 *   3. **会话状态**：edit 的"未读先改"记录（按会话隔离，会话键 = agent 线程 id）+
 *      同文件串行队列（并发 edit 不丢更新）。
 *
 * fs 可注入（测试用延迟/故障模拟），默认实现就是 node:fs——真实行为由各工具自己的用例钉。
 */
import { globSync } from 'node:fs'
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import type { Workspace } from '../../shared/settings'
import { type ToolClass } from '../../main/permission/classify'
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
  glob: async (pattern, cwd) => globSync(pattern, { cwd })
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

/** 授权工作区来源：数组，或"现读设置"的取值函数（用户中途加工作区不必重启 agent） */
export type WorkspaceRoots = readonly Workspace[] | (() => readonly Workspace[])

export interface ToolContext {
  roots: WorkspaceRoots
  classify: ToolClassifier
  fs: ToolFs
  state: ToolState
}

export function createToolContext(options: {
  roots: WorkspaceRoots
  classify: ToolClassifier
  fs?: ToolFs
}): ToolContext {
  return {
    roots: options.roots,
    classify: options.classify,
    fs: options.fs ?? nodeToolFs,
    state: new ToolState()
  }
}

export function workspaceRoots(ctx: ToolContext): readonly Workspace[] {
  return typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots
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

/** 目标 → 落在哪个工作区、归一后的绝对路径；一个都落不上就带着原因返回（不抛） */
export function resolveTarget(ctx: ToolContext, target: string): TargetResolution {
  const roots = workspaceRoots(ctx)
  if (roots.length === 0) return { ok: false, reason: NO_WORKSPACE_REASON }

  let firstReason = ''
  for (const workspace of roots) {
    const resolved = resolveInsideWorkspace(workspace.path, target)
    if (resolved.ok) return { ok: true, abs: resolved.abs, workspace }
    if (firstReason === '') firstReason = resolved.reason
  }
  return { ok: false, reason: `不在任何授权工作区内（${firstReason}）` }
}

/** 工具里用这个：解析不到直接抛（错误进工具卡，模型看到原因） */
export function toolTarget(ctx: ToolContext, target: string): ResolvedTarget {
  const resolved = resolveTarget(ctx, target)
  if (!resolved.ok) throw new Error(`无法使用路径「${target}」：${resolved.reason}`)
  return { abs: resolved.abs, workspace: resolved.workspace }
}

/**
 * glob/grep 的起始目录：没给 path 时，恰好一个工作区就用它；多个工作区必须显式指定
 * （默默挑第一个会让模型搜错根还以为搜过了）。
 */
export function scanRoot(ctx: ToolContext, target?: string): ResolvedTarget {
  if (target !== undefined && target.trim() !== '') return toolTarget(ctx, target)

  const roots = workspaceRoots(ctx)
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
 *   - 危险（delete/move）→ 永远问；
 *   - 写类 → 默认问；只有"目标明确落在 mode='full' 的工作区"才放行。
 *
 * 目标不在工作区（且拿不到可判定目标）时的口径：
 *   - 入参里根本没有可解析的 path（MCP 工具、未知工具）→ **问**：不知道它要干什么，保守；
 *   - 有 path 但解析不出去 → **不问**：我们的写类工具马上会被 guard fail closed 拒掉，
 *     弹一张"批了也不会执行"的审批卡只会误导用户；模型会拿到路径错误并回来找用户加工作区。
 *     （将来若引入"path 参数不是文件路径"的外部工具，要在这一步重新审视。）
 */
export function needsApproval(ctx: ToolContext, tool: string, input: unknown): boolean {
  const toolClass = ctx.classify(tool, input)
  if (toolClass === 'read') return false
  if (toolClass === 'dangerous') return true

  const target = inputPath(input)
  if (target === null) return true
  const resolved = resolveTarget(ctx, target)
  if (!resolved.ok) return false
  return resolved.workspace.mode !== 'full'
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
