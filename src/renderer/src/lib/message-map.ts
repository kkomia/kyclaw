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
 * 审批态（T13）：T11 的审批流会把工具调用以 `state='output-denied'`（拒绝）或
 * `state='call'`（还在等审批）存进库 —— 前者按"已拒绝"回放（工具卡显示红签，不再误报"调用中"），
 * 后者仍按"进行中"回放（重启后那次挂起的审批已经作废：审批 id 与快照都随进程内存消失，
 * 用户要重新发起，见 task-13 报告"疑虑"）。
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

function mapToolPart(part: Record<string, unknown>): Part | null {
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
    case 'call':
      return { type, toolCallId, state: 'input-available', input }
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

function mapPart(part: unknown): Part | null {
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
      return mapToolPart(part)
    case 'file':
      return mapFilePart(part)
    case 'step-start':
      return { type: 'step-start' }
    default:
      return null
  }
}

/**
 * 存储消息数组 → UI 消息数组（只保留 user/assistant；system/signal 不上屏）。
 * 纯函数、无副作用：存储里有什么就映射什么，坏数据跳过而不是抛。
 */
export function mapStoredMessages(stored: readonly StoredMessage[]): UIMessage[] {
  const messages: UIMessage[] = []

  for (const message of stored) {
    if (message.role !== 'user' && message.role !== 'assistant') continue

    const content = message.content
    const parts =
      isRecord(content) && Array.isArray(content.parts)
        ? content.parts.flatMap((part) => {
            const mapped = mapPart(part)
            return mapped === null ? [] : [mapped]
          })
        : []

    messages.push({ id: message.id, role: message.role, parts })
  }

  return messages
}
