import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { Chat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage } from 'ai'
import type { ThreadCompaction } from '@shared/threads'
import { cn } from '@renderer/components/ui/cn'
import { getTransport, threadRequestOptions } from '@renderer/lib/agent'
import { compactThread, fetchThreadCompaction, truncateThread } from '@renderer/lib/threads-api'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { shouldCompact, thresholdTokensOf } from '@renderer/lib/compact'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { OutgoingMessage } from './composer-attachments'
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
import type { ThreadChatRuntime, TurnOutcome } from './thread-chats'
import { ApprovalDock } from './ApprovalDock'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { ErrorCard } from './ErrorCard'
import { MessageList } from './MessageList'
import { WelcomeHero } from './WelcomeHero'

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
 *
 * round 59：内容区（ActiveChat）改成三格弹性布局（消息区 / 初始页标题 / 页脚 + 底部弹性占位）——
 * 空会话时消息区与占位等分剩余高度，输入框落到竖直中位、标题在它上方居中偏上；首条消息到达后
 * 占位收到 0，输入框平滑落回常规底部（不重挂、不硬切）。口径见 ActiveChat 的 `hero`。
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 轮末提示（round 33）：一轮**看起来跑完、其实是被截停/截断**时给一行人话。
 *   - `tool-calls` 收尾且没有待审批 = "还欠一次模型调用就收尾"：单轮步数预算（KYCLAW_MAX_STEPS）
 *     用尽。这是用户实报的"任务没完成就中断了"——引擎语义不变，但界面必须说出来；
 *   - `length` = 模型输出被长度上限截断（工具照执行、不续跑，见 tool-roundtrip.spec 钉住的语义）。
 * 其余收尾原因（stop / abort / error / 无值）不提示：那是正常的结束或另有错误卡在管。
 */
function turnNoticeOf(outcome: TurnOutcome): string | null {
  if (outcome.isError || outcome.isAbort || outcome.awaitingApproval) return null
  if (outcome.finishReason === 'tool-calls') return '已达单轮步数上限，回复「继续」可接着做'
  if (outcome.finishReason === 'length') return '输出达到长度上限，内容被截断'
  return null
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
  /** round 33：轮末提示（被步数预算截停 / 输出被截断）；null = 不显示 */
  const [turnNotice, setTurnNotice] = useState<string | null>(null)
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
  const baseRuntime = runtime ?? defaultRuntime
  /**
   * round 33：包一层 onTurnEnd —— 不论 runtime 是注入的还是默认的，都在这里按 finishReason
   * 算出轮末提示（null = 清除），再原样交给下游回调。
   */
  const activeRuntime = useMemo<ThreadChatRuntime>(
    () => ({
      ...baseRuntime,
      onTurnEnd: (id, outcome) => {
        setTurnNotice(turnNoticeOf(outcome))
        baseRuntime.onTurnEnd(id, outcome)
      }
    }),
    [baseRuntime]
  )
  const clearTurnNotice = useCallback(() => setTurnNotice(null), [])

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
      <ActiveChat
        chat={chat}
        threadId={threadId}
        turnNotice={turnNotice}
        onClearTurnNotice={clearTurnNotice}
      />
    </ChatFrame>
  )
}

interface ActiveChatProps {
  chat: Chat<UIMessage>
  threadId: string
  /** round 33：轮末提示（被步数预算截停 / 输出被截断）；null = 不显示 */
  turnNotice: string | null
  /** 新一轮开始（发送 / 重试 / 编辑重发 / 审批续跑）时清掉上一轮的提示 */
  onClearTurnNotice: () => void
}

/** 编辑/重试先要在服务端截断的那一步失败了：带着原动作重试 */
interface PendingSync {
  kind: 'edit' | 'retry'
  messageId: string
  text?: string
}

function ActiveChat({
  chat,
  threadId,
  turnNotice,
  onClearTurnNotice
}: ActiveChatProps): React.JSX.Element {
  /**
   * 流式中发的消息排队（最简队列：先进先出，一轮结束自动发下一条）。
   * 队列本体放 ref（状态回调里要读最新值）；state 只存条数给界面看。
   * 队列装的是**完整载荷**（正文 + 要真发的图片），不是纯文本——模块 2 起图片是 file part。
   */
  const pending = useRef<OutgoingMessage[]>([])
  const [queuedCount, setQueuedCount] = useState(0)
  /** 服务端截断失败时的重试素材（不静默丢） */
  const [pendingSync, setPendingSync] = useState<PendingSync | null>(null)
  /** round 19：压缩记录（对话流里那条「上下文已压缩」分界线的数据面） */
  const [compaction, setCompaction] = useState<ThreadCompaction | null>(null)
  /**
   * round 59 修正：分界线的**冻结锚点** —— 压缩成功且真压了的那一刻记下（记录时间 + 当时的消息条数）。
   *
   * 为什么非得冻结：手动压缩时列表里已经有**本轮新发**的消息（客户端消息不带时间戳），它们其实
   * 存在于压缩之前（会被算进保留窗口）——只按时间戳判会把分界线插到它们前面（错位）。真实时间轴
   * 只有两个来源，锚点在手的这一段由锚点说了算：压缩那一刻在手的消息全在分界线之上，之后到达的
   * 消息全在它之下。
   *
   * 失效口径：`createdAt` 与当前记录不一致（记录被换了一轮）、或 `threadId` 变了（切会话）→ 忽略
   * 锚点，回落成时间戳规则；重开会话本来就没有锚点，位置由时间戳算出来（不漂移）。
   */
  const [compactionAnchor, setCompactionAnchor] = useState<{
    threadId: string
    createdAt: string
    index: number
  } | null>(null)
  /** 当前消息条数的实时值（压缩回调里要取"那一刻"的条数，不能吃闭包旧值） */
  const messageCountRef = useRef(0)
  /** 压缩进行中（自动触发 / 手动入口共用；发送会按 busy 语义排队） */
  const [compacting, setCompacting] = useState(false)
  /**
   * 压缩的**操作反馈** notice（交给 Composer 显示）。
   * round 59 起只装"操作失败"这一类：失败 / 没有可压缩的旧消息；成功与进行中是对话流里的事件
   * （分界线），不再占用输入框那一行。
   */
  const [compactNotice, setCompactNotice] = useState<ComposerNotice | null>(null)
  /**
   * round 57：上下文用量的取数信号（每 +1 让上下文环与「压缩上下文」胶囊重取一次）。
   * 原来环只在挂载 / 换会话 / 点开时取数，轮结束不刷 → 用量越过 80% 了按钮也不露面。
   */
  const [usageVersion, setUsageVersion] = useState(0)
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
  /**
   * 输入框上方审批条的数据（round 29）：当前挂起的审批，刨掉"本会话允许"命中的那些 ——
   * 命中的会由下面的 effect 立刻回灌放行，先把它们画出来只会闪一下。
   * 同一步多个挂起 → 按 part 顺序堆叠，逐个处理。
   */
  const dockApprovals = useMemo(
    () =>
      pendingApprovals(messages[messages.length - 1]).filter((request) => {
        const workspace = resolveApprovalWorkspace(request.input, workspaces, request.toolName)
        return workspace === null || !isAllowedForSession(threadId, request.toolName, workspace)
      }),
    [messages, workspaces, threadId]
  )
  /** "永久允许"没写进设置（只在本次对话生效）：露一行给用户，不静默当成永久生效 */
  const [permissionError, setPermissionError] = useState<string | null>(null)

  /** 消息条数的实时值：压缩回调里要取"那一刻"的条数（useCallback 闭包里的是旧值） */
  useEffect(() => {
    messageCountRef.current = messages.length
  }, [messages.length])

  /** 压缩记录随会话挂载读一次（分界线的数据面；取不到就停在无分界线态，不打扰对话） */
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
      // round 57：真压了 → 服务端的用量随之变了，让环与「压缩上下文」胶囊重取一次
      // （压到线下就自己收起来，不把一枚已经没意义的按钮留在工具条上）
      if (result.compacted) setUsageVersion((version) => version + 1)
      /**
       * round 59 修正：真压了就**冻结锚点** —— 分界线钉在"压缩那一刻在手的消息之后"
       * （手动压缩时列表里的本轮新发消息也算在压缩之前，光看时间戳判不出来，见上方注释）。
       * 条数从 ref 取（这个回调是 useCallback，闭包里的 messages 是旧值）。
       */
      if (result.compacted && result.compaction !== null) {
        setCompactionAnchor({
          threadId,
          createdAt: result.compaction.createdAt,
          index: messageCountRef.current
        })
      }
      return { ok: true, compacted: result.compacted, compaction: result.compaction }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      setCompacting(false)
    }
  }, [threadId])

  /**
   * round 49：草稿会话在**发送那一刻**先物化成真线程（POST /api/threads，与"首条消息建线程"
   * 同一条存储路径）。为什么非做不可：镜像要等轮末（handleTurnEnd 的乐观插入 + refresh）才有它，
   * 而侧栏的草稿行只在 activeId 还停在草稿上时渲染——发送后、AI 回复前切走会话，这一行两边都不在，
   * 整个会话就从侧栏消失了（用户实报）。先落成真身（项目归属本来就在映射里），切走也还在。
   * 顺序：**先 await 物化、再发**——服务端两处建线程都是 upsert，顺序化之后根本不并发；
   * 物化失败**不挡发送**（原始 error 落控制台留底）：服务端首条消息照样建线程，
   * 轮末 handleTurnEnd 还有乐观兜底，用户的消息不能因为这一下没落成而卡住。
   */
  const ensureMaterialized = useCallback(async (): Promise<void> => {
    if (useSessionsStore.getState().threads.some((thread) => thread.id === threadId)) return
    try {
      await useSessionsStore.getState().materialize(threadId)
    } catch (error) {
      console.error('[kyclaw] 会话物化失败（照常发送）', error)
    }
  }, [threadId])

  /**
   * 发送预检（round 19 自动触发）：最近一轮上下文用量 ≥ 阈值（contextPct × contextWindow）时
   * 先压一轮再发；压缩失败不阻塞——照常发送 + 一行警示。用量取不到（服务没起来 / usage 行
   * 还没落）就不压缩：如实降级，不假装判过（偏差见报告）。
   */
  const sendWithPreflight = useCallback(
    async (message: OutgoingMessage): Promise<void> => {
      setCompactNotice(null)
      // round 49：物化在最前（压缩也要求线程已经在服务端，见路由的 404 口径）
      await ensureMaterialized()
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
      // 图片走 file part（module 2）：没有图片时连字段都不带，保持"纯文本消息"的老形状
      void sendMessage(
        {
          text: message.text,
          ...(message.files.length === 0 ? {} : { files: message.files })
        },
        threadRequestOptions(threadId)
      )
    },
    [ensureMaterialized, runCompact, sendMessage, threadId]
  )

  /** 统一发送入口（submit 与队列补发都走它）：预检锁覆盖预检窗口，防双发 */
  const dispatch = useCallback(
    (message: OutgoingMessage): void => {
      sending.current = true
      void sendWithPreflight(message).finally(() => {
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

  /**
   * round 33：新一轮开跑就清掉上一轮的"被截停/被截断"提示 —— 发送、审批续跑、重试、编辑重发
   * 都会把 status 推到 submitted/streaming，统一在这里收口（提示不会赖在界面上）。
   */
  useEffect(() => {
    if (status === 'submitted' || status === 'streaming') onClearTurnNotice()
  }, [status, onClearTurnNotice])

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
   * round 57：同一处顺手把用量取数信号 +1（新一轮用量已落库 → 环与「压缩上下文」胶囊刷新）。
   */
  const previousStatus = useRef(status)
  useEffect(() => {
    const wasBusy = previousStatus.current === 'submitted' || previousStatus.current === 'streaming'
    previousStatus.current = status
    if (!wasBusy || status !== 'ready') return
    setUsageVersion((version) => version + 1)
    if (!waitingApproval) flushNext()
  }, [status, flushNext, waitingApproval])

  /**
   * 发送：等审批期间与"流式中"同一口径 —— **不发**，进队列。
   * 为什么不是直发：审批挂起时直发会让 `sendAutomaticallyWhen` 的判定失效（它只看最后一条
   * 助手消息），决策回灌后再也不会自动续跑，卡片永远停在"审批已回应"；排队则等这一轮
   * （决策 → resume → 收尾）真正结束再发，语义与"流式中发送"完全一致。
   */
  const submit = useCallback(
    (message: OutgoingMessage) => {
      if (busy || waitingApproval || compacting || sending.current) {
        pending.current = [...pending.current, message]
        setQueuedCount(pending.current.length)
        return
      }
      dispatch(message)
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

  /**
   * 「/」→「压缩上下文」（round 19）：立即压缩；流式/等审批/压缩中命令行为禁用态。
   * round 59：**成功不在这里报**——压缩是对话流里的一件事（分界线自己会说），输入框区只留
   * 操作失败的反馈（失败 / 没有可压缩的旧消息）。
   */
  const compactManually = useCallback(() => {
    if (busy || waitingApproval || compacting) return
    setCompactNotice(null)
    void runCompact().then((outcome) => {
      if (!outcome.ok) {
        setCompactNotice({ tone: 'danger', text: `压缩失败：${outcome.error}` })
      } else if (!outcome.compacted) {
        setCompactNotice({ tone: 'warning', text: '当前没有可压缩的旧消息' })
      }
    })
  }, [busy, waitingApproval, compacting, runCompact])

  const syncError = pendingSync
    ? new Error('会话历史没能在服务端同步，已取消发送（重试会重做这一步）')
    : null

  /**
   * round 59：初始页（空会话）—— 消息为空、没有错误、没有待审批时，输入框居中 + 品牌标题。
   *
   * 两条口径（都写在这里，免得后面来回猜）：
   *   1. **初始页优先于完成态分界线**：消息为空就没有"对话流里的时间点"可放，有压缩记录也不画
   *      （记录本身没丢，首条消息到达后按定位规则出现在流里；现实里保留窗口 ≥ 2 条，
   *      "空会话 + 记录"只有测试造得出来）；
   *   2. **"正在压缩"是例外**：它是正在发生的事，首条消息发出前的自动预压也得让用户看得见
   *      （那一步可能挺久），所以压缩中不按初始页算 —— 输入框正常落位、分界线显示进行中。
   */
  const hero = messages.length === 0 && !error && !waitingApproval && !compacting

  /**
   * round 59：分界线的固定下标（锚点在手时用；否则 undefined = MessageList 自己按时间戳算）。
   * `Math.min` 那一下是**截断后的兜底**：编辑重发会把这轮之后的消息删掉，锚点可能超出当前条数
   * ——不 clamp 的话分界线既落不到任何消息之前、也不等于列表长度，整行就消失了。
   */
  const compactionIndex =
    compactionAnchor !== null &&
    compactionAnchor.threadId === threadId &&
    compactionAnchor.createdAt === compaction?.createdAt
      ? Math.min(compactionAnchor.index, messages.length)
      : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 消息区：常规布局里占满剩余高度；初始页里消息为空，它只是上半格的弹性占位。
          round 27：对话顶部栏已外提到 ChatFrame 的 header 带（脱离限宽列）——这里只剩内容列 */}
      <div className="min-h-0 flex-1">
        <MessageList
          messages={messages}
          status={status}
          // 流式中不给编辑入口：避免编辑触发的请求和当前这条流并发；
          // 等审批期间同样不给——编辑重发会先截断掉那条挂起消息，服务端 run 快照还在（决策会对着空气回灌）；
          // round 19：压缩进行中也不给（两边都动同一批消息）
          onEdit={busy || waitingApproval || compacting ? undefined : editResend}
          compaction={hero ? null : compaction}
          compacting={compacting}
          compactionIndex={compactionIndex}
        />
      </div>

      {/* round 59：初始页的品牌标题（空会话才出现；离场走收合，不硬切） */}
      <WelcomeHero active={hero} />

      {/* 初始页的页脚浮起（淡入 + 上浮，比标题晚 80ms 起步）；
          切常规布局时这几条类名被摘掉，元素本身**不重挂**——输入框全程可用（draft/焦点不丢） */}
      <div
        data-testid="chat-footer"
        className={cn('shrink-0', hero && 'animate-message-in [animation-delay:80ms]')}
      >
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
        {/* round 33：轮末提示（被步数预算截停 / 输出被截断）——输入框上方一行，随新轮开始清除 */}
        {turnNotice === null ? null : (
          <p
            data-testid="turn-notice"
            role="status"
            className="animate-fade-in px-4 pt-2 text-b2 text-warning"
          >
            {turnNotice}
          </p>
        )}
        <div className="shrink-0 px-4 pt-4 pb-6">
          {/* round 29（用户口径）：待审批统一停靠在输入框正上方（主列宽度内、与输入卡同宽） */}
          <ApprovalDock
            requests={dockApprovals}
            workspaces={workspaces}
            onDecide={decideApproval}
          />
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
            usageVersion={usageVersion}
          />
        </div>
      </div>

      {/* round 59：初始页的下半格弹性占位 —— 与消息区等分剩余高度，标题与输入框因此落在竖直中位；
          首条消息到达时它收到 0（flex-grow 过渡，主档 .3s），输入框平滑落到常规底部，不硬切 */}
      <div
        data-testid="welcome-spacer"
        className={cn(
          'h-0 basis-0 transition-[flex-grow] duration-(--motion-main) ease-main motion-reduce:transition-none',
          hero ? 'grow' : 'grow-0'
        )}
      />
    </div>
  )
}
