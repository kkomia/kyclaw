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
    /**
     * PB-013 补充护栏（Lead 点名）：截断会把**被重试步骤的 `start-step` 标记一起删掉**。
     * 如果就这么带着 `reset-step` 留在有效帧里，任何"把有效帧原样重放"的消费端（新消息状态）
     * 看到的最后一个 step 标记会退回**上一步**，于是 reset-step 清掉的是上一步的正文
     * （AI SDK 的 reset-step = 删 `getCurrentStepParts()`，即最后一个 start-step 之后的部件）。
     * 这里在 reset-step 之前补一个空步骤标记：重放端 reset 到的就是这一段（空），
     * 再往后的正文落到新的 step 里；有效帧的 reset-step 计数与实时语义保持不变。
     */
    const endsWithStepStart = target[target.length - 1]?.type === 'start-step'
    if (!endsWithStepStart) target.push({ type: 'start-step' })
  }
  target.push(...incoming)
}

/** 一条 follow 流 → SSE 帧的增量映射器（每个 follow stream 一个实例） */
export class KernelSseMapper {
  private messageId: string | undefined
  /** 当前 attempt（内核一次 model 请求）。**注意**：每个 step 都会换，不能单独当重试判据（PB-013 返工） */
  private attemptId: string | undefined
  /** start 帧带的持久 turn/step：判「步骤边界 vs 真重试」的唯一判据 */
  private turn: number | undefined
  private step: number | undefined
  /** 正文部件序号：步骤之间必须唯一（同一 step 内也不重复） */
  private partSeq = 0
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
      /**
       * PB-013 返工（Nia R07/R08/R06）：**attemptId 每个 step 都会变**（内核 `sessionId:attempt`，
       * 见 dsh-agent-loop 的 LlmAttempt 构造），所以它不能单独当重试判据。start 帧还带持久的
       * `turn`/`step`：
       *   - 同一 (turn, step) + 新 attemptId = **真重试** → 发 reset-step（PB-013 原修法，正文只留最终份）；
       *   - (turn, step) 变了 = **工具步骤边界** → 绝不能 reset-step（否则上一步正文/工具卡/过程块被清空，
       *     真机表现：中间正文先可见随后变空、8 步只见 1 个 tool-row）。
       * 旧夹具/旧内核没带 turn/step 时保持原行为（attemptId 变 = 重试），不为猜测改语义。
       */
      const changed = this.attemptId !== undefined && this.attemptId !== frame.attemptId
      const slotKnown =
        frame.turn !== undefined &&
        frame.step !== undefined &&
        this.turn !== undefined &&
        this.step !== undefined
      const sameSlot = slotKnown && frame.turn === this.turn && frame.step === this.step
      const stepBoundary = changed && slotKnown && !sameSlot
      if (stepBoundary) {
        // 步骤边界：不 reset-step、不发新 start（同一条 assistant 消息继续），只切本步解析状态。
        this.attemptId = frame.attemptId
        this.turn = frame.turn
        this.step = frame.step
        this.textIds.clear()
        this.pendingUsage = undefined
        this.finished = false
        // 新步骤显式开 step（tool-only 步骤也必须有自己的 step 边界，R08 的 per-step 采样靠它）
        frames.push({ type: 'start-step' })
        this.stepStarted = true
        return frames
      }
      const retried = changed
      if (retried && this.stepStarted) frames.push({ type: 'reset-step' })
      this.attemptId = frame.attemptId
      this.turn = frame.turn
      this.step = frame.step
      this.messageId = `kernel-${frame.attemptId}`
      // 每个 attempt 都是独立的正文边界：text id 从 0 重来，finish/usage/error 归属本次 attempt
      this.textIds.clear()
      /**
       * **序号不归零**（PB-013 返工补充，Lead 点名的自检）：`reset-step` 只清"当前步骤"的部件，
       * 前面 step 的 text part 还在消息里；若重试把序号归零，重试正文会拿到一个**已存在的 id**
       * （如第一步的 `text-0`）。AI SDK 对重复 id 不查错（`ai/dist/index.js` 的 `text-start`
       * 直接 push 新 part 并覆盖 activeTextParts），结果是同一条消息里出现两个同 id part ——
       * 选文/引用/再次 reset 都会指错。所以整轮单调递增，重试也只往后排。
       */
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
        // PB-013 返工：正文部件 id 用全局序号（步骤之间必须唯一；同一步内按块序递增，
        // 单步场景与旧 `text-<index>` 同名，兼容既有断言/夹具）。
        const id = `text-${String(this.partSeq)}`
        this.partSeq += 1
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
        // PB-039（P0）：没有 text-start 的 delta 不合法（renderer 会报 missing text part）——
        // 只有 block-start 是 text 时才登记过 id，这里按登记表取，取不到就丢。
        const id = this.textIds.get(index)
        if (id === undefined) return []
        return [{ type: 'text-delta', id, delta: chunk.text ?? '' }]
      }
      case 'block-end': {
        const index = chunk.index ?? 0
        // PB-039（P0）：**只有文本块**才发 text-end。工具/思考等非文本块的 block-start 在
        // 上面就被忽略了（从不发 text-start），若无条件发 text-end，renderer（AI SDK）会抛
        // `Received text-end for missing text part` —— 先说话再调工具的轮次整轮失败（Nia R07a）。
        const id = this.textIds.get(index)
        if (id === undefined) return []
        this.textIds.delete(index)
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
