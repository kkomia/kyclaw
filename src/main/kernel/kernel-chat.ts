/**
 * B3.1b：chat 路由的内核分支（**只在 flag 开、adapter 已起时注册**）。
 *
 * renderer 不变：仍然 POST `/chat/<agentId>`，仍然读 `text/event-stream` 的 `data:` 帧；
 * 这里只把 adapter 产出的帧原样写回（`kernel-chat` 不碰 token/cookie）。
 *
 * B3.2：增量流式（onFrame 边收边发）、工具事件帧、断流取消（reader cancel / request abort → cancelTurn）。
 * 线程/记忆：内核路径**不复用**现有 thread memory（内核自己管会话日志）；跨刷新 resume 未覆盖（见 evidence）。
 */
import type { Context } from 'hono'
import type { KernelAdapter } from './kernel-adapter'
import type { RendererSseFrame } from './sse-map'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store',
  connection: 'keep-alive'
} as const

function sse(frames: readonly RendererSseFrame[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

function errorResponse(errorText: string): Response {
  return new Response(sse([{ type: 'error', errorText }]), { status: 200, headers: SSE_HEADERS })
}

/** 从现有 chat body 取最后一条 user 文本（parts 形状与 renderer 一致） */
export function lastUserText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; parts?: unknown } | undefined
    if (message?.role !== 'user' || !Array.isArray(message.parts)) continue
    const text = message.parts
      .flatMap((part) =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
          ? [(part as { text?: unknown }).text]
          : []
      )
      .filter((value): value is string => typeof value === 'string')
      .join('')
    if (text.trim() !== '') return text
  }
  return null
}

export function createKernelChatHandler(
  adapter: KernelAdapter
): (context: Context) => Promise<Response> {
  return async (context) => {
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return errorResponse('内核路径：请求体不是 JSON')
    }
    const text = lastUserText(body)
    if (text === null) return errorResponse('内核路径：缺少用户消息')

    const signal = context.req.raw.signal
    const encoder = new TextEncoder()
    // B3.2：**边收边发**——adapter 每产生一帧就写进 SSE，不再等整轮结束
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        const writeFrame = (frame: RendererSseFrame): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          } catch {
            closed = true
          }
        }
        const close = (): void => {
          if (closed) return
          closed = true
          try {
            controller.close()
          } catch {
            // 已关闭/已断开
          }
        }
        // 客户端断开 → 协作式取消（内核会结算，已交付文本保留）
        const onAbort = (): void => {
          void adapter.cancelTurn()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        void adapter
          .startTurn(text, { onFrame: writeFrame })
          .then((result) => {
            // 防御：若调用方没收到 error 帧但结果带 error，补一条（不重复已有 error）
            if (
              result.error !== undefined &&
              !result.frames.some((frame) => frame.type === 'error')
            ) {
              writeFrame({
                type: 'error',
                errorText:
                  result.error.code === undefined
                    ? result.error.message
                    : `[${result.error.code}] ${result.error.message}`
              })
            }
            signal.removeEventListener('abort', onAbort)
            close()
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            writeFrame({ type: 'error', errorText: `内核路径失败：${message}` })
            signal.removeEventListener('abort', onAbort)
            close()
          })
      },
      cancel() {
        // 下游 reader 取消（HTTP 客户端断开）→ 内核侧取消，避免空转
        void adapter.cancelTurn()
      }
    })
    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  }
}
