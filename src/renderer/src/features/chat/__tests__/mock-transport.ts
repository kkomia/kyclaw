import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

/**
 * 单测用的假 transport（不碰网络）：把 sendMessages 的入参存下来，
 * 返回一条"由测试逐段推"的流 —— 文本增量什么时候来、来几段，全由用例决定。
 *
 * 与 `chatRoute` 的真身协议一致（UIMessageChunk：text-start / text-delta / text-end / finish）。
 */
export interface MockRequest {
  trigger: 'submit-message' | 'regenerate-message' | 'resume-stream'
  messageId: string | undefined
  /** 请求时刻的历史快照（拷一份，免得被 Chat 内部的后续改写污染） */
  messages: UIMessage[]
  /** per-request 的附加 body（T9：threadId / resourceId 从这里进请求） */
  body: Record<string, unknown> | undefined
}

export interface MockTransport {
  transport: ChatTransport<UIMessage>
  /** 每次请求（含 regenerate / 编辑重发 / 审批续跑）都记一条 */
  requests: MockRequest[]
  /** 推一段文本增量（首段自动补 text-start） */
  push: (delta: string) => void
  /** 推一段思考增量（reasoning part；服务端 chatRoute 已开 sendReasoning，v0.1 起真会到） */
  reason: (delta: string) => void
  /**
   * 推一次"工具调用 + 服务端要求审批"（T13）：part 落到 `approval-requested`，
   * 等用户决策后由 Chat 的 sendAutomaticallyWhen 自动续跑（那次请求会记进 requests）。
   */
  requestApproval: (options: {
    toolCallId: string
    toolName: string
    input: unknown
    approvalId: string
  }) => void
  /**
   * 推一次"没有审批的普通工具调用"（T13×T14：Mastra 记忆工具那类 part——服务端把结果
   * 吞进内部，UI 消息里永远停在 `input-available`）。
   */
  toolInput: (toolCallId: string, toolName: string, input: unknown) => void
  /**
   * 推一次"工具执行完成"（T13 的审批续跑里，服务端执行完会回 tool-output-available）。
   * 与 requestApproval 配对：缺了它，part 会一直停在 approval-responded，
   * AI SDK 的 lastAssistantMessageIsCompleteWithApprovalResponses 会再触发一次自动续跑。
   */
  toolOutput: (toolCallId: string, output: unknown) => void
  /** 结束当前流（text-end + finish） */
  finish: () => void
  /** 半截流上断掉（模拟断网/断流）：已推的内容留在消息里，错误抛给上层 */
  disconnect: (error?: Error) => void
  /** 让下一个请求在建立阶段就失败（模拟 401 / 断网） */
  failNext: (error: Error) => void
}

function snapshot(messages: UIMessage[]): UIMessage[] {
  return JSON.parse(JSON.stringify(messages)) as UIMessage[]
}

export function createMockTransport(): MockTransport {
  const requests: MockRequest[] = []
  let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null
  let activeTextId = ''
  let textStarted = false
  let activeReasoningId = ''
  let reasoningStarted = false
  let reasoningSeq = 0
  let nextFailure: Error | null = null

  /** 思考段收尾（真 SSE 里 reasoning-end 先于随后的工具/正文到达）：一段思考 = 一个 reasoning part */
  const endReasoning = (): void => {
    if (!reasoningStarted || !controller) return
    controller.enqueue({ type: 'reasoning-end', id: activeReasoningId })
    reasoningStarted = false
  }

  const startText = (): void => {
    endReasoning()
    if (textStarted || !controller) return
    controller.enqueue({ type: 'text-start', id: activeTextId })
    textStarted = true
  }

  const startReasoning = (): void => {
    if (reasoningStarted || !controller) return
    reasoningSeq += 1
    activeReasoningId = `reasoning-${requests.length}-${reasoningSeq}`
    controller.enqueue({ type: 'reasoning-start', id: activeReasoningId })
    reasoningStarted = true
  }

  const transport: ChatTransport<UIMessage> = {
    async sendMessages(options) {
      requests.push({
        trigger: options.trigger,
        messageId: options.messageId,
        messages: snapshot(options.messages),
        body:
          options.body === undefined ? undefined : { ...(options.body as Record<string, unknown>) }
      })

      if (nextFailure) {
        const failure = nextFailure
        nextFailure = null
        throw failure
      }

      activeTextId = `text-${requests.length}`
      textStarted = false
      reasoningStarted = false
      reasoningSeq = 0
      return new ReadableStream<UIMessageChunk>({
        start(streamController) {
          controller = streamController
          options.abortSignal?.addEventListener('abort', () => {
            // 停止 = 断开：真链路里是 abort 掉 HTTP 请求，这里等价地把流收掉
            try {
              streamController.close()
            } catch {
              /* 已经关过就算了 */
            }
            if (controller === streamController) controller = null
          })
        },
        cancel() {
          controller = null
        }
      })
    },
    async reconnectToStream() {
      return null
    }
  }

  return {
    transport,
    requests,
    push(delta) {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
      startText()
      controller.enqueue({ type: 'text-delta', id: activeTextId, delta })
    },
    reason(delta) {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
      startReasoning()
      controller.enqueue({ type: 'reasoning-delta', id: activeReasoningId, delta })
    },
    requestApproval({ toolCallId, toolName, input, approvalId }) {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
      endReasoning()
      controller.enqueue({ type: 'tool-input-start', toolCallId, toolName })
      controller.enqueue({ type: 'tool-input-available', toolCallId, toolName, input })
      controller.enqueue({ type: 'tool-approval-request', approvalId, toolCallId })
    },
    toolInput(toolCallId, toolName, input) {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
      endReasoning()
      controller.enqueue({ type: 'tool-input-start', toolCallId, toolName })
      controller.enqueue({ type: 'tool-input-available', toolCallId, toolName, input })
    },
    toolOutput(toolCallId, output) {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
      endReasoning()
      controller.enqueue({ type: 'tool-output-available', toolCallId, output })
    },
    finish() {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
      endReasoning()
      startText()
      controller.enqueue({ type: 'text-end', id: activeTextId })
      controller.enqueue({ type: 'finish' })
      controller.close()
      controller = null
    },
    disconnect(error = new TypeError('Failed to fetch')) {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
      controller.error(error)
      controller = null
    },
    failNext(error) {
      nextFailure = error
    }
  }
}
