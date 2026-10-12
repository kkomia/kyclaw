/**
 * 历史回灌（T9）：Mastra 存储消息 → AI SDK（v7）UI 消息。
 *
 * 输入是 `GET /api/threads/:id/messages` 回来的存储 JSON（`content.format = 2`、parts 数组），
 * 输出直接喂给 `Chat`（初值 `messages`）与 MessageList。
 *
 * 存储 parts 是 AI SDK v4 UI part 的形状（T9 实机探查确认，也和 @mastra/core 的
 * `MastraToolInvocationPart` 类型一致），这里逐 part 做 v4 → v7 的翻译：
 *   - text        原样
 *   - reasoning   { reasoning } → { text }
 *   - tool-invocation → `tool-<name>`（状态机：partial-call → input-streaming、
 *                     call → input-available、result → output-available/output-error）
 *   - file        v4 { mimeType, data } → v7 { mediaType, url: dataURL }
 *   - step-start  原样（UI 不渲染，保留结构给后续工具卡/审批用）
 *
 * 这是**在解析持久化数据**，不是解析自己的稳定契约：一律防御式处理——
 * 认不出的 part 跳过、坏工具调用跳过、content 不是 parts 结构就当空消息，
 * 绝不让一条脏存储数据把整个会话回灌炸掉。
 *
 * 时间（round 59）：存储的 part 上带 `createdAt`（epoch ms，T9 实机探查确认），这里取该消息各 part
 * 的**最大值**挂成 UIMessage 的 `metadata.createdAt` —— 压缩分界线要按"压缩时刻之后的第一条消息"
 * 定位（见 features/chat/compaction-line.ts）。一个 part 都没时间就不挂这个字段（未知 ≠ 现在）。
 *
 * 审批态（T13）：
 *   - `state='output-denied'`（用户拒绝）→ 按"已拒绝"回放（工具卡显示红签，不再误报"调用中"）；
 *   - `state='call'` 且消息 metadata 里有 `pendingToolApprovals` 登记（服务端挂起等审批）→
 *     **按 `approval-requested` 回放**并复原审批 id（`<runId>::<toolCallId>`，与服务端
 *     `extractV6NativeApprovals` 的解析口径一致）—— 重开会话/重启应用后审批卡能重新出现，
 *     批准即从 `mastra_workflow_snapshot` 里的快照续跑（round28 实测：快照与审批都在库里，
 *     不是"随进程内存消失"）；
 *   - `state='call'` 但没有挂起登记（跑挂了/没落盘的半截）→ 仍按"进行中"回放（不冒充可审批）。
 */
import type { UIMessage } from 'ai'
import type { StoredMessage } from '@shared/threads'

type Part = UIMessage['parts'][number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 工具调用（存储形态：v4 的 toolInvocation） */
function toolErrorText(invocation: Record<string, unknown>): string {
  const errorText = invocation.errorText
  if (typeof errorText === 'string' && errorText !== '') return errorText
  const result = invocation.result
  if (typeof result === 'string' && result !== '') return result
  if (result !== undefined) {
    try {
      return JSON.stringify(result)
    } catch {
      /* 循环引用之类：落到下面的兜底文案 */
    }
  }
  return '工具执行失败'
}

/** 存储里的 approval 对象（Mastra 把 v7 客户端回灌的那份原样存下来：{id, approved, reason?}） */
function approvalOf(invocation: Record<string, unknown>): Record<string, unknown> | null {
  const approval = invocation.approval
  if (!isRecord(approval)) return null
  const id = approval.id
  if (typeof id !== 'string' || id === '') return null
  return approval
}

/** 存储消息里在案的挂起审批（content.metadata.pendingToolApprovals：toolCallId → 审批登记） */
interface PendingApprovalRef {
  runId: string
  toolCallId: string
}

/** 解析挂起审批登记；结构不认识/半截就跳过（防御式：脏数据不把整条消息带崩） */
function pendingApprovalsOf(content: unknown): Map<string, PendingApprovalRef> {
  const result = new Map<string, PendingApprovalRef>()
  if (!isRecord(content)) return result
  const metadata = content.metadata
  if (!isRecord(metadata)) return result
  const pending = metadata.pendingToolApprovals
  if (!isRecord(pending)) return result

  for (const [key, value] of Object.entries(pending)) {
    if (!isRecord(value)) continue
    const runId = value.runId
    if (typeof runId !== 'string' || runId === '') continue
    const toolCallId =
      typeof value.toolCallId === 'string' && value.toolCallId !== '' ? value.toolCallId : key
    if (toolCallId === '') continue
    result.set(toolCallId, { runId, toolCallId })
  }
  return result
}

function mapToolPart(
  part: Record<string, unknown>,
  approvals: Map<string, PendingApprovalRef>
): Part | null {
  const invocation = part.toolInvocation
  if (!isRecord(invocation)) return null
  const toolCallId = invocation.toolCallId
  const toolName = invocation.toolName
  if (typeof toolCallId !== 'string' || toolCallId === '') return null
  if (typeof toolName !== 'string' || toolName === '') return null

  const type = `tool-${toolName}` as `tool-${string}`
  const input = invocation.args

  switch (invocation.state) {
    case 'partial-call':
      return { type, toolCallId, state: 'input-streaming', input }
    case 'call': {
      // 服务端挂起等审批（metadata 有登记）→ 回放成可审批态（审批 id 与服务端口径一致：
      // `extractV6NativeApprovals` 取 id 里最后一个 `::` 的左右两段做 runId/toolCallId）
      const pending = approvals.get(toolCallId)
      if (pending !== undefined) {
        return {
          type,
          toolCallId,
          state: 'approval-requested',
          input,
          approval: { id: `${pending.runId}::${pending.toolCallId}` }
        } as Part
      }
      return { type, toolCallId, state: 'input-available', input }
    }
    case 'output-denied': {
      // 用户拒绝了这次调用：回放成"已拒绝"（带 approval，形状与 v7 客户端一致；缺 id 用 toolCallId 兜底）
      const approval = approvalOf(invocation)
      return {
        type,
        toolCallId,
        state: 'output-denied',
        input,
        approval: { ...(approval ?? {}), id: approval?.id ?? toolCallId, approved: false }
      } as Part
    }
    case 'output-error':
      return {
        type,
        toolCallId,
        state: 'output-error',
        input,
        errorText: toolErrorText(invocation)
      }
    case 'result':
      if (invocation.isError === true) {
        return {
          type,
          toolCallId,
          state: 'output-error',
          input,
          errorText: toolErrorText(invocation)
        }
      }
      return { type, toolCallId, state: 'output-available', input, output: invocation.result }
    default:
      // 未知态：按"进行中"回放（猜不出来的一律不冒充完成）
      return { type, toolCallId, state: 'input-available', input }
  }
}

/** v4 文件 part（{ mimeType, data }）→ v7（{ mediaType, url }） */
function mapFilePart(part: Record<string, unknown>): Part | null {
  const mimeType = part.mimeType
  const data = part.data
  if (typeof mimeType !== 'string' || mimeType === '' || typeof data !== 'string' || data === '') {
    return null
  }
  const url = data.startsWith('data:') ? data : `data:${mimeType};base64,${data}`
  return { type: 'file', mediaType: mimeType, url }
}

function mapPart(part: unknown, approvals: Map<string, PendingApprovalRef>): Part | null {
  if (!isRecord(part)) return null

  switch (part.type) {
    case 'text': {
      const text = part.text
      return typeof text === 'string' && text !== '' ? { type: 'text', text } : null
    }
    case 'reasoning': {
      const reasoning = part.reasoning
      return typeof reasoning === 'string' && reasoning !== ''
        ? { type: 'reasoning', text: reasoning }
        : null
    }
    case 'tool-invocation':
      return mapToolPart(part, approvals)
    case 'file':
      return mapFilePart(part)
    case 'step-start':
      return { type: 'step-start' }
    default:
      return null
  }
}

/** 存储 part 上的 createdAt（epoch ms）—— 认数才是数，别的一律当没有 */
function partCreatedAt(part: unknown): number | null {
  if (!isRecord(part)) return null
  const createdAt = part.createdAt
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null
}

/** 一条存储消息的时间：各 part 的 createdAt 取最大（一条消息的多个 part 是同一时刻前后落下） */
function messageCreatedAt(content: unknown): number | null {
  if (!isRecord(content) || !Array.isArray(content.parts)) return null
  let latest: number | null = null
  for (const part of content.parts) {
    const createdAt = partCreatedAt(part)
    if (createdAt === null) continue
    if (latest === null || createdAt > latest) latest = createdAt
  }
  return latest
}

/**
 * 存储消息数组 → UI 消息数组（只保留 user/assistant；system/signal 不上屏）。
 * 纯函数、无副作用：存储里有什么就映射什么，坏数据跳过而不是抛。
 * 挂起审批（metadata.pendingToolApprovals）在每条消息内先解析出来，供该消息的
 * `call` 态工具调用回放成 `approval-requested`（重开后审批卡恢复可见）。
 * round 59：消息时间挂到 `metadata.createdAt`（压缩分界线的定位锚点）。
 */
export function mapStoredMessages(stored: readonly StoredMessage[]): UIMessage[] {
  const messages: UIMessage[] = []

  for (const message of stored) {
    if (message.role !== 'user' && message.role !== 'assistant') continue

    const content = message.content
    const approvals = pendingApprovalsOf(content)
    const parts =
      isRecord(content) && Array.isArray(content.parts)
        ? content.parts.flatMap((part) => {
            const mapped = mapPart(part, approvals)
            return mapped === null ? [] : [mapped]
          })
        : []
    const createdAt = messageCreatedAt(content)

    messages.push({
      id: message.id,
      role: message.role,
      parts,
      ...(createdAt === null ? {} : { metadata: { createdAt } })
    })
  }

  return messages
}
