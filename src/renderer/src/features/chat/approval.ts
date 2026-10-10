/**
 * 审批 part 的读取与记忆（T13）。
 *
 * 三个纯函数 + 一份模块级内存：
 *   1. `approvalRequestOf` / `pendingApprovals` / `hasPendingApproval`：从 AI SDK 的 tool part
 *      里认出"正在等审批"的调用（`state='approval-requested'` + `approval.id`）；
 *   2. `resolveApprovalWorkspace`：按渲染端那份设置判这次调用落在哪个工作区 —— 只用于
 *      审批记忆的粒度（工具 + 工作区）与"永久允许"写哪条规则，**不是安全边界**（边界在
 *      服务端 guard：路径只认引擎归一后的 abs）；
 *   3. 会话记忆（"本会话允许"）：模块级 Set，应用退出即清空；粒度 = 工具 + 工作区。
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
 * 会话记忆（"本会话允许"）：粒度 = 工具 + 工作区。
 * 只活在当前渲染进程里（重启应用即清空），不落盘、不过桥 —— 这是"这次先放过它"的语义。
 * 工作区必须明确（审批卡只在判得出工作区时才给这两个记忆入口）：判不出工作区的放行范围
 * 说不清，那种调用只给"允许一次 / 拒绝"。
 */
const sessionAllowed = new Set<string>()

function sessionKey(tool: string, workspace: string): string {
  return `${normalizeToolName(tool)}\u0000${normalizeWorkspacePath(workspace)}`
}

/** 记下"本会话允许"（用户在审批卡上点的那一下） */
export function allowForSession(tool: string, workspace: string): void {
  sessionAllowed.add(sessionKey(tool, workspace))
}

/** 本次会话里这个工具在这个工作区是否已被放行（命中就自动批准，不再打扰用户） */
export function isAllowedForSession(tool: string, workspace: string): boolean {
  return sessionAllowed.has(sessionKey(tool, workspace))
}

/** 测试用：清空会话记忆（模块级状态不随 render 重置） */
export function resetSessionApprovals(): void {
  sessionAllowed.clear()
}
