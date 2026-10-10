/**
 * 审批 part 的读取与记忆（T13）。
 *
 * 三个纯函数 + 一份模块级内存：
 *   1. `approvalRequestOf` / `pendingApprovals` / `hasPendingApproval`：从 AI SDK 的 tool part
 *      里认出"正在等审批"的调用（`state='approval-requested'` + `approval.id`）；
 *   2. `resolveApprovalWorkspace`：按渲染端那份设置判这次调用落在哪个工作区 —— 只用于
 *      审批记忆的粒度（工具 + 工作区）与"永久允许"写哪条规则，**不是安全边界**（边界在
 *      服务端 guard：路径只认引擎归一后的 abs）；
 *   3. 会话记忆（"本会话允许"）：模块级 Set，应用退出即清空；粒度 = **对话（thread）+ 工具 + 工作区**。
 *
 * 工作区判定与工具名归一都走 shared/permissions 的同一把尺，和服务端的规则匹配保持一致。
 */
import type { Workspace } from '@shared/settings'
import { normalizeToolName, normalizeWorkspacePath } from '@shared/permissions'

/** 一次待审批的工具调用（从 tool part 里抽出来的最小信息） */
export interface ApprovalRequest {
  /** 服务端给的审批 id（T11 口径：`runId::toolCallId`）；回灌时原样交回 */
  approvalId: string
  toolCallId: string
  toolName: string
  input: unknown
  /** 入参里的目标路径（write/edit 等有 path 的工具）；没有就是 null */
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

/** 入参里的目标路径（模型给的是原始串：可能是绝对路径，也可能是相对工作区的相对路径） */
export function approvalPath(input: unknown): string | null {
  if (!isRecord(input)) return null
  const path = input.path
  return typeof path === 'string' && path !== '' ? path : null
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
 * 规则与 AI SDK 内置那份逐字对齐：只看**最后一条助手消息**、只从最后一个 `step-start` 切**最后一步**、
 * 要求这一步里**至少一条 approval-responded**、且每个工具 part 都已收束（output-available 非
 * preliminary / output-error / output-denied / approval-responded）。
 *
 * 与内置判定的唯一差别：**先滤掉两类"永远不会在 UI 消息里收束"的 part**——
 *   1. `providerExecuted`：提供方执行的工具，结果不进 UI 消息，客户端本来就不该等它；
 *   2. Mastra 记忆工具（`updateWorkingMemory`）：服务端执行完把结果吞进记忆，UI part 永远
 *      停在 `input-available`。同一步里模型既写记忆又发待审批写工具时，内置判定会因此恒 false，
 *      用户做完决策不会自动续跑（T18 复核 concern② 实测）。
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
      (part.state === 'output-available' && part.preliminary !== true) ||
      part.state === 'output-error' ||
      part.state === 'output-denied' ||
      part.state === 'approval-responded'
  )
}

/**
 * 这次调用落在哪个工作区（渲染端口径，用于审批记忆粒度）：
 *   - 绝对路径（含盘符 / 根路径 / UNC）：按前缀找那个包含它的工作区；找不到回 null；
 *   - 相对路径：**第一个工作区** —— 与服务的 resolveTarget 同一顺序（相对路径在任何
 *     工作区根下都能解出，服务端也是按列表顺序取第一个）；
 *   - 判不出（没有 path / 没有工作区）回 null。判不出时不给"永久允许"入口（保守）。
 */
export function resolveApprovalWorkspace(
  input: unknown,
  workspaces: readonly Workspace[]
): string | null {
  const path = approvalPath(input)
  if (path === null || workspaces.length === 0) return null

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
 * 工作区必须明确（审批卡只在判得出工作区时才给这两个记忆入口）：判不出工作区的放行范围
 * 说不清，那种调用只给"允许一次 / 拒绝"。
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
