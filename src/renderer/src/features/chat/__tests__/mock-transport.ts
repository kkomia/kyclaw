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
  /** 每次请求（含 regenerate / 编辑重发）都记一条 */
  requests: MockRequest[]
  /** 推一段文本增量（首段自动补 text-start） */
  push: (delta: string) => void
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
  let nextFailure: Error | null = null

  const startText = (): void => {
    if (textStarted || !controller) return
    controller.enqueue({ type: 'text-start', id: activeTextId })
    textStarted = true
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
    finish() {
      if (!controller) throw new Error('mock transport：当前没有进行中的流')
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
