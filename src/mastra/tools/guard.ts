/**
 * 文件工具的公共防线（T11）：把 T10 的引擎包成工具装配用得到的三件事。
 *
 *   1. **路径解析**：目标只认授权工作区列表里的根；解析成功时给出的 `abs` 只来自引擎
 *      （`resolveInsideWorkspace`），调用方拿它去碰文件系统——绝不回退到模型给的原始字符串
 *      （原始串里的链接与 `..` 由系统解释，是另一条逃逸通道，见 permission/realpath.ts 头注释）。
 *   2. **审批判定**（spec §5.2；round 75 起**按目标落在哪个区**判，见 needsApproval 头注）：
 *      只读放行；其余按"目标全在这个区里"分三档 —— 区内 full 免审 / 区内 ask 靠规则 /
 *      区外按「工作区之外」那一档（默认问）。
 *   3. **会话状态**：edit 的"未读先改"记录（按会话隔离，会话键 = agent 线程 id）+
 *      同文件串行队列（并发 edit 不丢更新）。
 *
 * fs 可注入（测试用延迟/故障模拟），默认实现就是 node:fs——真实行为由各工具自己的用例钉。
 */
import { globSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
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
import type { PermissionRule, Workspace, WorkspaceMode } from '../../shared/settings'
import { isAllowedByRules } from '../../shared/permissions'
import { scanCommand } from '../../shared/command-risk'
import type { ToolClass } from '../../main/permission/classify'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { outsideMode as outsideModeRegistry } from '../../main/permission/outside-mode'

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
  /**
   * 写文件（整文件覆盖）：文本走 string（UTF-8），二进制走 Uint8Array ——
   * 产出物工具（模块 4）的 PDF / xlsx / pptx / docx 都是二进制容器，走的是后一支。
   */
  writeFile(path: string, data: string | Uint8Array): Promise<void>
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
 * 取值函数收到 `session === undefined` 时给的是**整份授权列表**（超集，实现方是 agents/kyclaw.ts）。
 * 审批侧什么时候用哪一份，见下面 round 46 的口径。
 *
 * round 46：审批**能**按会话收窄了。core 的 `buildToolApprovalContext` 把 requestContext 摊平成
 * plain object 交给 `needsApprovalFn(input, ctx)`，agent 每轮写进去的 `MastraMemory` 原样在里面
 * （线程 id = `MastraMemory.thread.id`，实证见 approvalSessionOf 头注）。所以：
 *   - **一个目标都没有**时（能力类工具的缺省分支、外部/未知工具）按**会话根**判 ——
 *     与执行层同口径（执行层用的就是会话根，见 tools/bash.ts 的 resolveBashCwd）；
 *   - **有目标**时按整份授权列表解析：目标是模型给的字符串，落在哪个工作区与"哪个会话在跑"无关。
 * 会话根是授权列表的子集（sessionRoots 的契约），所以"审批放行、执行越界"的组合依旧不存在
 * （方向判据见 needsApproval 头注）。回调里拿不到会话（无记忆运行、外部调用）时退回整份列表
 * 这条保守口径 —— 旧行为原样。
 */
export type WorkspaceRoots =
  readonly Workspace[] | ((session: string | undefined) => readonly Workspace[])

/** "永久允许"规则来源（T13）：批准过"永久允许"的 (工具, 工作区) 落在这里；现读设置 */
export type PermissionRuleSource = () => readonly PermissionRule[]

/**
 * 「工作区之外」那一档的来源（round 75）：`ask` = 区外的操作逐次询问（缺省）/ `full` = 区外也免审。
 * 缺省取 `main/permission/outside-mode` 的运行期镜像（由 `main/settings.ts` 每次读写设置时刷新，
 * 设置页改完**下一轮工具调用**就生效）；测试可以显式注入，不依赖全局状态。
 */
export type OutsideModeSource = () => WorkspaceMode

export interface ToolContext {
  roots: WorkspaceRoots
  classify: ToolClassifier
  fs: ToolFs
  state: ToolState
  permissionRules: PermissionRuleSource
  outsideMode: OutsideModeSource
}

export function createToolContext(options: {
  roots: WorkspaceRoots
  classify: ToolClassifier
  fs?: ToolFs
  /** 缺省 = 没有任何"永久允许"规则（工具单测的默认口径） */
  permissionRules?: PermissionRuleSource
  /** 缺省 = 运行期镜像（生产装配不传；单测可注入一个固定档位） */
  outsideMode?: OutsideModeSource
}): ToolContext {
  return {
    roots: options.roots,
    classify: options.classify,
    fs: options.fs ?? nodeToolFs,
    state: new ToolState(),
    permissionRules: options.permissionRules ?? (() => []),
    outsideMode: options.outsideMode ?? outsideModeRegistry
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

/**
 * 审批回调里的会话（round 46，`sessionKey` 的审批侧对应物）：core 每次工具调用前算审批结论
 * （`resolveToolApprovalVerdict`），回调第二参是
 * `{ args, requestContext: Object.fromEntries([...requestContext.entries()]) , workspace }`
 * —— `requestContext` 被**摊平成 plain object**（没有 `.get`），但键值原样带着 agent 每轮写进去
 * 的那一份。实测（src/mastra/__tests__/approval-session-chain.spec.ts，真 mastra agent + 真 chatRoute
 * 跑一轮探针工具）该对象**只有 `MastraMemory` 一个键**：
 *   `{ MastraMemory: { thread: <thread 对象，thread.id = 当前线程>, resourceId, memoryConfig, runState } }`
 * 所以线程 id 从 `MastraMemory.thread.id` 取（与 compaction 的 `threadIdOfRequestContext` 同源）。
 * `mastra__threadId`（core 的 MASTRA_THREAD_ID_KEY）在这条路径上**不存在**，留作兜底 ——
 * core 在别的装配方式下可能补上它，两条都认没有坏处。
 *
 * 取不到（没挂 Memory 的运行、单测里的假 ctx）→ undefined，调用方按"拿不到会话"的保守口径判
 * （整份授权列表，见 WorkspaceRoots 头注）。
 */
export function approvalSessionOf(approvalCtx: unknown): string | undefined {
  if (typeof approvalCtx !== 'object' || approvalCtx === null) return undefined
  const requestContext = (approvalCtx as { requestContext?: unknown }).requestContext
  if (typeof requestContext !== 'object' || requestContext === null) return undefined
  const flat = requestContext as Record<string, unknown>

  const memory = flat.MastraMemory as { thread?: { id?: unknown } } | undefined
  const fromMemory = memory?.thread?.id
  if (typeof fromMemory === 'string' && fromMemory.trim() !== '') return fromMemory.trim()

  const direct = flat.mastra__threadId
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()

  return undefined
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
 * 审批判定（spec §5.2；round 75 起**按目标落在哪个区**判，不再按工具身份分叉）。
 *
 * ## 三种走向
 *
 *   1. **只读**（classify）→ 放行。
 *   2. 其余一切（写 / 删 / 移、bash / fetch / git、MCP 与未知工具）先把这次调用**会碰的目标**收齐
 *      （入参里的 `path` / `to` / `save_to` + 命令文本抽出来的破坏性目标 + `cwd`），
 *      再把每个目标判成"落在哪个工作区"，汇总成三档之一：
 *        · **`full`** —— 所有目标都证明落在 `mode='full'` 的工作区里 → **免审**。这是「完全访问」的
 *          字面意思：这个文件夹里的写 / 删（含 `rm -rf`、`delete`）/ 移 / bash 命令都不再问。
 *          用户口径（round 75）：**设了全免就是全免**，不再有"某种形态永远问"的红线。
 *        · **`inside`** —— 所有目标都在授权工作区里，但涉及的有 `ask` 档 → 按"永久允许"规则
 *          （工具 × 工作区）判：涉及的**每一个**工作区都有规则才免审，否则问。
 *        · **`outside`** —— 任一目标落在工作区之外，**或判不出来**（`~` / `$VAR`、相对路径又没有
 *          基准目录、命令形态本身就落不到工作区里）→ 按**「工作区之外」那一档**
 *          （`settings.outsideWorkspaceMode`）：默认 `ask`（每次询问），用户显式设成 `full`
 *          就是真免审（他设了就照办）。
 *   3. **噪音过滤**（唯一的例外）：执行层会 fail closed 的工具（内置文件工具与 fetch / git 的目标
 *      字段都过我们的引擎，见 `ENGINE_TARGET_TOOLS`）——目标解析不出去时**不问**：批了也不会执行
 *      （工具立刻回一句工具错误），弹一张"批了也不会执行"的卡只会误导用户。`bash` 不在此列：
 *      在工作区外跑正是它的用途（那是带审批的主通道），它的越界目标走区外档。
 *
 * ## 目标抽取的两条路
 *
 *   - **入参字段**：`path`（内置文件工具 / MCP）/ `to`（move）/ `save_to`（fetch）。这些字段在执行层
 *     要么过引擎（内置工具），要么只是"看起来像路径"（MCP）——后者按同一把尺判区，判到区外就走区外档
 *     （比"因为有 path 就放行"保守：MCP 工具带一个区外 path 不代表它只碰那里）。
 *   - **命令文本**（`shared/command-risk.ts` 的 `scanCommand`）：从 `command` 里把"要动的路径"抽出来
 *     （删除类动词的参数、重定向落点、搬运目的地、`dd of=`、`find -delete` 的起始目录）一起判区；
 *     "形态落不到工作区里"的几种（磁盘级 / 网络喂 shell / 强制推送）直接算**区外**。
 *     round 71 的那条"递归删除永远问"的红线已按用户口径撤掉：`rm -rf` 落在 full 工作区里就免审。
 *
 * ## 基准目录（相对路径按它解析）
 *
 * 给了 `cwd`（bash 的显式目标）就按它（解析不出=这条命令在区外跑 → 区外档）；没给且授权列表恰好
 * 一条就用它；两者都没有（多工作区又没给 cwd）→ 相对路径一律按"外"（与执行层"多工作区必须显式给
 * cwd"同一方向：说不清就多问一次）。`~` / `$VAR` / `%VAR%` 开头的一律按"外"：它们展开成什么在这里
 * 证明不了。
 *
 * ## 会话（T18 / round 46）
 *
 * **有目标**时解析用**审批口径**（整份授权列表，= `resolveTarget(ctx, target)` 不传 session）：
 * 目标是模型给的字符串，落在哪个工作区与"哪个会话在跑"无关。
 * **一个目标都没有**时（`echo hi`、MCP 的只读检索这类）执行层的根 = 会话根，所以审批也按**会话根**
 * 判：单根 full → 免审 / 单根 ask → 规则 / 多根全 full → 免审 / 混合档 → 区外档（说不清执行会落哪）。
 * 回调里拿不到会话（无记忆运行、工具单测）退回整份列表这条旧口径（见 `approvalSessionOf`）。
 * 会话根是整份列表的子集，所以方向判据不变：任何能落盘的写都落在审批看过的那条工作区条目上；
 * 反过来，用户批准一次不在会话范围内的写会以工具错误收场（fail closed，不落盘），不会静默越界。
 *
 * `session` 由调用方（各工具的 requireApproval）从回调第二参取：`approvalSessionOf(approval)`。
 */
export function needsApproval(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  session?: string
): boolean {
  const toolClass = ctx.classify(tool, input)
  if (toolClass === 'read') return false

  const verdict = zoneOfCall(ctx, input, session)
  if (verdict.zone === 'full') return false

  if (verdict.zone === 'outside') {
    // 目标解析不出去 + 执行受我们的引擎约束 → 批了也不会执行，不问（见头注第 3 条）
    if (verdict.unresolvedTarget && ENGINE_TARGET_TOOLS.has(tool.trim().toLowerCase())) return false
    return ctx.outsideMode() !== 'full'
  }

  // 区内的 ask 档：涉及的工作区每一个都要有 (工具 × 工作区) 规则才免审
  if (verdict.workspaces.length === 0) return true
  return !verdict.workspaces.every((workspace) =>
    isAllowedByRules(ctx.permissionRules(), tool, workspace.path)
  )
}

/**
 * 目标字段由我们的引擎兜着的**内置**工具（整名；`mcp__` 一律不算）：目标解析不出去 = 执行层马上
 * 回一句工具错误把这次调用拒掉，不落任何东西 —— 所以"目标在工作区之外"对它们是**批了也不会执行**，
 * 不弹卡（与改动前"内置文件工具目标解析不到就不问"同一条口径，现在把 delete / move / fetch / git
 * 也收进来：它们的越界目标同样 fail closed）。
 * `bash` / `web_search` / 技能与 MCP 的四个作者工具不在表里：前两个在工作区外跑是它们的用途或没有
 * 目标字段，后四个写的是应用自己的托管数据面（执行不走这套引擎）。
 */
const ENGINE_TARGET_TOOLS = new Set([
  'write',
  'edit',
  'delete',
  'move',
  'create_report',
  'create_pdf',
  'create_excel',
  'create_ppt',
  // round 76：edit_ppt 的 path 与 create_ppt 同一把尺（artifactTarget 先解析再改），越界同样 fail closed
  'edit_ppt',
  'create_docx',
  'fetch',
  'git_add',
  'git_commit'
])

type TargetZone = 'full' | 'inside' | 'outside'

interface ZoneVerdict {
  zone: TargetZone
  /** zone='inside' 时涉及的授权工作区（每个都要有规则才放行） */
  workspaces: readonly Workspace[]
  /**
   * 这次判成"区外"是因为**有目标但解析不出去**（而不是压根没有目标）—— 引擎约束的工具据此不问。
   */
  unresolvedTarget: boolean
}

const OUTSIDE: ZoneVerdict = { zone: 'outside', workspaces: [], unresolvedTarget: false }

/** 一次调用的目标 → 落在哪个区（见 needsApproval 头注） */
function zoneOfCall(ctx: ToolContext, input: unknown, session?: string): ZoneVerdict {
  const roots = workspaceRoots(ctx)
  const command = stringField(input, 'command')
  const scan = command === null ? null : scanCommand(command)
  if (scan !== null && scan.unbounded !== null) {
    return { zone: 'outside', workspaces: [], unresolvedTarget: false }
  }

  const cwd = stringField(input, 'cwd')
  let base: string | null = null
  const involved: Workspace[] = []
  let allFull = true
  let saw = false
  const note = (workspace: Workspace): void => {
    saw = true
    if (workspace.mode !== 'full') allFull = false
    if (!involved.includes(workspace)) involved.push(workspace)
  }
  const found = (): ZoneVerdict => ({
    zone: allFull ? 'full' : 'inside',
    workspaces: involved,
    unresolvedTarget: false
  })
  const unresolved = (): ZoneVerdict => ({
    zone: 'outside',
    workspaces: [],
    unresolvedTarget: true
  })

  if (cwd !== null) {
    // 声明的执行目录本身就是证据：它必须落在某个授权工作区里，否则这条命令就是在区外跑
    const resolved = resolveTarget(ctx, cwd)
    if (!resolved.ok) return unresolved()
    base = resolved.abs
    note(resolved.workspace)
  } else if (sessionRootsOf(ctx, session, roots).length === 1) {
    // 没给 cwd：执行层的根 = 会话根（round 46 口径），恰好一条就用它当相对路径的基准
    base = sessionRootsOf(ctx, session, roots)[0].path
  }

  const shellTargets = scan?.targets ?? []
  // 命令要动东西、却没给 cwd、会话根又不是恰好一条 → 说不出它到底在哪个目录里跑（执行层也会拒：
  // 多工作区时 cwd 必须显式给），保守按区外。一条目标都没有的命令（`echo hi`）不走这条：
  // 它按"无目标"档判（round 46 的口径 —— 会话根定了就不打扰，那是用户实报过的一张卡）。
  if (command !== null && cwd === null && base === null && shellTargets.length > 0) {
    return unresolved()
  }

  for (const target of shellTargets) {
    const hit = zoneOfToken(roots, target, base)
    if (hit === null) return unresolved()
    note(hit)
  }

  for (const target of declaredTargetsOf(input)) {
    const resolved = resolveTarget(ctx, target)
    if (!resolved.ok) return unresolved()
    note(resolved.workspace)
  }

  if (!saw) return zoneOfNoTarget(ctx, session, roots)
  return found()
}

/**
 * 会话根（执行层那一份）：`session` 有值就问它，拿不到会话就用整份授权列表（旧口径）。
 * 相对路径的基准目录、以及"一个目标都没有"时的档位判定都以它为准（见 needsApproval 头注）。
 */
function sessionRootsOf(
  ctx: ToolContext,
  session: string | undefined,
  all: readonly Workspace[]
): readonly Workspace[] {
  return session === undefined ? all : workspaceRoots(ctx, session)
}

/** 入参里的目标字段（见头注：path / to / save_to；`cwd` 单独走，它还要当相对路径的基准） */
function declaredTargetsOf(input: unknown): string[] {
  const targets: string[] = []
  for (const key of ['path', 'to', 'save_to']) {
    const value = stringField(input, key)
    if (value !== null) targets.push(value)
  }
  return targets
}

/** 入参里某个字段的非空字符串值（不是字符串 / 空串 / 缺省都是 null） */
function stringField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 一个目标串 → 它落在哪个工作区（`null` = 证明不了在工作区内：绝对路径在工作区外、
 * `~`/`$VAR`、相对路径又没有基准目录）。
 * `base` 是相对路径的解析基准（见头注"基准目录"）；绝对路径不看它。
 */
function zoneOfToken(
  roots: readonly Workspace[],
  raw: string,
  base: string | null
): Workspace | null {
  const token = raw.trim()
  if (token === '' || /^[~$%]/.test(token)) return null
  const candidate = isAbsolute(token) ? token : base === null ? null : resolve(base, token)
  if (candidate === null) return null
  for (const workspace of roots) {
    if (resolveInsideWorkspace(workspace.path, candidate).ok) return workspace
  }
  return null
}

/**
 * 一个可判定的目标都没有时（`echo hi` / MCP 的只读检索 / 没有 path 的写类）：执行层的根 = 会话根，
 * 所以按**会话根**判 —— 单根 full → 免审、单根 ask → 走规则、多根全 full → 免审，其余（混合档、
 * 没有任何工作区）按**区外档**（说不清执行会落哪，保守方向）。
 */
function zoneOfNoTarget(
  ctx: ToolContext,
  session: string | undefined,
  roots: readonly Workspace[]
): ZoneVerdict {
  const sessionRoots = sessionRootsOf(ctx, session, roots)
  if (sessionRoots.length === 1) {
    return {
      zone: sessionRoots[0].mode === 'full' ? 'full' : 'inside',
      workspaces: [sessionRoots[0]],
      unresolvedTarget: false
    }
  }
  if (sessionRoots.length > 1 && sessionRoots.every((workspace) => workspace.mode === 'full')) {
    return { zone: 'full', workspaces: [], unresolvedTarget: false }
  }
  return OUTSIDE
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
