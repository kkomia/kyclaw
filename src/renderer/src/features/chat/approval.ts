/**
 * 审批 part 的读取与记忆（T13）。
 *
 * 四个纯函数 + 一份模块级内存：
 *   1. `approvalRequestOf` / `pendingApprovals` / `hasPendingApproval`：从 AI SDK 的 tool part
 *      里认出"正在等审批"的调用（`state='approval-requested'` + `approval.id`）；
 *   2. `resolveApprovalWorkspace`：按渲染端那份设置判这次调用落在哪个工作区 —— 只用于
 *      审批记忆的粒度（工具 + 工作区）与"永久允许"写哪条规则，**不是安全边界**（边界在
 *      服务端 guard：路径只认引擎归一后的 abs）。round28：目标字段按工具身份取
 *      （bash=cwd、fetch=save_to、其余=path，与服务端 guard 的能力类口径一致）；能力类工具
 *      没给显式目标时只有授权列表恰好一条才绑得上（多工作区判不出 → 不给记忆入口，保守方向）；
 *      危险档（delete/move，永远问、不吃规则）由 `isDangerousTool` 拦下，不给记忆入口；
 *   3. `approvalDetailOf`：审批卡上"这次在批什么"的正文（bash 命令 / fetch URL / move 目标）；
 *   4. 会话记忆（"本会话允许"）：模块级 Set，应用退出即清空；粒度 = **对话（thread）+ 工具 + 工作区**。
 *
 * 工作区判定与工具名归一都走 shared/permissions 的同一把尺，和服务端的规则匹配保持一致。
 */
import type { Workspace } from '@shared/settings'
import { normalizeToolName, normalizeWorkspacePath, toolBasename } from '@shared/permissions'

/** 一次待审批的工具调用（从 tool part 里抽出来的最小信息） */
export interface ApprovalRequest {
  /** 服务端给的审批 id（T11 口径：`runId::toolCallId`）；回灌时原样交回 */
  approvalId: string
  toolCallId: string
  toolName: string
  input: unknown
  /**
   * 入参里的目标（展示用）：path 优先，没有就依次看 cwd（bash）、save_to（fetch）；
   * 都没有就是 null。工作区判定另走 resolveApprovalWorkspace（按工具身份取字段）。
   */
  path: string | null
}

/** 结构化读 part：只认必要的几个字段，避免把 AI SDK 的宽泛类型带进来 */
type PartLike = {
  type?: unknown
  toolCallId?: unknown
  toolName?: unknown
  state?: unknown
  input?: unknown
  approval?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 入参里的"目标"（卡片展示 + 审批记忆判定共用；模型给的是原始串，可能是绝对路径也可能是
 * 相对工作区的相对路径）：
 *   - 没给工具名（展示兜底）：`path → cwd → save_to` 依次取第一个非空字符串；
 *   - 给了工具名：按服务端 guard.needsApproval 的能力类口径**只认该工具的字段** ——
 *     bash=cwd、fetch=save_to、其余（含 git / 内置文件工具 / MCP）=path。字段拿不准就不猜：
 *     猜出来的目标会造出一条服务端永不生效的"永久允许"规则（round28）。
 */
export function approvalPath(input: unknown, toolName?: string): string | null {
  if (!isRecord(input)) return null
  const capability = toolName === undefined ? null : capabilityToolOf(toolName)
  const keys: readonly string[] =
    toolName === undefined
      ? ['path', 'cwd', 'save_to']
      : capability === 'shell'
        ? ['cwd']
        : capability === 'network'
          ? ['save_to']
          : ['path']
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * 能力类工具（整名；镜像 `src/mastra/tools/guard.ts` 的 capabilityOf —— 渲染端不引主进程
 * 代码，两处口径必须一起改）：bash 的显式目标是 cwd、fetch 是 save_to、git_add/commit 是 path。
 */
export type ApprovalCapability = 'shell' | 'network' | 'git'

export function capabilityToolOf(toolName: string): ApprovalCapability | null {
  switch (normalizeToolName(toolName)) {
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

/**
 * 危险档（delete/move；`mcp__x__delete` 这类末段命中的也算 —— 与 main/permission/classify
 * 同一口径）：服务端**永远问**、Full access 与"永久允许"规则都不生效。审批卡据此隐藏
 * 「本会话允许 / 永久允许」入口 —— 点了只会写一条永不生效的规则。
 */
const DANGEROUS_BASENAMES = new Set(['delete', 'move'])

export function isDangerousTool(toolName: string): boolean {
  return DANGEROUS_BASENAMES.has(toolBasename(toolName))
}

/** 审批卡上"这次在批什么"的正文（diff 之外的多行信息） */
export interface ApprovalDetail {
  kind: 'command' | 'url' | 'move-to'
  text: string
}

/**
 * 认得出就回展示正文：bash → 要执行的命令；fetch → 请求的 URL；move → 目标位置。
 * 只认整名（`mcp__x__bash` 不算我们的 bash）；认不出回 null（卡片退回"只看 path"）。
 */
export function approvalDetailOf(toolName: string, input: unknown): ApprovalDetail | null {
  if (!isRecord(input)) return null
  const name = normalizeToolName(toolName)
  if (name === 'bash' && typeof input.command === 'string' && input.command !== '') {
    return { kind: 'command', text: input.command }
  }
  if (name === 'fetch' && typeof input.url === 'string' && input.url !== '') {
    return { kind: 'url', text: input.url }
  }
  if (name === 'move' && typeof input.to === 'string' && input.to !== '') {
    return { kind: 'move-to', text: input.to }
  }
  return null
}

/** part → 待审批请求；不是"正在等审批"就回 null（已回应/执行完成都不算） */
export function approvalRequestOf(part: unknown): ApprovalRequest | null {
  if (!isRecord(part)) return null
  const candidate = part as PartLike
  if (candidate.state !== 'approval-requested') return null
  if (typeof candidate.approval !== 'object' || candidate.approval === null) return null

  const approval = candidate.approval as { id?: unknown; approved?: unknown }
  const approvalId = approval.id
  if (typeof approvalId !== 'string' || approvalId === '') return null
  // 带 approved 的是"已经回应过"的 part（AI SDK 用同一个 approval 对象表达回应），不算待批
  if (approval.approved !== undefined) return null

  const toolName =
    typeof candidate.toolName === 'string' ? candidate.toolName : toolNameFromType(candidate.type)
  const toolCallId = candidate.toolCallId
  if (toolName === null || typeof toolCallId !== 'string' || toolCallId === '') return null

  return {
    approvalId,
    toolCallId,
    toolName,
    input: candidate.input,
    path: approvalPath(candidate.input)
  }
}

/** 静态工具 part 的 `tool-<name>` 形态（dynamic-tool 用 part.toolName） */
function toolNameFromType(type: unknown): string | null {
  if (typeof type !== 'string' || !type.startsWith('tool-')) return null
  const name = type.slice('tool-'.length)
  return name === '' ? null : name
}

/** 一条消息里所有"正在等审批"的调用（一条消息可能带多个工具调用） */
export function pendingApprovals(message: { parts?: unknown } | undefined): ApprovalRequest[] {
  const parts = message?.parts
  if (!Array.isArray(parts)) return []
  const requests: ApprovalRequest[] = []
  for (const part of parts) {
    const request = approvalRequestOf(part)
    if (request !== null) requests.push(request)
  }
  return requests
}

/** 这条消息结束时还停在那里等审批（挂起轮：不算"完成轮"，见 thread-chats 的 onFinish） */
export function hasPendingApproval(message: { parts?: unknown } | undefined): boolean {
  return pendingApprovals(message).length > 0
}

/**
 * 审批续跑的就绪判定（替代 AI SDK 的 `lastAssistantMessageIsCompleteWithApprovalResponses`）。
 *
 * 规则与 AI SDK 内置那份对齐（只看**最后一条助手消息**、只从最后一个 `step-start` 切**最后一步**、
 * 要求这一步里**至少一条 approval-responded**），但"每个 part 都已收束"这条按本应用的实际形状放宽：
 *
 *   1. `providerExecuted`：提供方执行的工具，结果不进 UI 消息，客户端本来就不该等它（滤掉）；
 *   2. Mastra 记忆工具（`updateWorkingMemory`）：服务端执行完把结果吞进记忆，UI part 永远
 *      停在 `input-available`（滤掉，T18 复核 concern② 实测）；
 *   3. **`input-available` 的兄弟工具**（round28 定位到的真 bug）：同一步里有工具要审批时，
 *      Mastra 挂起前**只发审批请求**——同一步其它"已经执行完"的工具，结果面不会随挂起流发出来
 *      （wire 实测：`tool-input-available(glob)` 之后直接 `tool-approval-request(bash)`，
 *      没有 `tool-output-available(glob)`）。内置判定要求所有 part 收束，于是恒 false、
 *      批准后永不自动续跑（现场：15:42/15:51 两条会话卡死）。这里把 `input-available`
 *      当作"服务端待续跑补上"的状态放行 —— 本应用没有客户端执行的工具，`input-available`
 *      只可能是"服务端还没补结果"，不会出现"等客户端 addToolOutput"的语义；
 *      `input-streaming` / `approval-requested`（还有没回应的审批）仍然不放行。
 * 滤完没有任何可等待的调用 → false：没有"该续跑的审批"，不替用户往前跑。
 */
const MEMORY_TOOL_NAMES = new Set(['updateWorkingMemory'])

interface ResumePartLike {
  type?: unknown
  state?: unknown
  toolName?: unknown
  providerExecuted?: unknown
  preliminary?: unknown
}

function isToolCallPart(part: { type?: unknown }): boolean {
  if (part.type === 'dynamic-tool') return true
  return typeof part.type === 'string' && part.type.startsWith('tool-')
}

function toolNameOfPart(part: ResumePartLike): string | null {
  if (typeof part.toolName === 'string' && part.toolName !== '') return part.toolName
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    return part.type.slice('tool-'.length)
  }
  return null
}

export function canResumeAfterApproval(
  messages: ReadonlyArray<{ role?: unknown; parts?: unknown }>
): boolean {
  const message = messages[messages.length - 1]
  if (message === undefined || message.role !== 'assistant') return false
  const parts: ResumePartLike[] = Array.isArray(message.parts)
    ? (message.parts as ResumePartLike[])
    : []

  let lastStepStartIndex = -1
  parts.forEach((part, index) => {
    if (part.type === 'step-start') lastStepStartIndex = index
  })

  const toolParts = parts
    .slice(lastStepStartIndex + 1)
    .filter(isToolCallPart)
    .filter((part) => part.providerExecuted !== true)
    .filter((part) => {
      const name = toolNameOfPart(part)
      return name === null || !MEMORY_TOOL_NAMES.has(name)
    })
  if (toolParts.length === 0) return false

  const hasResponded = toolParts.some((part) => part.state === 'approval-responded')
  if (!hasResponded) return false

  return toolParts.every(
    (part) =>
      // input-available：挂起时兄弟工具的结果面没发出来（见上面头注第 3 条）——
      // 续跑那轮服务端会把结果补上；本应用没有客户端工具，不会有"等客户端输出"的语义
      part.state === 'input-available' ||
      (part.state === 'output-available' && part.preliminary !== true) ||
      part.state === 'output-error' ||
      part.state === 'output-denied' ||
      part.state === 'approval-responded'
  )
}

/**
 * 这次调用落在哪个工作区（渲染端口径，用于审批记忆粒度）：
 *   - 目标字段按工具身份取（见 approvalPath）；绝对路径按前缀找包含它的工作区，相对路径
 *     归**第一个工作区** —— 与服务的 resolveTarget 同一顺序（相对路径在任何工作区根下都能解出，
 *     服务端也是按列表顺序取第一个）；
 *   - 能力类工具（bash/fetch/git_add/commit）没给显式目标：执行层的根 = 会话根，审批层拿不到
 *     会话 —— 只有授权列表**恰好一条**才绑得上（与服务端 guard.capabilityNeedsApproval 同口径）；
 *     多工作区判不出 → null（不给记忆入口，保守方向）；
 *   - 判不出（没有目标 / 没有工作区）回 null。
 */
export function resolveApprovalWorkspace(
  input: unknown,
  workspaces: readonly Workspace[],
  toolName?: string
): string | null {
  const path = approvalPath(input, toolName)
  if (path === null) {
    const capability = toolName === undefined ? null : capabilityToolOf(toolName)
    if (capability !== null && workspaces.length === 1) return workspaces[0].path
    return null
  }
  if (workspaces.length === 0) return null

  const relative = isRelativePath(path)
  if (relative) return workspaces[0].path

  const normalized = normalizeWorkspacePath(path)
  for (const workspace of workspaces) {
    const root = normalizeWorkspacePath(workspace.path)
    if (root === '') continue
    if (normalized === root || normalized.startsWith(`${root}/`)) return workspace.path
  }
  return null
}

/** 盘符（C:\ / C:/）或 POSIX 根开头的都算绝对路径；其余（含 `..\x`）按相对处理 */
function isRelativePath(path: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  return true
}

/**
 * 会话记忆（"本会话允许"）：粒度 = **对话（thread）+ 工具 + 工作区**。
 * "会话"取 UI 里那个词义（侧栏的会话 = 一个聊天线程，threadId）：用户在某个对话里说
 * "本会话允许"，就只对那个对话里的同类调用不再打扰；换个对话照旧问。
 * 只活在当前渲染进程里（重启应用即清空），不落盘、不过桥 —— 这是"这次先放过它"的语义。
 * 记忆入口只在工作区明确时才给（放行范围说不清的不给）：判不出工作区的、以及危险档
 * （delete/move，服务端永远问、不吃记忆）都只给"允许一次 / 拒绝"。
 */
const sessionAllowed = new Set<string>()

function sessionKey(threadId: string, tool: string, workspace: string): string {
  return `${threadId}\u0000${normalizeToolName(tool)}\u0000${normalizeWorkspacePath(workspace)}`
}

/** 记下"本会话允许"（用户在审批卡上点的那一下） */
export function allowForSession(threadId: string, tool: string, workspace: string): void {
  sessionAllowed.add(sessionKey(threadId, tool, workspace))
}

/** 这个对话里、这个工具在这个工作区是否已被放行（命中就自动批准，不再打扰用户） */
export function isAllowedForSession(threadId: string, tool: string, workspace: string): boolean {
  return sessionAllowed.has(sessionKey(threadId, tool, workspace))
}

/** 测试用：清空会话记忆（模块级状态不随 render 重置） */
export function resetSessionApprovals(): void {
  sessionAllowed.clear()
}
