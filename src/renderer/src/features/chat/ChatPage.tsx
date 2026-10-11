import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { Chat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage } from 'ai'
import type { ThreadCompaction } from '@shared/threads'
import { getTransport, threadRequestOptions } from '@renderer/lib/agent'
import { compactThread, fetchThreadCompaction, truncateThread } from '@renderer/lib/threads-api'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { shouldCompact, thresholdTokensOf } from '@renderer/lib/compact'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import {
  allowForSession,
  isAllowedForSession,
  isDangerousTool,
  pendingApprovals,
  resolveApprovalWorkspace
} from './approval'
import type { ApprovalRequest } from './approval'
import type { ApprovalDecision } from './ApprovalCard'
import type { ComposerNotice } from './ComposerControls'
import { createThreadChatRuntime, threadChat, dropThreadChat } from './thread-chats'
import type { ThreadChatRuntime } from './thread-chats'
import { ChatHeader } from './ChatHeader'
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

/** 对话页的外框（round 21 拆两层；round 27 顶栏外提）：
 *  外层 = **聊天区整幅**（相对定位基准：消息导览轨贴它的右缘 8px，图2 口径）；
 *  `header` = **对话顶部栏**（round 27 用户口径：标题贴面板最左，脱离限宽列）——横跨主列整幅，
 *  用 `ml-(--content-safe-left)` 让到"内容卡可见左缘"（侧栏是覆盖层，卡片可见部分从 safe-left 起）；
 *  配合 header 自身 pl-2 + 标题按钮 px-2 → 标题左缘 = 内容卡左缘 + 16px（不再被居中列推开）。
 *  内层 = **限宽内容列**（.content-column，P0 回归口径不变：消息区 + 发送框都挂在它里面，
 *  否则会横向铺满主列被覆盖层侧栏裁掉；routes.spec / chat-flow.spec 认的也是它）。
 *  testid：`chat-page` = 外层整幅（相对定位与"聊天区右缘"的量距基准），`chat-column` = 限宽列。 */
function ChatFrame({
  header,
  children
}: {
  header?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      data-testid="chat-page"
      className="animate-page-in relative flex min-h-0 flex-1 flex-col"
    >
      {/* round 27：顶部栏在限宽列之外（整幅宽；左padding 让到内容卡可见左缘，跟着侧栏开合过渡） */}
      {header === undefined ? null : (
        <div className="ml-(--content-safe-left) shrink-0">{header}</div>
      )}
      <div data-testid="chat-column" className="content-column flex min-h-0 flex-1 flex-col">
        {children}
      </div>
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
        // 出错/用户主动停止不算"完成"，不通知也不生成标题；
        // "还停在等审批"的挂起轮同样不算 —— 审批卡还等着用户，标题与完成通知都该等 resume 之后那轮
        if (outcome.isError || outcome.isAbort || outcome.awaitingApproval) return
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
    <ChatFrame header={<ChatHeader threadId={threadId} />}>
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
  /** round 19：压缩记录（顶部「上下文已压缩」标记的数据面） */
  const [compaction, setCompaction] = useState<ThreadCompaction | null>(null)
  /** 压缩进行中（自动触发 / 手动入口共用；发送会按 busy 语义排队） */
  const [compacting, setCompacting] = useState(false)
  /** 压缩结果的一行 notice（成功/失败/降级；交给 Composer 显示） */
  const [compactNotice, setCompactNotice] = useState<ComposerNotice | null>(null)
  /** 发送预检进行中（取用量 → 也许压缩）的防抖锁：status 更新前的小窗口里防连按双发 */
  const sending = useRef(false)

  const { messages, sendMessage, regenerate, stop, status, error, addToolApprovalResponse } =
    useChat({
      chat
    })
  const busy = status === 'submitted' || status === 'streaming'
  const workspaces = useSettingsStore((state) => state.settings.workspaces)
  /** 还停在等审批（挂起轮）：发送/编辑都要按"忙"处理，见下面各处 */
  const waitingApproval = pendingApprovals(messages[messages.length - 1]).length > 0
  /** "永久允许"没写进设置（只在本次对话生效）：露一行给用户，不静默当成永久生效 */
  const [permissionError, setPermissionError] = useState<string | null>(null)

  /** 压缩记录随会话挂载读一次（顶部标记的数据面；取不到就停在无标记态，不打扰对话） */
  useEffect(() => {
    let alive = true
    void fetchThreadCompaction(threadId).then(
      (record) => {
        if (alive) setCompaction(record)
      },
      () => {
        /* 服务没起来/单测未装桥：停在无标记态 */
      }
    )
    return () => {
      alive = false
    }
  }, [threadId])

  /**
   * 跑一轮压缩（自动触发与手动入口共用）：进行中压缩中置忙；失败不抛出，
   * 把原因原样交给调用方决定提示与降级（自动 = 照发 + 警示；手动 = danger notice）。
   */
  const runCompact = useCallback(async (): Promise<
    | { ok: true; compacted: boolean; compaction: ThreadCompaction | null }
    | { ok: false; error: string }
  > => {
    setCompacting(true)
    try {
      const result = await compactThread(threadId)
      if (result.compaction !== null) setCompaction(result.compaction)
      return { ok: true, compacted: result.compacted, compaction: result.compaction }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      setCompacting(false)
    }
  }, [threadId])

  /**
   * 发送预检（round 19 自动触发）：最近一轮上下文用量 ≥ 阈值（contextPct × contextWindow）时
   * 先压一轮再发；压缩失败不阻塞——照常发送 + 一行警示。用量取不到（服务没起来 / usage 行
   * 还没落）就不压缩：如实降级，不假装判过（偏差见报告）。
   */
  const sendWithPreflight = useCallback(
    async (text: string): Promise<void> => {
      setCompactNotice(null)
      try {
        const context = await fetchThreadContext(threadId)
        const threshold = thresholdTokensOf(useSettingsStore.getState().settings)
        if (shouldCompact(context.lastInput, threshold)) {
          const outcome = await runCompact()
          if (!outcome.ok) {
            setCompactNotice({ tone: 'warning', text: `压缩失败：${outcome.error}；已直接发送` })
          }
        }
      } catch {
        /* 用量取不到：不压缩，照常发送 */
      }
      void sendMessage({ text }, threadRequestOptions(threadId))
    },
    [runCompact, sendMessage, threadId]
  )

  /** 统一发送入口（submit 与队列补发都走它）：预检锁覆盖预检窗口，防双发 */
  const dispatch = useCallback(
    (text: string): void => {
      sending.current = true
      void sendWithPreflight(text).finally(() => {
        sending.current = false
      })
    },
    [sendWithPreflight]
  )

  /**
   * 审批决策（T13）：
   *   - 本会话允许 → 记进模块级内存（同对话 + 同工具 + 同工作区），这个对话里之后不再打扰；
   *   - 永久允许 → **先登记本会话记忆**（同轮内紧随的第二次写不再弹卡），再落一条规则进
   *     settings.permissions.rules（服务端下一轮就不再问）；落盘失败要露出来（见 permissionError）；
   *   - 决策本身经 addToolApprovalResponse 回灌；`sendAutomaticallyWhen`（thread-chats 里挂的
   *     `canResumeAfterApproval`，approval.ts）会在所有审批都有回应后自动把消息发回服务端执行。
   * 两个记忆入口都要求工作区明确、且不是危险档（delete/move 服务端永远问、不吃记忆；审批卡
   * 不显示这两个入口，这里再守一道 —— 防任何调用方绕出"点了却不生效"的规则）。
   */
  const decideApproval = useCallback(
    (request: ApprovalRequest, decision: ApprovalDecision) => {
      const workspace = resolveApprovalWorkspace(request.input, workspaces, request.toolName)
      if (workspace !== null && !isDangerousTool(request.toolName)) {
        if (decision === 'session' || decision === 'forever') {
          allowForSession(threadId, request.toolName, workspace)
        }
        if (decision === 'forever') {
          useSettingsStore
            .getState()
            .allowToolForever(request.toolName, workspace)
            .then(
              () => setPermissionError(null),
              (cause: unknown) => {
                console.error('[kyclaw] 「永久允许」没能写进设置', cause)
                setPermissionError('「永久允许」没能保存：这次先记在当前对话里，重启后要重新确认')
              }
            )
        }
      }
      void addToolApprovalResponse({
        id: request.approvalId,
        approved: decision !== 'deny',
        ...(decision === 'deny' ? { reason: '用户拒绝了这次操作' } : {}),
        // `options` 是给"决策触发的自动续跑请求"用的（AI SDK 的类型注释点名了这个用途）：
        // 续跑请求与普通发送走同一条路，线程上下文（memory.thread/resource）得同样带上，
        // 否则续跑那一轮服务端拿不到会话。
        options: threadRequestOptions(threadId)
      })
    },
    [addToolApprovalResponse, workspaces, threadId]
  )

  /** 会话记忆命中的待批调用直接放行（"本会话允许"之后不再弹卡） */
  useEffect(() => {
    for (const request of pendingApprovals(messages[messages.length - 1])) {
      const workspace = resolveApprovalWorkspace(request.input, workspaces, request.toolName)
      if (workspace !== null && isAllowedForSession(threadId, request.toolName, workspace)) {
        void addToolApprovalResponse({ id: request.approvalId, approved: true })
      }
    }
  }, [messages, addToolApprovalResponse, workspaces, threadId])

  const flushNext = useCallback(() => {
    const [next, ...rest] = pending.current
    if (next === undefined) return
    pending.current = rest
    setQueuedCount(rest.length)
    // 走统一发送入口：补发同样过"超阈值先压缩"的预检（用户排队时可能已越过阈值）
    dispatch(next)
  }, [dispatch])

  /**
   * 一轮结束（从 busy 回到 ready）→ 补发排队的下一条。
   * 用 status 转移而不是 useChat 的 onFinish：Chat 实例是外部管理的（注册表持有），
   * onFinish 在构造时就绑给了完成通知那条路；这里只关心"忙完了、队列还排着没有"。
   * 出错收尾状态是 'error'（不是 ready），不自动补发——等用户决定重试还是改主意。
   * 还停在等审批（挂起轮）也不补发：用户还没做决策，替他往前跑只会把审批流搅乱。
   */
  const previousStatus = useRef(status)
  useEffect(() => {
    const wasBusy = previousStatus.current === 'submitted' || previousStatus.current === 'streaming'
    previousStatus.current = status
    if (wasBusy && status === 'ready' && !waitingApproval) flushNext()
  }, [status, flushNext, waitingApproval])

  /**
   * 发送：等审批期间与"流式中"同一口径 —— **不发**，进队列。
   * 为什么不是直发：审批挂起时直发会让 `sendAutomaticallyWhen` 的判定失效（它只看最后一条
   * 助手消息），决策回灌后再也不会自动续跑，卡片永远停在"审批已回应"；排队则等这一轮
   * （决策 → resume → 收尾）真正结束再发，语义与"流式中发送"完全一致。
   */
  const submit = useCallback(
    (text: string) => {
      if (busy || waitingApproval || compacting || sending.current) {
        pending.current = [...pending.current, text]
        setQueuedCount(pending.current.length)
        return
      }
      dispatch(text)
    },
    [busy, waitingApproval, compacting, dispatch]
  )

  /** 编辑重发（R2）：服务端截断 → 客户端截断重发；截断失败不重发（否则历史两边不一致）。
   *  T13 N1：与编辑入口同一道闸门——流式中/等审批期间不动作（截断会把挂起消息删掉，而服务端
   *  run 快照还在，决策会对着空气回灌；流式中则是对当前这条流并发。闸门只在旧重试卡这条
   *  窄路径上会被擦边：编辑入口本身在挂起期间是关的）。 */
  const editResend = useCallback(
    (messageId: string, text: string) => {
      if (busy || waitingApproval || compacting) return
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
    [busy, waitingApproval, compacting, sendMessage, threadId]
  )

  /** 重试 = 整轮重生成：先删掉最后一条助手回复，再 regenerate（防止新旧回复在存储里合并）。
   *  T13 N1：同 editResend——等审批/流式中不重试（错误卡的旧重试按钮不能绕开闸门）。 */
  const retry = useCallback(() => {
    if (busy || waitingApproval || compacting) return
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
  }, [busy, waitingApproval, compacting, messages, regenerate, threadId])

  /** 截断失败的重试：把刚才没做完的动作原样再做一遍 */
  const retryPendingSync = useCallback(() => {
    if (!pendingSync) return
    if (pendingSync.kind === 'edit') {
      editResend(pendingSync.messageId, pendingSync.text ?? '')
    } else {
      retry()
    }
  }, [editResend, pendingSync, retry])

  /** 「/」→「压缩上下文」（round 19）：立即压缩并给 notice；流式/等审批/压缩中命令行为禁用态 */
  const compactManually = useCallback(() => {
    if (busy || waitingApproval || compacting) return
    setCompactNotice(null)
    void runCompact().then((outcome) => {
      if (!outcome.ok) {
        setCompactNotice({ tone: 'danger', text: `压缩失败：${outcome.error}` })
      } else if (!outcome.compacted) {
        setCompactNotice({ tone: 'warning', text: '当前没有可压缩的旧消息' })
      } else {
        setCompactNotice({
          tone: 'success',
          text: `已压缩历史上下文（保留最近 ${outcome.compaction?.kept ?? 0} 条）`
        })
      }
    })
  }, [busy, waitingApproval, compacting, runCompact])

  const syncError = pendingSync
    ? new Error('会话历史没能在服务端同步，已取消发送（重试会重做这一步）')
    : null

  return (
    <>
      {/* round 27：对话顶部栏已外提到 ChatFrame 的 header 带（脱离限宽列）——这里只剩内容列 */}
      <MessageList
        messages={messages}
        status={status}
        // 流式中不给编辑入口：避免编辑触发的请求和当前这条流并发；
        // 等审批期间同样不给——编辑重发会先截断掉那条挂起消息，服务端 run 快照还在（决策会对着空气回灌）；
        // round 19：压缩进行中也不给（两边都动同一批消息）
        onEdit={busy || waitingApproval || compacting ? undefined : editResend}
        workspaces={workspaces}
        onApprovalDecision={decideApproval}
        compaction={compaction}
        compacting={compacting}
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
      {permissionError === null ? null : (
        <p data-testid="approval-permanent-error" className="px-4 pt-2 text-c1 text-danger">
          {permissionError}
        </p>
      )}
      <div className="shrink-0 px-4 pt-4 pb-6">
        <Composer
          threadId={threadId}
          busy={busy}
          queuedCount={queuedCount}
          onSend={submit}
          onStop={() => {
            void stop()
          }}
          onCompact={compactManually}
          compactBusy={compacting}
          compactDisabled={busy || waitingApproval}
          externalNotice={compactNotice}
        />
      </div>
    </>
  )
}
