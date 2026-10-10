import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { Chat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage } from 'ai'
import { getTransport, threadRequestOptions } from '@renderer/lib/agent'
import { truncateThread } from '@renderer/lib/threads-api'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { createThreadChatRuntime, threadChat, dropThreadChat } from './thread-chats'
import type { ThreadChatRuntime } from './thread-chats'
import { Composer } from './Composer'
import { ErrorCard } from './ErrorCard'
import { MessageList } from './MessageList'

/**
 * 对话页（T7 起，T9 接会话）。
 *
 * 三层：
 *   1. ChatPage：把 transport 等出来 + 认当前会话（sessions-store 的 activeId）；
 *   2. ChatSession：按 threadId 从注册表拿 Chat（首次回灌历史），拿不到/历史坏了给错误卡；
 *   3. ActiveChat：真正接 useChat（外部实例）——发送 / 排队 / 停止 / 编辑重发 / 重试。
 *
 * "编辑重发"（R2）：先调服务端 truncate（把这轮及之后的存储消息删掉），再走 useChat 的
 * 客户端截断重发；两边顺序不能反——服务端记忆是权威，反了旧的回答会留在历史里。
 * "重试"同理：先删掉上一条助手回复再 regenerate（否则新回复会被合并进旧消息）。
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** 对话页的外框：限宽居中列（.content-column，见 styles/tailwind.css）——
 *  活动会话的整列（消息区 + 发送框）都必须挂在这一层里，否则会横向铺满主列被覆盖层侧栏裁掉。
 *  routes.spec 认的也是这一层。 */
function ChatFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section
      data-testid="chat-page"
      className="content-column animate-page-in flex min-h-0 flex-1 flex-col"
    >
      {children}
    </section>
  )
}

export function ChatPage(): React.JSX.Element {
  const [transport, setTransport] = useState<ChatTransport<UIMessage> | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const activeId = useSessionsStore((state) => state.activeId)
  const ensureLoaded = useSessionsStore((state) => state.ensureLoaded)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

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
        <div className="px-4 pt-6">
          <ErrorCard error={error} onRetry={retry} />
        </div>
      </ChatFrame>
    )
  }

  if (!transport) {
    return (
      <ChatFrame>
        <p data-testid="chat-connecting" className="p-4 text-b2 text-ink-tertiary">
          正在连接…
        </p>
      </ChatFrame>
    )
  }

  if (activeId === null) {
    return (
      <ChatFrame>
        <p data-testid="chat-loading" className="p-4 text-b2 text-ink-tertiary">
          正在载入会话…
        </p>
      </ChatFrame>
    )
  }

  // key = 会话 id：切换会话就换一挂（Chat 实例在注册表里活着，流不中断）
  return <ChatSession key={activeId} threadId={activeId} transport={transport} />
}

export interface ChatSessionProps {
  transport: ChatTransport<UIMessage>
  threadId: string
  /** 测试注入：默认走服务端回灌 + sessions-store 的完成处理 */
  runtime?: ThreadChatRuntime
}

export function ChatSession({ transport, threadId, runtime }: ChatSessionProps): React.JSX.Element {
  const [reloadToken, setReloadToken] = useState(0)
  /**
   * 解析结果与它对应的 key 一起存：key 变了（换会话/重试）就自然回到"载入中"，
   * 不需要在 effect 里同步 setState 清场（那会触发级联渲染）。
   */
  const resolveKey = `${threadId}#${reloadToken}`
  const [resolved, setResolved] = useState<{
    key: string
    chat: Chat<UIMessage> | null
    error: Error | null
  } | null>(null)

  const defaultRuntime = useMemo(
    () =>
      createThreadChatRuntime(transport, (finishedThreadId, outcome) => {
        // 出错/用户主动停止不算"完成"，不通知也不生成标题
        if (outcome.isError || outcome.isAbort) return
        void useSessionsStore.getState().handleTurnEnd(finishedThreadId)
      }),
    [transport]
  )
  const activeRuntime = runtime ?? defaultRuntime

  useEffect(() => {
    let alive = true
    threadChat(threadId, activeRuntime).then(
      (created) => {
        if (alive) setResolved({ key: resolveKey, chat: created, error: null })
      },
      (cause) => {
        if (alive) setResolved({ key: resolveKey, chat: null, error: toError(cause) })
      }
    )
    return () => {
      alive = false
    }
  }, [threadId, activeRuntime, resolveKey])

  const current = resolved !== null && resolved.key === resolveKey ? resolved : null
  const chat = current?.chat ?? null
  const resolveError = current?.error ?? null

  const retry = useCallback(() => {
    dropThreadChat(threadId)
    setReloadToken((token) => token + 1)
  }, [threadId])

  if (resolveError) {
    return (
      <ChatFrame>
        <div className="px-4 pt-6">
          <ErrorCard error={resolveError} onRetry={retry} />
        </div>
      </ChatFrame>
    )
  }

  if (!chat) {
    return (
      <ChatFrame>
        <p data-testid="chat-loading" className="p-4 text-b2 text-ink-tertiary">
          正在载入会话…
        </p>
      </ChatFrame>
    )
  }

  return (
    <ChatFrame>
      <ActiveChat chat={chat} threadId={threadId} />
    </ChatFrame>
  )
}

interface ActiveChatProps {
  chat: Chat<UIMessage>
  threadId: string
}

/** 编辑/重试先要在服务端截断的那一步失败了：带着原动作重试 */
interface PendingSync {
  kind: 'edit' | 'retry'
  messageId: string
  text?: string
}

function ActiveChat({ chat, threadId }: ActiveChatProps): React.JSX.Element {
  /**
   * 流式中发的消息排队（最简队列：先进先出，一轮结束自动发下一条）。
   * 队列本体放 ref（状态回调里要读最新值）；state 只存条数给界面看。
   */
  const pending = useRef<string[]>([])
  const [queuedCount, setQueuedCount] = useState(0)
  /** 服务端截断失败时的重试素材（不静默丢） */
  const [pendingSync, setPendingSync] = useState<PendingSync | null>(null)

  const { messages, sendMessage, regenerate, stop, status, error } = useChat({ chat })
  const busy = status === 'submitted' || status === 'streaming'

  const flushNext = useCallback(() => {
    const [next, ...rest] = pending.current
    if (next === undefined) return
    pending.current = rest
    setQueuedCount(rest.length)
    void sendMessage({ text: next }, threadRequestOptions(threadId))
  }, [sendMessage, threadId])

  /**
   * 一轮结束（从 busy 回到 ready）→ 补发排队的下一条。
   * 用 status 转移而不是 useChat 的 onFinish：Chat 实例是外部管理的（注册表持有），
   * onFinish 在构造时就绑给了完成通知那条路；这里只关心"忙完了、队列还排着没有"。
   * 出错收尾状态是 'error'（不是 ready），不自动补发——等用户决定重试还是改主意。
   */
  const previousStatus = useRef(status)
  useEffect(() => {
    const wasBusy = previousStatus.current === 'submitted' || previousStatus.current === 'streaming'
    previousStatus.current = status
    if (wasBusy && status === 'ready') flushNext()
  }, [status, flushNext])

  const submit = useCallback(
    (text: string) => {
      if (busy) {
        pending.current = [...pending.current, text]
        setQueuedCount(pending.current.length)
        return
      }
      void sendMessage({ text }, threadRequestOptions(threadId))
    },
    [busy, sendMessage, threadId]
  )

  /** 编辑重发（R2）：服务端截断 → 客户端截断重发；截断失败不重发（否则历史两边不一致） */
  const editResend = useCallback(
    (messageId: string, text: string) => {
      setPendingSync(null)
      truncateThread(threadId, messageId).then(
        () => {
          void sendMessage({ text, messageId }, threadRequestOptions(threadId))
        },
        () => {
          setPendingSync({ kind: 'edit', messageId, text })
        }
      )
    },
    [sendMessage, threadId]
  )

  /** 重试 = 整轮重生成：先删掉最后一条助手回复，再 regenerate（防止新旧回复在存储里合并） */
  const retry = useCallback(() => {
    const last = messages[messages.length - 1]
    if (last === undefined) return
    setPendingSync(null)
    const truncateFirst =
      last.role === 'assistant' ? truncateThread(threadId, last.id) : Promise.resolve(0)
    truncateFirst.then(
      () => {
        void regenerate(threadRequestOptions(threadId))
      },
      () => {
        setPendingSync({ kind: 'retry', messageId: last.id })
      }
    )
  }, [messages, regenerate, threadId])

  /** 截断失败的重试：把刚才没做完的动作原样再做一遍 */
  const retryPendingSync = useCallback(() => {
    if (!pendingSync) return
    if (pendingSync.kind === 'edit') {
      editResend(pendingSync.messageId, pendingSync.text ?? '')
    } else {
      retry()
    }
  }, [editResend, pendingSync, retry])

  const syncError = pendingSync
    ? new Error('会话历史没能在服务端同步，已取消发送（重试会重做这一步）')
    : null

  return (
    <>
      <MessageList
        messages={messages}
        status={status}
        // 流式中不给编辑入口：避免编辑触发的请求和当前这条流并发
        onEdit={busy ? undefined : editResend}
      />
      {error ? (
        <div className="px-4 pt-2">
          <ErrorCard error={toError(error)} onRetry={retry} />
        </div>
      ) : null}
      {syncError ? (
        <div className="px-4 pt-2">
          <ErrorCard error={syncError} onRetry={retryPendingSync} />
        </div>
      ) : null}
      <div className="shrink-0 px-4 pt-4 pb-6">
        <Composer
          busy={busy}
          queuedCount={queuedCount}
          onSend={submit}
          onStop={() => {
            void stop()
          }}
        />
      </div>
    </>
  )
}
