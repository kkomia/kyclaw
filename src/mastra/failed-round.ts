/**
 * PB-035 C：**失败轮已产生 parts 的持久化 + 下一轮上下文过滤**。
 *
 * 背景（实测，见 `.superpowers/dev-verify/20261019-0.1.6/b2/pb035-persistence.md`）：
 * 流中途失败时，Memory 收尾只写了一条**带 error part** 的 assistant 消息，已产生的正文/工具
 * part 全丢。所以刷新后"之前的东西没了"。用户口径：保留内容再试（B′）必须能跨刷新。
 *
 * 本模块做两件事：
 *   1. `withFailedRoundCapture`：在 chat 的 UI 流上旁路**收集**已产生的 parts（直到流结束/出错），
 *      收尾后等 Memory 落完那条 error 行，再**按同一个 messageId upsert**：合并 parts（原有 error part
 *      保留）+ `metadata.status='failed'`。任何一步失败 → 静默放弃（保持现状，绝不把轮次搞挂）。
 *   2. `createFailedRoundFilter`：下一轮组装上下文时，**过滤掉 failed 的 assistant 消息**；
 *      重试 marker（`metadata.kyclawRetryKeep`）在历史里只保留最后一条（当前触发轮）并把内容
 *      换成中性「继续。」——既不让模型看到"从中断处继续"指着空气，也不删掉最后一条 user 消息
 *      （避免把请求体变成 assistant 结尾）。
 */
import type { InputProcessor } from '@mastra/core/processors'

/** 只用到 recall / saveMessages 两个方法（避免把 Mastra Memory 的完整类型拖进来） */
export interface FailedRoundMemory {
  recall(args: { threadId: string; perPage?: number }): Promise<{ messages: readonly unknown[] }>
  settled?(): Promise<void>
  saveMessages(args: { messages: readonly unknown[] }): Promise<unknown>
}

/** 存储形态的 part（`{format:2}` 的 content.parts 元素） */
interface StoredPart {
  type: string
  [key: string]: unknown
}

interface CaptureState {
  messageId: string | null
  parts: StoredPart[]
  sawFinish: boolean
  sawError: boolean
  errorText: string | null
  /** 进行中的 text / tool 片段 */
  texts: Map<string, string>
  tools: Map<string, StoredPart>
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function errorTextOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  const message = record(raw).message
  return typeof message === 'string' ? message : ''
}

function newState(): CaptureState {
  return {
    messageId: null,
    parts: [],
    sawFinish: false,
    sawError: false,
    errorText: null,
    texts: new Map(),
    tools: new Map()
  }
}

/** 把一条 UI 流 chunk 归纳进 capture（不认识的一律忽略，不影响主流程） */
function observe(state: CaptureState, chunk: unknown): void {
  const item = record(chunk)
  const type = typeof item.type === 'string' ? item.type : ''
  if (type === 'start') {
    if (typeof item.messageId === 'string' && item.messageId !== '')
      state.messageId = item.messageId
    return
  }
  if (type === 'finish') {
    state.sawFinish = true
    return
  }
  if (type === 'error') {
    state.sawError = true
    state.errorText = errorTextOf(item.errorText)
    return
  }
  if (type === 'text-start') {
    if (typeof item.id === 'string') state.texts.set(item.id, '')
    return
  }
  if (type === 'text-delta') {
    const id = typeof item.id === 'string' ? item.id : ''
    if (id !== '') state.texts.set(id, `${state.texts.get(id) ?? ''}${String(item.delta ?? '')}`)
    return
  }
  if (type === 'text-end') {
    const id = typeof item.id === 'string' ? item.id : ''
    const text = state.texts.get(id) ?? ''
    if (id !== '') state.texts.delete(id)
    if (text !== '')
      state.parts.push({ type: 'text', text, createdAt: Date.now() })
    return
  }
  if (type === 'tool-input-available' || type === 'tool-call') {
    const toolCallId = String(item.toolCallId ?? item.id ?? '')
    if (toolCallId === '') return
    const toolName = String(item.toolName ?? '')
    const args = item.input ?? item.args ?? null
    const part: StoredPart = {
      type: 'tool-invocation',
      toolInvocation: { toolCallId, toolName, args, state: 'call' }
    }
    state.tools.set(toolCallId, part)
    state.parts.push(part)
    return
  }
  if (type === 'tool-output-available' || type === 'tool-result') {
    const toolCallId = String(item.toolCallId ?? item.id ?? '')
    const part = state.tools.get(toolCallId)
    if (part === undefined) return
    part.toolInvocation = {
      ...record(part.toolInvocation),
      state: 'result',
      result: item.output ?? item.result ?? null
    }
    return
  }
  if (type === 'tool-output-error' || type === 'tool-input-error') {
    const toolCallId = String(item.toolCallId ?? item.id ?? '')
    const part = state.tools.get(toolCallId)
    if (part === undefined) return
    part.toolInvocation = {
      ...record(part.toolInvocation),
      state: 'error',
      result: { error: errorTextOf(item.errorText ?? item.error) }
    }
  }
}

/** flush 时把"已结束但还没落 part"的文本补上（例如 text-end 没来就断流） */
function finalizeParts(state: CaptureState): StoredPart[] {
  const parts = [...state.parts]
  for (const text of state.texts.values()) {
    if (text !== '') parts.push({ type: 'text', text, createdAt: Date.now() })
  }
  return parts
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 已有 parts 里要保留的：error、data-*（我们只补正文/工具，不覆盖它们） */
function keepExisting(parts: readonly unknown[]): StoredPart[] {
  return parts.flatMap((part) => {
    const item = record(part)
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === 'error' || type.startsWith('data-')) return [item as StoredPart]
    return []
  })
}

/**
 * 收尾落库：等 Memory 写完后，按 messageId upsert（保留 error part）。
 * 失败一次重试（Memory 收尾与流结束有竞态）；最终拿不到/写不进 → 静默放弃（现状）。
 */
export async function persistFailedRound(options: {
  memory: FailedRoundMemory
  threadId: string
  capture: CaptureState
  onError?: (error: unknown) => void
}): Promise<void> {
  const { memory, threadId, capture } = options
  const parts = finalizeParts(capture)
  const messageId = capture.messageId
  if (messageId === null || parts.length === 0) return
  try {
    await memory.settled?.()
    let stored: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 8 && stored === null; attempt += 1) {
      const recalled = await memory.recall({ threadId, perPage: 50 })
      const found = recalled.messages.find((message) => record(message).id === messageId)
      if (found !== undefined) stored = record(found)
      else await sleep(120)
    }
    if (stored === null) return
    const content = record(stored.content)
    const existingParts = Array.isArray(content.parts) ? content.parts : []
    const merged = [...parts, ...keepExisting(existingParts)]
    await memory.saveMessages({
      messages: [
        {
          ...stored,
          content: {
            ...content,
            parts: merged,
            metadata: { ...record(content.metadata), status: 'failed' }
          }
        }
      ]
    })
  } catch (error) {
    options.onError?.(error)
  }
}

/**
 * 旁路包装 UI 流：只观察、不改变 chunk；收尾（flush）时若本轮失败/中断，就把已产生 parts 补进
 * 那条已存在的 assistant 消息。
 */
export function withFailedRoundCapture<T>(
  stream: ReadableStream<T>,
  options: {
    memory: FailedRoundMemory
    threadId: string
    onError?: (error: unknown) => void
  }
): ReadableStream<T> {
  const state = newState()
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        try {
          observe(state, chunk)
        } catch {
          // 观察者不影响这条流
        }
        controller.enqueue(chunk)
      },
      flush() {
        const interrupted = state.sawError || !state.sawFinish
        if (!interrupted) return
        void persistFailedRound({ ...options, capture: state })
      }
    })
  )
}

const RETRY_KEEP_KEY = 'kyclawRetryKeep'
const FAILED_STATUS = 'failed'

function isFailedAssistant(message: unknown): boolean {
  const item = record(message)
  if (item.role !== 'assistant') return false
  const content = record(item.content)
  return record(content.metadata).status === FAILED_STATUS
}

function isRetryKeepMarker(message: unknown): boolean {
  const item = record(message)
  if (item.role !== 'user') return false
  const content = record(item.content)
  return record(content.metadata)[RETRY_KEEP_KEY] === true
}

/**
 * 下一轮上下文过滤：
 *   - 去掉 `metadata.status==='failed'` 的 assistant 消息（失败内容不喂回模型）；
 *   - 历史里的重试 marker（`metadata.kyclawRetryKeep===true`）只保留**最后一条**（当前触发轮），
 *     并把内容换成中性「继续。」——不删元素，保证"最后一条是 user"这个前提不被打破。
 */
export function createFailedRoundFilter(): InputProcessor {
  return {
    id: 'failed-round-filter',
    processInput({ messages }) {
      const keepFrom = messages.length - 1
      const filtered = messages.filter((message, index) => {
        if (isFailedAssistant(message)) return false
        if (isRetryKeepMarker(message) && index !== keepFrom) return false
        return true
      })
      return filtered.map((message, index) => {
        if (!isRetryKeepMarker(message) || index !== filtered.length - 1) return message
        const content = record(message.content)
        return {
          ...message,
          content: {
            ...content,
            parts: [{ type: 'text', text: '继续。', createdAt: Date.now() }]
          }
        } as (typeof filtered)[number]
      })
    }
  }
}


