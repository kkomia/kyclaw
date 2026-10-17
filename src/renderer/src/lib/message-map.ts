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
 * 时间（round 59；0.1.3 / 008 扩了来源）：存储的 part 上带 `createdAt`（epoch ms，T9 实机探查确认），
 * 这里取该消息各 part 的**最大值**；0.1.3 起**优先**读 `content.metadata.kyclawSentAt`（发送时渲染端
 * 写的**自有键**：实测原样落库，含带 image file part 的消息；`metadata.createdAt` 那条惯例槽会被
 * Mastra 的 v5 UI 消息适配路径剔掉，所以不靠它当唯一来源），再兜底 `createdAt` 惯例槽、part 最大值、
 * 顶层 `createdAt` —— 挂成 UIMessage 的 `metadata.createdAt`（**数字**，语义 = 这条消息的时间锚点）：
 * 压缩分界线按"压缩时刻之后的第一条消息"定位（见 features/chat/compaction-line.ts），
 * 气泡的发送时间（008 返工后的裸文字）也读它。
 *
 * 精确发送时刻另挂一份（同一份 metadata 的 `kyclawSentAt`，原值透传）：`readSentAt` 用它区分
 * "发送那一刻"与"记录时间"，气泡文案因此不会把落库时刻说成发送时刻（见 features/chat/message-context）。
 * 全认不出来才不挂对应字段（未知 ≠ 现在）。
 *
 * 展示上下文（0.1.3 / 006）：存储 `content.metadata.kyclawContext`（写侧见 features/chat/composer-attachments
 * 与 features/chat/message-context）经**严格校验**后挂到 UI 消息的 metadata 上；不合规/没有就不挂
 * （气泡因此按原文显示 —— 展示层只信这一份，见 features/chat/message-context 的 resolveUserDisplay）。
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
import { MESSAGE_CONTEXT_KEY, readMessageContext, SENT_AT_KEY } from '@shared/message-context'

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
    case 'data-tool-call-suspended':
      return isRecord(part.data) ? { type: 'data-tool-call-suspended', data: part.data } : null
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

/** 存储消息顶层的 createdAt（recall 在进程内是 Date，过 HTTP 是 ISO 串）—— 认得出才算 */
function storedCreatedAt(message: unknown): number | null {
  if (!isRecord(message)) return null
  return timeValue(message.createdAt)
}

/** 一个时间值 → epoch ms（Date / ISO 串 / 正数毫秒都认；别的一律 null） */
function timeValue(value: unknown): number | null {
  if (value instanceof Date) {
    const at = value.getTime()
    return Number.isFinite(at) ? at : null
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value === 'string') {
    const at = Date.parse(value)
    return Number.isNaN(at) ? null : at
  }
  return null
}

/**
 * 消息时间（epoch ms，挂到 UIMessage 的 `metadata.createdAt`）——**按准头排序的来源**：
 *
 *   1. `content.metadata.kyclawSentAt`：**我们自己写的那一份发送时刻**（0.1.3 / 008 复核后立的自有键，
 *      实测原样落库、原样读回，含带 file part 的消息 —— 见 message-context-wire.spec.ts）。
 *      这里取出的是**数字锚点**（epoch ms，分界线与发送时间都读它）；**精确发送时刻**另有
 *      `metadata.kyclawSentAt` 原值透传（读侧 `readSentAt` 认它）；
 *   2. `content.metadata.createdAt`：同一份时刻的惯例槽（v5 UI 消息适配路径会剔掉它，所以排在自有键后）；
 *   3. 各 part 的 `createdAt` 最大值（round 59 的既有口径）：老消息（本功能之前发的）与助手消息
 *      的时间来源，是存储自己落的时刻；
 *   4. 存储消息顶层的 `createdAt`：前几者都没有时的兜底（也是存储自己落的时刻）。
 *
 * 都认不出来才回 null（**未知 ≠ 现在**：分界线按"不早于压缩"处理、气泡不画时间）。
 */
function messageTime(message: unknown, content: unknown): number | null {
  const contentMetadata = isRecord(content) ? content.metadata : undefined
  if (isRecord(contentMetadata)) {
    const recorded = timeValue(contentMetadata[SENT_AT_KEY]) ?? timeValue(contentMetadata.createdAt)
    if (recorded !== null) return recorded
  }
  return messageCreatedAt(content) ?? storedCreatedAt(message)
}

/** 存储消息的 content.metadata（0.1.3 / 006：展示上下文在里面；读侧照 @shared 的严格校验采信） */
function storedMetadata(content: unknown): Record<string, unknown> | undefined {
  if (!isRecord(content)) return undefined
  const metadata = content.metadata
  return isRecord(metadata) ? metadata : undefined
}

/**
 * 存储里的**精确发送时刻**（`content.metadata.kyclawSentAt`）：认得出才透传（原值，通常是 ISO 串）。
 * 读侧（`readSentAt`）据此区分"发送那一刻"与"存储落库的记录时间"，气泡的发送时间文案也不同。
 */
function storedSentAt(content: unknown): unknown {
  const metadata = storedMetadata(content)
  if (metadata === undefined) return null
  const value = metadata[SENT_AT_KEY]
  return timeValue(value) === null ? null : value
}

/**
 * 存储消息数组 → UI 消息数组（只保留 user/assistant；system/signal 不上屏）。
 * 纯函数、无副作用：存储里有什么就映射什么，坏数据跳过而不是抛。
 * 挂起审批（metadata.pendingToolApprovals）在每条消息内先解析出来，供该消息的
 * `call` 态工具调用回放成 `approval-requested`（重开后审批卡恢复可见）。
 *
 * 时间（round 59；0.1.3 / 008 扩了来源）：`metadata.createdAt` 是**数字**的时间锚点（来源按准头
 * 排序，见 messageTime）；`content.metadata.kyclawSentAt` 存在时另挂一份原值的 `metadata.kyclawSentAt`
 * （**精确发送时刻**，`readSentAt` 认它）。压缩分界线只吃数字那一个（features/chat/compaction-line.ts
 * 的 `messageCreatedAtOf` 仍是"只认数"的口径，ISO 串不会混进去）。
 *
 * 展示上下文（0.1.3 / 006）：存储 `content.metadata.kyclawContext` 经严格校验后原样挂到
 * `metadata.kyclawContext`（不合规 = 不挂：气泡按原文显示）。它只影响展示，不影响 parts。
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
    const createdAt = messageTime(message, content)
    const context = readMessageContext(storedMetadata(content))
    const sentAt = storedSentAt(content)

    messages.push({
      id: message.id,
      role: message.role,
      parts,
      ...(createdAt === null && context === null && sentAt === null
        ? {}
        : {
            metadata: {
              ...(createdAt === null ? {} : { createdAt }),
              ...(sentAt === null ? {} : { [SENT_AT_KEY]: sentAt }),
              ...(context === null ? {} : { [MESSAGE_CONTEXT_KEY]: context })
            }
          })
    })
  }

  return messages
}
