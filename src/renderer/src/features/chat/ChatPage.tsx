import { useCallback, useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage } from 'ai'
import { getTransport } from '@renderer/lib/agent'
import { Composer } from './Composer'
import { ErrorCard } from './ErrorCard'
import { MessageList } from './MessageList'

/**
 * 对话页（T7）。
 *
 * 两层：
 *   1. ChatPage：把 transport 等出来 —— 端点要经 IPC 现取（随机端口 + 每次启动的 token），
 *      拿到之前显示"连接中"，拿不到直接给错误卡 + 重试（服务没起来就卡在这里）；
 *   2. ChatSession：真正接 useChat（发送 / 停止 / 错误 / 重试），只依赖注入的 transport，
 *      所以单测塞一条假 transport 就能跑全流程，不碰网络。
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** 对话页的外框：路由断言（routes.spec）认的限宽居中列 */
function ChatFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section
      data-testid="chat-page"
      className="mx-auto flex min-h-0 w-full max-w-(--content-max-width) flex-1 flex-col"
    >
      {children}
    </section>
  )
}

export function ChatPage(): React.JSX.Element {
  const [transport, setTransport] = useState<ChatTransport<UIMessage> | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let alive = true
    getTransport()
      .then((created) => {
        if (alive) setTransport(created)
      })
      .catch((cause) => {
        if (alive) setError(toError(cause))
      })
    return () => {
      alive = false
    }
  }, [reloadToken])

  const retry = useCallback(() => {
    setError(null)
    setReloadToken((token) => token + 1)
  }, [])

  if (error) {
    return (
      <ChatFrame>
        <div className="px-6 pt-6">
          <ErrorCard error={error} onRetry={retry} />
        </div>
      </ChatFrame>
    )
  }

  if (!transport) {
    return (
      <ChatFrame>
        <p data-testid="chat-connecting" className="p-6 text-b2 text-ink-tertiary">
          正在连接本地 agent 服务…
        </p>
      </ChatFrame>
    )
  }

  return <ChatSession transport={transport} />
}

export interface ChatSessionProps {
  transport: ChatTransport<UIMessage>
}

export function ChatSession({ transport }: ChatSessionProps): React.JSX.Element {
  /**
   * 流式中发的消息排队（最简队列：先进先出，一轮结束自动发下一条）。
   * 队列本体放 ref（onFinish 回调里要读最新值）；state 只存条数给界面看。
   */
  const pending = useRef<string[]>([])
  const [queuedCount, setQueuedCount] = useState(0)
  /** flushNext 要在 useChat 的 options 之后才成形，用 ref 转一手给 onFinish */
  const flushRef = useRef<() => void>(() => {})

  const { messages, sendMessage, regenerate, stop, status, error } = useChat({
    transport,
    // 一轮结束（正常收尾 / 用户停止）→ 补发下一条；出错不补发，等用户决定重试还是改主意
    onFinish: ({ isError }) => {
      if (!isError) flushRef.current()
    }
  })
  const busy = status === 'submitted' || status === 'streaming'

  const flushNext = useCallback(() => {
    const [next, ...rest] = pending.current
    if (next === undefined) return
    pending.current = rest
    setQueuedCount(rest.length)
    void sendMessage({ text: next })
  }, [sendMessage])

  useEffect(() => {
    flushRef.current = flushNext
  }, [flushNext])

  const submit = useCallback(
    (text: string) => {
      if (busy) {
        pending.current = [...pending.current, text]
        setQueuedCount(pending.current.length)
        return
      }
      void sendMessage({ text })
    },
    [busy, sendMessage]
  )

  /** 编辑 = 客户端截断重发：带 messageId 的 sendMessage 会替换该条并把后面的历史切掉 */
  const editResend = useCallback(
    (messageId: string, text: string) => {
      void sendMessage({ text, messageId })
    },
    [sendMessage]
  )

  const retry = useCallback(() => {
    if (messages.length === 0) return
    void regenerate()
  }, [regenerate, messages.length])

  return (
    <ChatFrame>
      <MessageList
        messages={messages}
        status={status}
        // 流式中不给编辑入口：避免编辑触发的请求和当前这条流并发
        onEdit={busy ? undefined : editResend}
      />
      {error ? (
        <div className="px-6 pt-2">
          <ErrorCard error={error} onRetry={retry} />
        </div>
      ) : null}
      <div className="shrink-0 px-6 pt-4 pb-6">
        <Composer
          busy={busy}
          queuedCount={queuedCount}
          onSend={submit}
          onStop={() => {
            void stop()
          }}
        />
      </div>
    </ChatFrame>
  )
}
