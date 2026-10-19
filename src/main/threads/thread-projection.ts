/**
 * PB-024：DSH `session/page` 原始事件 → 旧 `/api/threads` 回包形状的纯投影。
 *
 * 关键点（不是按到达顺序猜）：
 * - 只取内核的 **surface** 事件：`user/message` / `assistant/message` / `tool/result`；
 * - `surfaceOp.replace {startSeq,endSeq}` 先把被替换的 surface 节点从序列里拿掉，再放替换节点；
 * - `tool/call` 是仅日志事件，用来给 `tool/result` 补 toolName/args；不直接生成消息；
 * - 旧 `StoredMessage` 的 `content.parts` 用 `tool-invocation` 形状（与 message-map 对齐）。
 *
 * 本模块只做纯函数，不碰 RPC/数据库；router 与 spec 共用它。
 */
import type { StoredMessage, ThreadCompaction, ThreadSummary } from '../../shared/threads'
import type { KernelSessionEventLike, KernelSessionSummary } from '../kernel/kernel-session-ops'

type EventLike = KernelSessionEventLike

const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const VISIBLE_USER_SOURCES = new Set(['user', 'user-question-reply'])

/**
 * PB-034：失败轮的 `turn/end.reason.kind`。`completed`/`stop` 等不算失败。
 * 这三个值都必须能在 reload 后把用户正文找回来（否则失败轮整条消失）。
 */
const FAILURE_TURN_KINDS = new Set(['error', 'aborted', 'interrupted'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .flatMap((part) => {
      if (!isRecord(part)) return []
      return typeof part.text === 'string' ? [part.text] : []
    })
    .join('')
}

function textPart(text: string, createdAt?: number): Record<string, unknown> {
  return { type: 'text', text, ...(createdAt === undefined ? {} : { createdAt }) }
}

function partsOfContent(
  content: unknown,
  createdAt: number | undefined
): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (!isRecord(part)) return []
    if (part.type === 'text' && typeof part.text === 'string') {
      return [textPart(part.text, createdAt)]
    }
    if (part.type === 'reasoning') {
      const reasoning =
        typeof part.reasoning === 'string'
          ? part.reasoning
          : typeof part.text === 'string'
            ? part.text
            : ''
      return reasoning === ''
        ? []
        : [{ type: 'reasoning', reasoning, ...(createdAt === undefined ? {} : { createdAt }) }]
    }
    return []
  })
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return text
  }
}

function seqOf(event: EventLike): number {
  return typeof event.seq === 'number' ? event.seq : -1
}

/**
 * PB-034：`turn/end.reason` → 失败元数据（只取内核真的给了的 code/message，不编字段）。
 * 形状来自 rc.2：`reason: { kind: 'error'|'aborted'|'interrupted', error?: { code, message } }`。
 */
function failureOf(
  data: Record<string, unknown> | null
): { kind: string; code?: string; message?: string } | null {
  const reason = recordOf(data?.reason)
  const kind = typeof reason?.kind === 'string' ? reason.kind : ''
  if (!FAILURE_TURN_KINDS.has(kind)) return null
  const error = recordOf(reason?.error)
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : undefined
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : undefined
  return { kind, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }
}

interface FailureTurn {
  turn: number
  kind: string
  code?: string
  message?: string
  endSeq: number
}

/**
 * PB-034：失败轮补投影。
 *
 * 为什么需要：失败常发生在 DSH 的 `user/message` append **之前**（模型配置/预检错误），
 * 所以持久化 log 里没有 surface 的 user 消息，reload 后整轮消失（Nia `5e3f032`）。
 * 但那一轮的输入仍在 log 里：`agent/inbox/spliced.inserted` 是**完整 message 对象**，
 * 失败原因在 `turn/end.reason`。这里把两者拼回一条 user 正文 + `content.metadata.turnFailure`。
 *
 * 去重口径（Ada 取证 §2.3）：
 * - 该轮已经有**可见** `user/message` → 不补（成功轮/正常落盘的轮）；
 * - 已投影过的 message id 不再补；
 * - 只认 `error` / `aborted` / `interrupted`，`completed` 不算失败；
 * - 不写 `kept` / `tokens` 之类旧 schema 字段（`StoredMessage` 是松结构，但不伪造）。
 */
function projectFailureTurnMessages(
  events: readonly EventLike[],
  surface: readonly EventLike[],
  messages: StoredMessage[],
  seqOfMessage: Map<StoredMessage, number>
): void {
  const seen = new Set(messages.map((message) => message.id))
  const starts = new Map<number, number>()
  const splices: Array<{ seq: number; time?: number; inserted: unknown[] }> = []
  const failures = new Map<number, FailureTurn>()

  for (const event of events) {
    if (typeof event.type !== 'string') continue
    if (event.type === 'turn/start') {
      const data = recordOf(event.data)
      if (typeof data?.turn === 'number') starts.set(data.turn, seqOf(event))
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      const data = recordOf(event.data)
      const inserted = Array.isArray(data?.inserted) ? data.inserted : []
      if (inserted.length > 0) {
        splices.push({
          seq: seqOf(event),
          ...(typeof event.time === 'number' ? { time: event.time } : {}),
          inserted
        })
      }
      continue
    }
    if (event.type === 'turn/end') {
      const data = recordOf(event.data)
      const turn = typeof data?.turn === 'number' ? data.turn : undefined
      if (turn === undefined) continue
      const failure = failureOf(data)
      if (failure === null) continue
      failures.set(turn, { turn, ...failure, endSeq: seqOf(event) })
    }
  }

  /** 给一条已投影的 user 消息挂失败元数据（幂等：已有 turnFailure 就不动） */
  const attachTurnFailure = (message: StoredMessage, failure: FailureTurn): void => {
    const content = recordOf(message.content)
    if (content === null) return
    const metadata = isRecord(content.metadata) ? content.metadata : {}
    if (metadata.turnFailure !== undefined) return
    metadata.turnFailure = {
      turn: failure.turn,
      kind: failure.kind,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.message === undefined ? {} : { message: failure.message })
    }
    content.metadata = metadata
  }

  const inFailureRange = (seq: number | undefined, startSeq: number, endSeq: number): boolean =>
    seq !== undefined && seq > startSeq && seq < endSeq

  for (const failure of [...failures.values()].sort((left, right) => left.endSeq - right.endSeq)) {
    const startSeq = starts.get(failure.turn) ?? Number.NEGATIVE_INFINITY
    /**
     * PB-034 扩展（Nia 真机 `0ca493f`）：真内核的失败轮**总有可见 user/message**（重开后也读得到），
     * 旧规则"该轮有可见 user/message 就什么都不做"会让 `turnFailure` 永远挂不上 ——
     * 消息内 `TurnFailureCard` 在真机上永远不会出现（dock 卡是 live 态，重开即失）。
     * 现在：有可见 user/message → **正文不重复投影，只把元数据挂到该轮最后一条 user 消息上**；
     * 成功轮 / 无 turn/end 的轮不进入这个分支（failures 只收 error/aborted/interrupted）。
     */
    const visibleUserSeqs = surface
      .filter((event) => {
        if (event.type !== 'user/message') return false
        if (!inFailureRange(seqOf(event), startSeq, failure.endSeq)) return false
        const source = recordOf(recordOf(event.data)?.source)
        return VISIBLE_USER_SOURCES.has(typeof source?.kind === 'string' ? source.kind : '')
      })
      .map((event) => seqOf(event))
    if (visibleUserSeqs.length > 0) {
      const lastSeq = visibleUserSeqs[visibleUserSeqs.length - 1]
      const target = [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'user' &&
            inFailureRange(seqOfMessage.get(message), startSeq, failure.endSeq) &&
            (lastSeq === undefined || seqOfMessage.get(message) === lastSeq)
        )
      if (target === undefined) {
        // 兜底：按范围找最后一条（seq 对不上时也不丢元数据）
        const fallback = [...messages]
          .reverse()
          .find(
            (message) =>
              message.role === 'user' &&
              inFailureRange(seqOfMessage.get(message), startSeq, failure.endSeq)
          )
        if (fallback !== undefined) attachTurnFailure(fallback, failure)
      } else {
        attachTurnFailure(target, failure)
      }
      continue
    }

    for (const splice of splices) {
      if (!(splice.seq > startSeq && splice.seq < failure.endSeq)) continue
      for (const raw of splice.inserted) {
        const message = recordOf(raw)
        if (message === null || message.role !== 'user') continue
        const id = typeof message.id === 'string' && message.id !== '' ? message.id : undefined
        if (id === undefined || seen.has(id)) continue
        const parts = partsOfContent(message.content, splice.time)
        if (parts.length === 0) continue
        seen.add(id)
        const projected: StoredMessage = {
          id,
          role: 'user',
          content: {
            format: 2,
            parts,
            metadata: {
              turnFailure: {
                turn: failure.turn,
                kind: failure.kind,
                ...(failure.code === undefined ? {} : { code: failure.code }),
                ...(failure.message === undefined ? {} : { message: failure.message })
              }
            }
          }
        }
        // 按 splice 的 seq 插入回原位（失败轮正文应该在它那一轮的时序位置上）
        const index = messages.findIndex((item) => {
          const itemSeq = seqOfMessage.get(item) ?? Number.POSITIVE_INFINITY
          return itemSeq > splice.seq
        })
        if (index < 0) messages.push(projected)
        else messages.splice(index, 0, projected)
        seqOfMessage.set(projected, splice.seq)
      }
    }
  }
}

/**
 * 应用内核 surface 语义，返回最终的 surface 事件序列（只保留 surface 类型）。
 * 这是 messages 投影唯一允许做 replace 折叠的地方。
 */
export function applySurfaceOps(
  events: readonly KernelSessionEventLike[]
): KernelSessionEventLike[] {
  const surface: KernelSessionEventLike[] = []
  for (const event of [...events].sort((left, right) => seqOf(left) - seqOf(right))) {
    if (typeof event.type !== 'string' || !SURFACE_EVENT_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (isRecord(op) && op.op === 'replace') {
      const start = typeof op.startSeq === 'number' ? op.startSeq : undefined
      const end = typeof op.endSeq === 'number' ? op.endSeq : undefined
      if (start !== undefined && end !== undefined) {
        for (let index = surface.length - 1; index >= 0; index -= 1) {
          const seq = seqOf(surface[index]!)
          if (seq >= start && seq <= end) surface.splice(index, 1)
        }
      }
    }
    surface.push(event)
  }
  return surface
}

/** `session.list` item → 旧侧栏 ThreadSummary（id/title/updatedAt ISO）。 */
export function projectThreadSummary(summary: KernelSessionSummary): ThreadSummary {
  return {
    id: summary.sessionId,
    title: summary.title,
    updatedAt: new Date(summary.updatedAt).toISOString()
  }
}

interface AssistantDraft {
  message: StoredMessage
  parts: Array<Record<string, unknown>>
  key: string
}

/**
 * 原始事件 → 旧 `StoredMessage[]`。
 *
 * 不按帧到达顺序假设：只按 surface 序列语义折叠；assistant 消息与 tool result 按
 * `turn:step` 归并；tool/call（日志事件）只用来补工具名/参数。
 */
export function projectThreadMessages(events: readonly KernelSessionEventLike[]): StoredMessage[] {
  const toolCalls = new Map<string, { toolName: string; args: unknown }>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = recordOf(event.data)
    const callId = typeof data?.callId === 'string' ? data.callId : undefined
    const name = typeof data?.name === 'string' ? data.name : undefined
    if (callId === undefined || name === undefined) continue
    const rawArgs = data?.arguments
    toolCalls.set(callId, {
      toolName: name,
      args: typeof rawArgs === 'string' ? parseMaybeJson(rawArgs) : rawArgs
    })
  }

  const messages: StoredMessage[] = []
  /** 每条投影消息对应的内核 seq（失败轮补投影要按 seq 插回原位） */
  const seqOfMessage = new Map<StoredMessage, number>()
  const assistants = new Map<string, AssistantDraft>()
  const surface = applySurfaceOps(events)

  let currentEventSeq = -1
  const assistantFor = (turn: number, step: number, id?: string): AssistantDraft => {
    const key = `${String(turn)}:${String(step)}`
    const existing = assistants.get(key)
    if (existing !== undefined) {
      if (id !== undefined && id !== '') existing.message.id = id
      return existing
    }
    const draft: AssistantDraft = {
      key,
      parts: [],
      message: {
        id: id === undefined || id === '' ? `assistant-${String(turn)}-${String(step)}` : id,
        role: 'assistant',
        content: { format: 2, parts: [] }
      }
    }
    assistants.set(key, draft)
    messages.push(draft.message)
    seqOfMessage.set(draft.message, currentEventSeq)
    return draft
  }

  for (const event of surface) {
    currentEventSeq = seqOf(event)
    const data = recordOf(event.data)
    if (data === null) continue

    if (event.type === 'user/message') {
      const source = recordOf(data.source)
      const sourceKind = typeof source?.kind === 'string' ? source.kind : ''
      if (!VISIBLE_USER_SOURCES.has(sourceKind)) continue
      const id =
        typeof data.id === 'string' && data.id !== '' ? data.id : `user-${String(event.seq ?? '?')}`
      const parts = partsOfContent(data.content, event.time)
      if (parts.length === 0) continue
      const projected: StoredMessage = {
        id,
        role: 'user',
        content: { format: 2, parts }
      }
      messages.push(projected)
      seqOfMessage.set(projected, seqOf(event))
      continue
    }

    if (event.type === 'assistant/message') {
      const message = recordOf(data.message)
      if (message === null) continue
      const turn = typeof data.turn === 'number' ? data.turn : 0
      const step = typeof data.step === 'number' ? data.step : 0
      const id = typeof message.id === 'string' ? message.id : undefined
      const draft = assistantFor(turn, step, id)
      draft.parts.push(...partsOfContent(message.content, event.time))
      continue
    }

    if (event.type === 'tool/result') {
      const message = recordOf(data.message)
      if (message === null) continue
      const turn = typeof data.turn === 'number' ? data.turn : 0
      const step = typeof data.step === 'number' ? data.step : 0
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      if (callId === undefined) continue
      const call = toolCalls.get(callId)
      if (call === undefined) continue
      const resultText = textOf(message.content)
      const draft = assistantFor(turn, step)
      const invocation: Record<string, unknown> = {
        toolCallId: callId,
        toolName: call.toolName,
        args: call.args,
        state: 'result',
        isError: message.isError === true
      }
      if (message.isError === true) invocation.errorText = resultText
      else invocation.result = parseMaybeJson(resultText)
      draft.parts.push({
        type: 'tool-invocation',
        toolInvocation: invocation,
        ...(event.time === undefined ? {} : { createdAt: event.time })
      })
    }
  }

  // PB-034：失败轮补投影（放在最后：surface 已就绪，去重才有依据）
  projectFailureTurnMessages(events, surface, messages, seqOfMessage)

  for (const draft of assistants.values()) {
    const content = draft.message.content
    if (isRecord(content)) content.parts = draft.parts
    if (draft.parts.length === 0) {
      const index = messages.indexOf(draft.message)
      if (index >= 0) messages.splice(index, 1)
    }
  }
  return messages
}

/**
 * 从 `compaction/summary` 事件派生旧 `ThreadCompaction`。
 *
 * 能派生：summary、shadowedSeqs.length（≈ summarized）、createdAt、level='summary'；
 * 不能派生：tokensBefore/tokensAfter（给 null，UI 显示 —）；kept 用“压缩边界之后的
 * 用户/助手消息数”做只读推算，若事件里没有边界则回 0（不是假装精确，只是“无保留”）。
 */
export function projectThreadCompaction(
  events: readonly KernelSessionEventLike[],
  threadId: string
): ThreadCompaction | null {
  const summaryEvent = [...events]
    .sort((left, right) => seqOf(left) - seqOf(right))
    .reverse()
    .find((event) => event.type === 'compaction/summary')
  if (summaryEvent === undefined) return null
  const data = recordOf(summaryEvent.data)
  if (data === null) return null
  const summary = textOf(data.summary)
  if (summary === '') return null
  const shadowedSeqs = Array.isArray(data.shadowedSeqs)
    ? data.shadowedSeqs.filter((value): value is number => typeof value === 'number')
    : []
  if (shadowedSeqs.length === 0) return null
  // kept：内核没有旧 ThreadCompaction.kept 字段；DSH 路径不猜“保留最近几条”，
  // 统一给 null，由 UI 显示 —（见 shared/threads.ts 的字段注释）。
  const kept = null
  return {
    threadId,
    summary,
    summarized: shadowedSeqs.length,
    kept,
    level: 'summary',
    createdAt: new Date(
      typeof summaryEvent.time === 'number' ? summaryEvent.time : 0
    ).toISOString(),
    tokensBefore: null,
    tokensAfter: null
  }
}
