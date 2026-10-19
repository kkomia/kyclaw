/**
 * B3.1a：内核 assistant-stream / 会话事件 → **现有 renderer 吃的 SSE 帧**。
 *
 * 目标：字段级等价，不是"看着差不多"。基准来自
 * `__tests__/fixtures/renderer-sse-kyclaw-0.1.6.json`（现有 kyclaw chat 路径实测帧），
 * 内核侧输入来自 `__tests__/fixtures/kernel-follow-frames.json`（B3.1a 真机探测的原样帧）。
 *
 * 内核 `session/follow`（assistantStream: true）给的是：
 *   - `assistant-stream` 帧：`start` / `chunk{block-start|text-delta|block-end|usage|finish}` / `end`；
 *   - `event` 帧：`turn/start`、`user/message`、`assistant/message`、`step/end`、`turn/end` 等。
 * 这里只把"对 renderer 有意义"的 assistant-stream 子集映射成现有 8 帧形状：
 *   start → start-step → text-start → text-delta → text-end → finish-step → data-usage → finish
 * （其中 data-usage 在 finish 处补发：内核先 usage 后 finish，而现有帧顺序是 finish-step → data-usage → finish）
 */

export type RendererSseFrame =
  | { type: 'start'; messageId: string }
  | { type: 'start-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'finish-step' }
  | {
      type: 'data-usage'
      data: {
        stepIndex: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
        cachedInputTokens: number
        contextInput: number
      }
    }
  | { type: 'finish'; finishReason: string }
  | { type: 'error'; errorText: string }
  /** B3.2 工具卡：与旧 Mastra 路径的 AI SDK UI chunk 同形 */
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  /**
   * PB-013：内核 attempt 级重试的**正文替换**信号。
   *
   * 内核在「正文已经交付之后」断流时会自己重试（新的 `assistant-stream start` + 新 attemptId），
   * 而落库只保留最终 attempt。若交付侧继续把重试正文追加到同一个 `text-*` 部件，UI 会出现
   * N 份正文而库里 1 份（PB-013 实测：UI 3 份 / 落库 1 份）。
   * `reset-step` 是 AI SDK v7 的既有 UI chunk（schema + 消费端都支持）：丢弃**当前步骤**已渲染的
   * 部件（正文/reasoning/工具），随后重发的 `start-step`/`text-start` 从零开始。
   * 这样重试正文是**替换**而不是追加，同时又保留正常路径的边收边发。
   */
  | { type: 'reset-step' }

/** `session/follow` 的 item.value 里我们用到的子集（字段照 rc.2 原样） */
export interface KernelAssistantChunk {
  type: 'block-start' | 'text-delta' | 'block-end' | 'usage' | 'finish'
  index?: number
  blockType?: string
  text?: string
  block?: { type: string; text?: string }
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  reason?: { kind: string }
}

export type KernelFollowValue =
  | { type: 'snapshot'; cursor?: number; records?: unknown[] }
  | {
      type: 'assistant-stream'
      frame:
        | { type: 'start'; attemptId: string; revision?: number; turn?: number; step?: number }
        | {
            type: 'chunk'
            attemptId: string
            revision?: number
            index?: number
            chunk: KernelAssistantChunk
          }
        | { type: 'end'; attemptId: string; outcome?: { kind?: string; seq?: number } }
    }
  /**
   * 会话事件：`time` 是内核写入时间（epoch ms，rc.2 的 SessionWireEvent 字段）。
   * 审批结果行「什么时候结算的」直接取它（PB-026 契约），不要在交付侧重算。
   */
  | { type: 'event'; event: { type: string; seq?: number; time?: number; data?: Record<string, unknown> } }

const FINISH_REASONS: Readonly<Record<string, string>> = {
  stop: 'stop',
  length: 'length',
  'tool-calls': 'tool-calls',
  'content-filter': 'content-filter',
  error: 'error',
  other: 'other'
}

/**
 * 把一轮的新帧并入**有效帧流**（`result.frames` / `result.sse` 用的那一条）。
 *
 * 为什么需要：实时 `onFrame` 已经把每个 attempt 的正文发出去了，renderer 靠 `reset-step` 把它们
 * 丢掉；但"整轮结果"（非流式调用方、日志、探针）拿的是累积帧数组，如果保留被作废的 attempt，
 * 同一个正文就会在那个数组里出现 N 份（PB-013 的 uiCopies 就是这么数的）。
 * 这里在遇到 `reset-step` 时**剔掉上一个步骤的帧**（保留更早的 start/步骤，以及 reset-step 本身），
 * 于是有效帧流与"用户最终看到的"一致：正文只有最终 attempt 一份。
 */
export function appendEffectiveFrames(
  target: RendererSseFrame[],
  incoming: readonly RendererSseFrame[]
): void {
  if (incoming.some((frame) => frame.type === 'reset-step')) {
    let lastStepStart = -1
    for (let index = target.length - 1; index >= 0; index -= 1) {
      if (target[index]?.type === 'start-step') {
        lastStepStart = index
        break
      }
    }
    if (lastStepStart >= 0) target.splice(lastStepStart, target.length - lastStepStart)
  }
  target.push(...incoming)
}

/** 一条 follow 流 → SSE 帧的增量映射器（每个 follow stream 一个实例） */
export class KernelSseMapper {
  private messageId: string | undefined
  /** 当前 attempt（内核一次 model 请求）。变化 = 重试边界（PB-013） */
  private attemptId: string | undefined
  private stepStarted = false
  private readonly textIds = new Map<number, string>()
  private pendingUsage: KernelAssistantChunk['usage'] | undefined
  private finished = false
  private errored = false

  /** 喂一条 item.value；返回本次应发出的 SSE 帧（按现有顺序） */
  push(value: KernelFollowValue): RendererSseFrame[] {
    if (value.type === 'assistant-stream') return this.onAssistantStream(value.frame)
    if (value.type === 'event') return this.onEvent(value.event)
    return []
  }

  private onAssistantStream(
    frame: Extract<KernelFollowValue, { type: 'assistant-stream' }>['frame']
  ): RendererSseFrame[] {
    if (frame.type === 'start') {
      const frames: RendererSseFrame[] = []
      // PB-013：新 attemptId = 内核重试。上一尝试已交付的正文作废（内核只保留最终 attempt），
      // 先发 reset-step 让 renderer 丢掉当前步骤的部件，再让重试正文从新的 step 重新开始。
      const retried = this.attemptId !== undefined && this.attemptId !== frame.attemptId
      if (retried && this.stepStarted) frames.push({ type: 'reset-step' })
      this.attemptId = frame.attemptId
      this.messageId = `kernel-${frame.attemptId}`
      // 每个 attempt 都是独立的正文边界：text id 从 0 重来，finish/usage/error 归属本次 attempt
      this.textIds.clear()
      this.stepStarted = false
      this.pendingUsage = undefined
      this.finished = false
      this.errored = false
      frames.push({ type: 'start', messageId: this.messageId })
      return frames
    }
    if (frame.type === 'end') {
      // 失败/取消的 assistant 流：帧里带 outcome。已交付的文本帧必须先于 error（R11 基线）。
      const outcome = (
        frame as { outcome?: { kind?: string; error?: { code?: string; message?: string } } }
      ).outcome
      if (outcome?.kind === 'failed' || outcome?.kind === 'error') return this.errorFrames(outcome)
      return []
    }
    return this.onChunk(frame.chunk)
  }

  private onEvent(event: { type: string; data?: Record<string, unknown> }): RendererSseFrame[] {
    if (event.type === 'tool/call') return this.onToolCall(event.data)
    if (event.type === 'tool/result') return this.onToolResult(event.data)
    if (event.type !== 'turn/end') return []
    const reason = event.data?.reason as
      { kind?: string; error?: { code?: string; message?: string } } | undefined
    if (reason?.kind === 'completed' || reason?.kind === 'cancelled') return []
    return this.errorFrames(reason)
  }

  /** `tool/call` 事件 → 旧路径的 `tool-input-available`（参数从 JSON 字符串还原成对象） */
  private onToolCall(data: Record<string, unknown> | undefined): RendererSseFrame[] {
    const callId = typeof data?.callId === 'string' ? data.callId : undefined
    const name = typeof data?.name === 'string' ? data.name : undefined
    if (callId === undefined || name === undefined) return []
    const raw = data?.arguments
    let input: unknown = raw
    if (typeof raw === 'string') {
      try {
        input = JSON.parse(raw) as unknown
      } catch {
        input = raw
      }
    }
    return [{ type: 'tool-input-available', toolCallId: callId, toolName: name, input }]
  }

  /** `tool/result` 事件 → `tool-output-available` / `tool-output-error`（字段级对齐旧路径） */
  private onToolResult(data: Record<string, unknown> | undefined): RendererSseFrame[] {
    const message = data?.message as
      | {
          toolCallId?: unknown
          isError?: unknown
          content?: unknown
        }
      | undefined
    const toolCallId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
    if (toolCallId === undefined) return []
    const text = Array.isArray(message?.content)
      ? message.content
          .flatMap((part) =>
            typeof part === 'object' &&
            part !== null &&
            (part as { type?: unknown }).type === 'text'
              ? [(part as { text?: unknown }).text]
              : []
          )
          .filter((value): value is string => typeof value === 'string')
          .join('')
      : ''
    if (message?.isError === true)
      return [{ type: 'tool-output-error', toolCallId, errorText: text }]
    let output: unknown = text
    try {
      output = JSON.parse(text) as unknown
    } catch {
      // 非 JSON 输出按文本给
    }
    return [{ type: 'tool-output-available', toolCallId, output }]
  }

  /**
   * 错误帧：**不重排、不丢弃**之前已产出的文本帧；错误只追加在末尾。
   * 内核工具错误码（`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` / `ABORTED_BEFORE_DISPATCH`）
   * 以 `[CODE] message` 形式进现有 errorText（renderer 直接展示）。
   * 工具调用事件（tool/call、tool/result）见 onToolCall/onToolResult。
   */
  private errorFrames(reason?: {
    error?: { code?: string; message?: string }
  }): RendererSseFrame[] {
    if (this.errored) return []
    this.errored = true
    const code = reason?.error?.code
    const message = reason?.error?.message ?? 'kernel turn failed'
    return [{ type: 'error', errorText: code === undefined ? message : `[${code}] ${message}` }]
  }

  private onChunk(chunk: KernelAssistantChunk): RendererSseFrame[] {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType !== 'text') return []
        const index = chunk.index ?? 0
        const id = `text-${String(index)}`
        this.textIds.set(index, id)
        const frames: RendererSseFrame[] = []
        if (!this.stepStarted) {
          frames.push({ type: 'start-step' })
          this.stepStarted = true
        }
        frames.push({ type: 'text-start', id })
        return frames
      }
      case 'text-delta': {
        const index = chunk.index ?? 0
        const id = this.textIds.get(index) ?? `text-${String(index)}`
        return [{ type: 'text-delta', id, delta: chunk.text ?? '' }]
      }
      case 'block-end': {
        const index = chunk.index ?? 0
        const id = this.textIds.get(index) ?? `text-${String(index)}`
        return [{ type: 'text-end', id }]
      }
      case 'usage': {
        // 先缓存：现有帧顺序要求 finish-step 在 data-usage 之前
        this.pendingUsage = chunk.usage
        return []
      }
      case 'finish': {
        const frames: RendererSseFrame[] = []
        if (!this.finished) {
          frames.push({ type: 'finish-step' })
          if (this.pendingUsage !== undefined) {
            frames.push({
              type: 'data-usage',
              data: {
                stepIndex: 0,
                inputTokens: this.pendingUsage.inputTokens,
                outputTokens: this.pendingUsage.outputTokens,
                totalTokens: this.pendingUsage.totalTokens,
                cachedInputTokens: 0,
                contextInput: this.pendingUsage.inputTokens
              }
            })
          }
          frames.push({
            type: 'finish',
            finishReason: FINISH_REASONS[chunk.reason?.kind ?? 'stop'] ?? 'other'
          })
          this.finished = true
        }
        return frames
      }
      default:
        return []
    }
  }
}
