/**
 * 会话事件 → **现有 UI 形状**的投影（B2 骨架，不接真内核、不改现有 chat 行为）。
 *
 * 形状对齐：`{ id, role, parts }`，文本 part 是 `{type:'text', text}`，工具 part 是
 * `{type:'tool-invocation', toolInvocation:{…}}`——与 renderer 现在的消息 part 同构，
 * 因此将来 adapter 只换数据源、不用改渲染组件。
 *
 * `surfaceOp.replace` 语义：把 `[startSeq, endSeq]`（端点含边界）这段事件从投影里**剔除**，
 * 当前事件取代它。fake kernel 用它模拟"片段 → 最终消息"的替换（内核真实语义）。
 */
import type { ContentPart, SessionEvent, TurnEndReason, UsageSnapshot } from './types'

export interface UiTextPart {
  type: 'text'
  text: string
}

export interface UiToolInvocationPart {
  type: 'tool-invocation'
  toolInvocation: {
    toolCallId: string
    toolName: string
    args: unknown
    state: 'call' | 'result'
    result?: unknown
  }
}

export type UiPart = UiTextPart | UiToolInvocationPart

export interface UiChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: UiPart[]
}

export interface ProjectedSession {
  messages: UiChatMessage[]
  finalText: string
  usage?: UsageSnapshot
  turnEnd?: TurnEndReason
}

function partsOf(parts: readonly ContentPart[]): UiPart[] {
  return parts.flatMap((part): UiPart[] => {
    if (part.type === 'text') return part.text === '' ? [] : [{ type: 'text', text: part.text }]
    if (part.type === 'tool-call')
      return [
        {
          type: 'tool-invocation',
          toolInvocation: {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
            state: 'call'
          }
        }
      ]
    return [
      {
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: null,
          state: 'result',
          result: part.result
        }
      }
    ]
  })
}

/** 应用 surfaceOp.replace：返回按 seq 过滤后的事件（保留顺序） */
export function applySurfaceOps(events: readonly SessionEvent[]): SessionEvent[] {
  const dropped = new Set<number>()
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.surfaceOp === undefined) continue
    const { startSeq, endSeq } = event.surfaceOp
    for (const inner of events) {
      if (inner.seq >= startSeq && inner.seq <= endSeq && inner.seq !== event.seq)
        dropped.add(inner.seq)
    }
  }
  return events.filter((event) => !dropped.has(event.seq))
}

export function projectSessionEvents(events: readonly SessionEvent[]): ProjectedSession {
  const kept = applySurfaceOps(events)
  const messages: UiChatMessage[] = []
  const byId = new Map<string, UiChatMessage>()
  let finalText = ''
  let usage: UsageSnapshot | undefined
  let turnEnd: TurnEndReason | undefined

  const ensureAssistant = (id: string): UiChatMessage => {
    const existing = byId.get(id)
    if (existing !== undefined) return existing
    const created: UiChatMessage = { id, role: 'assistant', parts: [] }
    byId.set(id, created)
    messages.push(created)
    return created
  }

  for (const event of kept) {
    if (event.type === 'user/message') {
      const message: UiChatMessage = {
        id: event.message.id,
        role: 'user',
        parts: partsOf(event.message.parts)
      }
      messages.push(message)
      byId.set(message.id, message)
      continue
    }
    if (event.type === 'assistant/message') {
      const message = ensureAssistant(event.message.id)
      message.parts = partsOf(event.message.parts)
      const text = event.message.parts.flatMap((part) =>
        part.type === 'text' && part.text !== '' ? [part.text] : []
      )
      if (text.length > 0) finalText = text.join('')
      continue
    }
    if (event.type === 'tool/call') {
      // 工具事件归到最近一条 assistant 消息（没有就新建一条）
      const last = messages.at(-1)
      const target =
        last?.role === 'assistant' ? last : ensureAssistant(`assistant-tools-${event.toolCallId}`)
      target.parts.push({
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          state: 'call'
        }
      })
      continue
    }
    if (event.type === 'tool/result') {
      for (const message of messages) {
        const part = message.parts.find(
          (candidate): candidate is UiToolInvocationPart =>
            candidate.type === 'tool-invocation' &&
            candidate.toolInvocation.toolCallId === event.toolCallId
        )
        if (part === undefined) continue
        part.toolInvocation.state = 'result'
        part.toolInvocation.result = event.result
        break
      }
      continue
    }
    if (event.type === 'turn/end') {
      turnEnd = event.reason
      if (event.usage !== undefined) usage = event.usage
    }
  }

  return {
    messages,
    finalText,
    ...(usage === undefined ? {} : { usage }),
    ...(turnEnd === undefined ? {} : { turnEnd })
  }
}
