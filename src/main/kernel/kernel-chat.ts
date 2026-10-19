/**
 * B3.1b：chat 路由的内核分支（**只在 flag 开、adapter 已起时注册**）。
 *
 * renderer 不变：仍然 POST `/chat/<agentId>`，仍然读 `text/event-stream` 的 `data:` 帧；
 * 这里只把 adapter 产出的帧原样写回（`kernel-chat` 不碰 token/cookie）。
 *
 * 线程/记忆：内核路径**不复用**现有 thread memory（内核自己管会话日志）；本批先用单会话。
 * 工具调用事件：**未覆盖**（见 evidence 文档的后续批次清单）。
 */
import type { Context } from 'hono'
import type { KernelAdapter, KernelTurnResult } from './kernel-adapter'
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

    // 客户端断开 → 协作式取消（内核会结算，已交付文本保留；见 adapter.cancelTurn）
    const signal = context.req.raw.signal
    const onAbort = (): void => {
      void adapter.cancelTurn()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result: KernelTurnResult = await adapter.startTurn(text)
      return new Response(result.sse, { status: 200, headers: SSE_HEADERS })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResponse(`内核路径失败：${message}`)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
