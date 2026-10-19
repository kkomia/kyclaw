import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { Chat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage } from 'ai'
import type { ThreadCompaction } from '@shared/threads'
import { cn } from '@renderer/components/ui/cn'
import { resolveAgentEndpoint, threadRequestOptions, transportFor } from '@renderer/lib/agent'
import {
  compactThread,
  fetchThreadCompaction,
  truncateThread,
  fetchThreadMessages
} from '@renderer/lib/threads-api'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { taskSession, tasksStore } from '@renderer/lib/tasks-store'
import { shouldCompact, thresholdTokensOf } from '@renderer/lib/compact'
import { startupMark } from '@renderer/lib/startup-timing'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { OutgoingMessage } from './composer-attachments'
import { buildUserMessageMetadata, carryOverMessageContext } from './message-context'
import type { MessageContext } from './message-context'
import {
  allowForSession,
  canResumeAfterApproval,
  isAllowedForSessionNow,
  pendingApprovals,
  resolveApprovalWorkspace
} from './approval'
import type { ApprovalRequest } from './approval'
import type { ApprovalDecision } from './ApprovalCard'
import type { ComposerModeMenu, ComposerNotice } from './ComposerControls'
import { createThreadChatRuntime, threadChat, dropThreadChat, pendingChat } from './thread-chats'
import type { ThreadChatRuntime, TurnOutcome } from './thread-chats'
import { publishDraft } from './composer-inbox'
import { ApprovalDock } from './ApprovalDock'
import { AskUserDock } from './AskUserDock'
import { TaskDockSlot } from './TaskDockSlot'
import { useStore } from 'zustand'
import { PlanModeChip } from './PlanModeChip'
import { kernelPlanActive } from './plan-ui'
import { EMPTY_ASK_USER_THREAD, useAskUserStore } from './ask-user-store'
import { askUserCallKey } from './ask-user-ui'
import { hasPendingAskUser, chatStreamActive } from './ask-user'
import { askUserResumeBody } from '@renderer/lib/ask-user-api'
import { askUserAcceptedMetadata } from '@renderer/lib/agent'
import { mapStoredMessages } from '@renderer/lib/message-map'
import { ChatHeader } from './ChatHeader'
import type { ChatView } from './ChatHeader'
import { CollapsibleRow } from './CollapsibleRow'
import { Composer } from './Composer'
import { ErrorCard } from './ErrorCard'
import { StartupFailureCard } from './StartupFailureCard'
import { RETRY_KEEP_METADATA_KEY, RETRY_KEEP_PROMPT, preservedRecordsOf } from './retry-keep'
import { GoalCommandCard } from './GoalCommandCard'
import { GoalDockContainer } from './GoalDockContainer'
import { failurePresentationOf } from './turn-failure'
import { useUsageStream } from './useUsageStream'
import { pushUsage } from './usage-live'
import { fetchKernelCatalog, kernelEnabled, runKernelCommand } from './kernel-command-api'
import { KernelInteractionDock } from './b3-5/KernelInteractionDock'
import { KernelInteractionResults } from './b3-5/KernelInteractionResults'
import { useKernelInteractions } from './b3-5/use-kernel-interactions'
import type {
  KernelCommandSummary,
  KernelGoalProjection,
  KernelPlanProjection
} from '@shared/kernel-ui'
import { MessageList } from './MessageList'
import { WelcomeHeatmap } from './parts/WelcomeHeatmap'
import { ProjectChip } from './ProjectChip'
import { usePptTemplatesStore } from './ppt-templates-store'
import './chat-width.css'
import { WelcomeHero } from './WelcomeHero'
import { TrajectoryView } from '@renderer/features/trajectory/TrajectoryView'

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
 *
 * round 62：**排队队列挂在会话 store 上**（`sessions-store` 的 `queues`，按 threadId 存），
 * 不再放 ActiveChat 的组件内 ref —— 切会话就是卸载（`key={activeId}`），队列与计数会跟着蒸发；
 * 现在切走再切回队列原样还在，轮末（或切回来那一刻）照常补发。
 *
 * round 76（输入卡先出来）：**这三层不再各自早退**。原来"端点没解析 / 会话没定 / 历史没回灌"
 * 三档都是 `return <ChatFrame>…</ChatFrame>`，输入卡（在 ActiveChat 的页脚里）就成了整条链的
 * 最后一环 —— 生产 bundle 加载快，用户先看到的是"正在连接…"，能打字要等一千多毫秒。现在：
 *   - ChatPage 三档都渲染**同一挂** ChatSession（transport/threadId 可以为 null）；
 *   - ChatSession 把"消息区画什么"与"输入卡挡什么"收进一枚 `pending`（connecting / loading /
 *     error），**输入卡从第一帧就挂着**，只有消息区换内容 —— 所以载入过程中也能聚焦、能打字；
 *   - 未就绪时发送一律挡住（按钮禁用 + 回车不发 + 工具条一行状态文字），就绪后自动恢复；
 *     那一段里 `useChat` 先挂在占位 Chat 上（见 thread-chats 的 `pendingChat`）。
 * "会话 id 未定 → 定下来"会让这一挂按 key 换挂（切会话=换一挂的既有口径），那一下的
 * 草稿/附件/焦点由 composer-carryover 过桥带走。
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
  if (outcome.isError || outcome.isAbort || outcome.awaitingApproval || outcome.waitingInteraction)
    return null
  if (outcome.finishReason === 'tool-calls') return '已达单轮步数上限，回复「继续」可接着做'
  if (outcome.finishReason === 'length') return '输出达到长度上限，内容被截断'
  return null
}

/**
 * 截断没做成时给用户看的那句话（round 61 起按动作分档）：撤回与发送/重生成是两件事，
 * 别说成同一句话；两者都**不静默**（走 pendingSync → 错误卡 +「重试」重做这一步）。
 */
function syncErrorOf(pendingSync: PendingSync): Error {
  return new Error(
    pendingSync.kind === 'undo'
      ? '会话历史没能在服务端同步，已取消撤回（重试会重做这一步）'
      : '会话历史没能在服务端同步，已取消发送（重试会重做这一步）'
  )
}

/** 对话页的外框（round 21 拆两层；round 27 顶栏外提）：
 *  外层 = **聊天区整幅**（相对定位基准：消息导览轨贴它的右缘 8px，图2 口径）；
 *  `header` = **对话顶部栏**（round 27 用户口径：标题贴面板最左，脱离限宽列）——横跨主列整幅，
 *  用 `ml-(--content-safe-left)` 让到"内容卡可见左缘"（侧栏是覆盖层，卡片可见部分从 safe-left 起）；
 *  配合 header 自身 pl-2 + 标题按钮 px-2 → 标题左缘 = 内容卡左缘 + 16px（不再被居中列推开）。
 *  内层 = **限宽内容列**（.chat-column；task-114 宽度照 DSH 公式，见 chat-width.css：
 *  内容宽 = clamp(680px, 64cqi, 920px)，输入卡 = 内容宽 + 32；消息区 + 发送框都挂在它里面，
 *  否则会横向铺满主列被覆盖层侧栏裁掉；routes.spec / chat-flow.spec 认的也是它）。
 *  testid：`chat-page` = 外层整幅（相对定位与"聊天区右缘"的量距基准），`chat-column` = 内容列容器。
 *
 *  轨迹层（本轮）：`overlay` 是挂在**限宽列之外**的覆盖层（同层、同级）。为什么不让轨迹也进
 *  限宽列：时间轴 + 步骤列表 + 明细面板三件并排，800px 的对话列放不下；轨迹是"看数据"的视图，
 *  铺满主列理所当然。两块内容**同时挂载**，靠 opacity 交叉淡入（不硬切、也不重挂输入框：
 *  草稿/焦点/在跑的流全程不丢）。 */
function ChatFrame({
  header,
  overlay,
  children
}: {
  header?: React.ReactNode
  /** 覆盖层（当前只有轨迹层）：与限宽列同级、整幅可铺 */
  overlay?: React.ReactNode
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
      {/* `isolate`（task-50）：给 A 的纸感层（.welcome-paper，z-index:-1）一个**局部层叠上下文** ——
          纸感只落在 chat 内容层内、垫在所有内容之下，不会跑到壳/内容卡背景后面。
          刻意仍不写 `.relative` 类：消息导览轨按 `closest('.relative')` 认整幅 chat 页根。 */}
      <div className="[position:relative] isolate flex min-h-0 flex-1 flex-col">
        {/* 这一层是**覆盖层的定位基准**（与限宽列同级、比 chat-page 少一条顶部栏）。
            它刻意**不写 `.relative` 这个类**、而是用等价的 `[position:relative]`：对话页的
            消息导览轨按 `closest('.relative')` 认"整幅 chat 页根"（round 21 的既定口径），
            多一个带这个类的祖先会把轨道的基准缩到"顶部栏以下"，轨道会整体上移半条栏高。
            要改这层：先看 chat-flow.spec 里那条"定位基准是 chat 页根"的用例。 */}
        <div data-testid="chat-column" className="chat-column flex min-h-0 flex-1 flex-col">
          {children}
        </div>
        {overlay}
      </div>
    </section>
  )
}

/**
 * 会话还没定下来时用的**占位会话 id**（round 76）。
 *
 * 为什么要有：输入卡要从这一屏的**第一帧**就在（能聚焦、能打字），而那时端点/会话列表/历史
 * 回灌都还没回来。Composer 与 ActiveChat 里一堆"按会话记账"的东西（发送队列、草稿归属、
 * 权限的会话记忆）需要一个 string，所以拿这一枚顶着；真 id 一到就换掉 —— 换 id 会让这一挂按
 * key 重挂（"换会话 = 换一挂"的既有口径），那一下的草稿/附件/焦点由 composer-carryover 过桥带走。
 * 这一枚**永远不会**带着请求发出去：实例没就绪时发送是挡住的（见 ActiveChat 的 `pending`）。
 */
export const PENDING_THREAD_ID = 'kyclaw-pending'

export function ChatPage(): React.JSX.Element {
  const [transport, setTransport] = useState<ChatTransport<UIMessage> | null>(null)
  const [endpointError, setEndpointError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const activeId = useSessionsStore((state) => state.activeId)
  const initLandedId = useSessionsStore((state) => state.initLandedId)
  const ensureLoaded = useSessionsStore((state) => state.ensureLoaded)
  const ensureProjectsLoaded = useProjectsStore((state) => state.ensureLoaded)

  /**
   * R92：草稿过桥（composer-carryover）**只放行"系统初始化落位"这一次** —— `activeId` 就是
   * 载入（或失败兜底）那次"从无到有"选出来的会话（`activeId === initLandedId`）。其余的重挂
   * （用户切会话 / 新建 / 删除）都会清掉 `initLandedId`（见 sessions-store），因此一律不放行 ——
   * 用户主动换会话时输入卡上的字属于那个会话，不能跨会话泄露；发送物化/就绪本身不换 key，
   * 不经过这里。
   */
  const carryoverAllowed = activeId !== null && activeId === initLandedId

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  useEffect(() => {
    // 权限入口与工作台根都依赖会话项目映射；页面本身也要触发首轮加载。
    void ensureProjectsLoaded()
  }, [ensureProjectsLoaded])

  useEffect(() => {
    let alive = true
    // 端点**在这一屏只解析一次**：拿到手之后既拼 chat 传输、又交给 PPT 模板预取（见下）。
    // 拆成 resolveAgentEndpoint + transportFor 就是为了这件事 —— 原先两处各自
    // `agent.endpoint()`，一次页面加载会多问主进程一次（error-card 那条"端点恰好被解析 2 次"
    // 的用例就是被这一次多出来的 IPC 顶穿的）。
    // round 76：这一趟的等待**不再挡住输入卡** —— 端点没回来时这一屏照常渲染，只是发送挡着、
    // 状态位写着「正在连接…」（见下面的 ChatSession 与 ActiveChat 的 `pending`）。
    // 主进程那侧同时改成"挂起等一会儿"（见 main/ipc/agent.ts）：服务晚起几百毫秒不再直接失败。
    resolveAgentEndpoint()
      .then((endpoint) => {
        if (!alive) return
        // round 73：冷启动打点 —— 服务端点到手（此前一直卡在「正在连接…」）
        startupMark('服务端点就绪')
        setTransport(transportFor(endpoint))
        // round 66：端点在手之后拉一遍会话级 PPT 模板映射 —— 放在这里而不是上面那个 effect，
        // 是因为"服务还没起来"时 `agent.endpoint` 会抛（启动竞态），拉早了这一趟就白跑；
        // 拿到 transport 说明端点一定在了（切到某个会话时胶囊当场读得到，不闪一下）。
        // 这一轮补一句：**复用它刚解析出来的这一份端点**（不再重复问主进程）。
        // 预取失败只记日志、这个会话退化成"没选模板"，绝不能把对话页推进错误态 ——
        // 所以它**不进下面这条链**（不进 catch、也不 await），与改动前的 `void` 同形状。
        void usePptTemplatesStore.getState().ensureLoaded(endpoint)
      })
      .catch((cause) => {
        if (alive) setEndpointError(toError(cause))
      })
    return () => {
      alive = false
    }
  }, [reloadToken])

  const retryEndpoint = useCallback(() => {
    setEndpointError(null)
    setReloadToken((token) => token + 1)
  }, [])

  /**
   * 三档都在**同一挂**里表达（round 76）：不再各自 `return <ChatFrame>…</ChatFrame>` ——
   * 那几个早退分支会把输入卡一起卸掉（"可输入"被压在整条链的最后，用户实报的观感问题）。
   * 现在一律交给 ChatSession：它把"消息区画什么"与"输入卡挡什么"放在同一棵树上，
   * 输入卡因此**从第一帧就在**，只换消息区。
   *
   * key = 会话 id（未定时用占位 id）：切换会话就换一挂（Chat 实例在注册表里活着，流不中断）。
   */
  return (
    <ChatSession
      key={activeId ?? PENDING_THREAD_ID}
      transport={transport}
      threadId={activeId}
      endpointError={endpointError}
      onRetryEndpoint={retryEndpoint}
      carryoverAllowed={carryoverAllowed}
    />
  )
}

export interface ChatSessionProps {
  /** 端点还没解析出来时是 null（这一屏照常渲染，只是发送挡着） */
  transport: ChatTransport<UIMessage> | null
  /** 会话还没定下来（列表还在拉）时是 null */
  threadId: string | null
  /** 测试注入：默认走服务端回灌 + sessions-store 的完成处理 */
  runtime?: ThreadChatRuntime
  /** 端点解析失败（这一屏取数链的第一环）：消息区给错误卡 + 重试 */
  endpointError?: Error | null
  onRetryEndpoint?: () => void
  /**
   * R92：允许这一挂接"上一挂的草稿过桥"吗（默认 true —— 直接使用 ChatSession 的既有口径，
   * 只有"未就绪挂 → 同一次初始化落位"这一条路会真的留下过桥）。ChatPage 只在
   * "系统初始化落位"那一次传真值：用户主动换会话 / 新建 / 删除 触发的重挂一律拒绝。
   */
  carryoverAllowed?: boolean
}

export function ChatSession({
  transport,
  threadId,
  runtime,
  endpointError = null,
  onRetryEndpoint,
  carryoverAllowed = true
}: ChatSessionProps): React.JSX.Element {
  const [reloadToken, setReloadToken] = useState(0)
  /**
   * 会话实例还没定下来时用的那枚占位 id（真 id 一到就换，见 PENDING_THREAD_ID）。
   * 这一挂里所有"按会话记账"的地方都用它，保证"实例未就绪"这一段也有一个确定的 string。
   */
  const sessionThreadId = threadId ?? PENDING_THREAD_ID
  /**
   * 本轮新增：**对话 / 轨迹**这一对页签的状态挂在这里 —— 它与页签、两块内容同层
   * （页签在 ChatHeader 里，两块内容在下面），放在更外面会让"换会话"带走它、放更里面
   * 又拿不到两边的兄弟关系。两块内容始终挂载（见下面的层），所以这个 state 不用持久化。
   */
  const [view, setView] = useState<ChatView>('chat')
  /**
   * 轨迹的取数信号：会话行的 `updatedAt`。一轮结束会刷新会话列表（handleTurnEnd），
   * 那个时间戳随之变化 —— 于是"跑完一轮回到轨迹页"看到的是新的那份，不需要另铺一条回调。
   */
  const trajectoryRevision = useSessionsStore(
    (state) => state.threads.find((thread) => thread.id === sessionThreadId)?.updatedAt ?? ''
  )
  const interactionRevision = useAskUserStore((state) => state.threads.get(sessionThreadId))
  /** round 33：轮末提示（被步数预算截停 / 输出被截断）；null = 不显示 */
  const [turnNotice, setTurnNotice] = useState<string | null>(null)
  /**
   * 解析结果与它对应的 key 一起存：key 变了（换会话/重试）就自然回到"载入中"，
   * 不需要在 effect 里同步 setState 清场（那会触发级联渲染）。
   */
  const resolveKey = `${sessionThreadId}#${reloadToken}`
  const [resolved, setResolved] = useState<{
    key: string
    chat: Chat<UIMessage> | null
    error: Error | null
  } | null>(null)

  const defaultRuntime = useMemo(
    () =>
      transport === null
        ? null
        : createThreadChatRuntime(transport, (finishedThreadId, outcome) => {
            // 出错/用户主动停止不算"完成"，不通知也不生成标题；
            // "还停在等审批"的挂起轮同样不算 —— 审批卡还等着用户，标题与完成通知都该等 resume 之后那轮
            if (
              outcome.isError ||
              outcome.isAbort ||
              outcome.awaitingApproval ||
              outcome.waitingInteraction
            )
              return
            void useSessionsStore.getState().handleTurnEnd(finishedThreadId)
          }),
    [transport]
  )
  const baseRuntime = runtime ?? defaultRuntime
  /**
   * round 33：包一层 onTurnEnd —— 不论 runtime 是注入的还是默认的，都在这里按 finishReason
   * 算出轮末提示（null = 清除），再原样交给下游回调。
   * round 76：端点还没到时 `defaultRuntime` 是 null（没有 transport 就拼不出 runtime）——
   * 这一层跟着判空，下面就绪之前压根不会去解析会话实例。
   */
  const activeRuntime = useMemo<ThreadChatRuntime | null>(
    () =>
      baseRuntime === null
        ? null
        : {
            ...baseRuntime,
            onTurnEnd: (id, outcome) => {
              setTurnNotice(turnNoticeOf(outcome))
              baseRuntime.onTurnEnd(id, outcome)
            }
          },
    [baseRuntime]
  )
  const clearTurnNotice = useCallback(() => setTurnNotice(null), [])

  /**
   * 会话实例的解析（历史回灌）——**只有真会话 id 到了才做**：占位 id 不是服务端的会话，
   * 拿它去拉历史只会白跑一趟。就绪之前输入卡照常挂着（发送挡着，见下面的 `pending`）。
   */
  useEffect(() => {
    if (threadId === null || activeRuntime === null) return
    let alive = true
    threadChat(threadId, activeRuntime).then(
      (created) => {
        if (!alive) return
        // round 73：冷启动打点 —— 历史回灌完成（输入框就此才可能出现）
        startupMark('历史回灌')
        setResolved({ key: resolveKey, chat: created, error: null })
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
  const resolveError = current?.error ?? null
  /**
   * round 76：输入卡从第一帧就挂着 —— `useChat` 必须拿到一个实例，没就绪这段先给它一枚**占位
   * Chat**（消息恒空、发送一律被挡）。实例到手之后 useChat 会跟着换过来（@ai-sdk/react 的
   * `useChat` 按 chat 身份重订阅，见它的 `chatKey`）。产物线任何请求都不会走占位那一枚：
   * 它的 transport 一被调用就抛。
   */
  const chat = current?.chat ?? pendingChat()
  /**
   * 会话实例就绪 = 端点到了 + 会话 id 定了 + 历史回灌成了（三者缺一，发送就不该放行：
   * 少任一环，发出去的请求要么打不到地方、要么带着空上下文）。异常那两档另有错误卡 + 重试。
   */
  const ready = transport !== null && threadId !== null && current?.chat != null

  const retry = useCallback(() => {
    dropThreadChat(threadId ?? sessionThreadId)
    setReloadToken((token) => token + 1)
  }, [threadId, sessionThreadId])

  /**
   * 就绪之前的那一档（消息区画什么 + 输入卡挡什么，一次说清；null = 就绪）：
   * 出错的排在前面（错误卡 + 重试是给用户看的唯一出口），其次"端点还在解析"，
   * 最后才是"会话/历史还在载入"。三档都**不卸载输入卡**。
   */
  const pending: ActiveChatPending | null = ready
    ? null
    : endpointError !== null
      ? { kind: 'error', error: endpointError, retry: onRetryEndpoint ?? retry, startup: true }
      : resolveError !== null
        ? { kind: 'error', error: resolveError, retry }
        : transport === null
          ? { kind: 'connecting' }
          : { kind: 'loading' }

  /**
   * 两块内容**同时挂载**、交叉淡入：
   *   - 对话层留在文档里（`opacity-0` + `inert`）——输入框草稿、焦点、正在跑的流、滚动位置全不丢；
   *     它继续占着布局（限宽列那层），所以切页签不会让页脚跳一下；
   *   - 轨迹层是整幅覆盖层（限宽列之外），激活时铺满主列、不激活时透明且不吃事件。
   * 两块都走主档时长的 opacity 过渡 —— 不硬切（雷点 5）。
   *
   * round 76：这一棵树**不因"就绪与否"换形状** —— 顶栏与轨迹层等就绪才挂（它们要真会话 id），
   * 而消息区 + 页脚那一格始终挂着（输入卡就在页脚里），所以"载入中 → 就绪"不重挂输入卡。
   */
  return (
    <ChatFrame
      header={
        ready ? (
          <ChatHeader threadId={sessionThreadId} view={view} onViewChange={setView} />
        ) : undefined
      }
      overlay={
        ready ? (
          <div
            data-testid="trajectory-layer"
            data-active={view === 'trajectory' ? 'true' : undefined}
            aria-hidden={view === 'trajectory' ? undefined : true}
            inert={view !== 'trajectory'}
            className={cn(
              'absolute inset-0 flex min-h-0 flex-col bg-surface pl-(--content-safe-left) transition-opacity duration-(--motion-main) ease-main motion-reduce:transition-none',
              view === 'trajectory' ? 'z-10 opacity-100' : 'pointer-events-none opacity-0'
            )}
          >
            <TrajectoryView
              threadId={sessionThreadId}
              active={view === 'trajectory'}
              revision={`${trajectoryRevision}:${JSON.stringify([interactionRevision?.pending, interactionRevision?.submitting, interactionRevision?.stopping])}`}
            />
          </div>
        ) : undefined
      }
    >
      <div
        data-testid="chat-pane"
        aria-hidden={view === 'chat' ? undefined : true}
        inert={view !== 'chat'}
        className={cn(
          'flex min-h-0 flex-1 flex-col transition-opacity duration-(--motion-main) ease-main motion-reduce:transition-none',
          view === 'chat' ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        <ActiveChat
          chat={chat}
          threadId={sessionThreadId}
          hasRealThread={threadId !== null}
          interactionsEnabled={runtime === undefined || runtime.refreshInteractions === true}
          pending={pending}
          turnNotice={turnNotice}
          onClearTurnNotice={clearTurnNotice}
          carryoverAllowed={carryoverAllowed}
        />
      </div>
    </ChatFrame>
  )
}

/**
 * 会话实例就绪之前的那一档（round 76）：**一次说清两件事** —— 消息区画什么、输入卡挡什么。
 * 放在一枚判定里而不是各自传几个 boolean，是为了"载入中"与"出错了"这两档不可能被拆成
 * 自相矛盾的两半（例如消息区在报错、输入卡却像没事一样能发）。
 *   - `connecting`：端点在解析（主进程那侧正挂起等服务起来）
 *   - `loading`：会话 id 或历史回灌还没到
 *   - `error`：端点和历史任一环失败（消息区错误卡 + 重试；输入卡只挡发送、不重复解释）
 */
export type ActiveChatPending =
  | { kind: 'connecting' }
  | { kind: 'loading' }
  | { kind: 'error'; error: Error; retry: () => void; startup?: boolean }

interface ActiveChatProps {
  chat: Chat<UIMessage>
  threadId: string
  /** PB-030 配合：threadId 是否真会话（false = PENDING_THREAD_ID 占位；交互/投影请求一律不打） */
  hasRealThread: boolean
  interactionsEnabled: boolean
  /** 实例就绪之前的那一档；null = 就绪（正常发消息） */
  pending: ActiveChatPending | null
  /** round 33：轮末提示（被步数预算截停 / 输出被截断）；null = 不显示 */
  turnNotice: string | null
  /** 新一轮开始（发送 / 重试 / 编辑重发 / 审批续跑）时清掉上一轮的提示 */
  onClearTurnNotice: () => void
  /** R92：草稿过桥的放行位（见 ChatSessionProps.carryoverAllowed） */
  carryoverAllowed: boolean
}

/**
 * 实例就绪之前消息区里的占位（round 76）：还在载入就一行状态，出错了就错误卡 + 重试。
 * 与改动前"整页换成错误卡"是同一句话、同一个重试入口，区别只是**不再把输入卡一起卸掉**
 * （草稿、附件、焦点都留在原地）。
 */
function PendingNotice({
  pending
}: {
  pending: Exclude<ActiveChatPending, null>
}): React.JSX.Element {
  if (pending.kind === 'error') {
    return (
      <div className="px-4 pt-6">
        {pending.startup === true ? (
          <StartupFailureCard error={pending.error} />
        ) : (
          <ErrorCard error={pending.error} onRetry={pending.retry} />
        )}
      </div>
    )
  }
  return (
    <p
      data-testid={pending.kind === 'connecting' ? 'chat-connecting' : 'chat-loading'}
      className="p-4 text-b2 text-ink-tertiary"
    >
      {pending.kind === 'connecting' ? '正在连接…' : '正在载入会话…'}
    </p>
  )
}

/** 编辑/重试/撤回先要在服务端截断的那一步失败了：带着原动作重试 */
interface PendingSync {
  kind: 'edit' | 'retry' | 'undo'
  messageId: string
  text?: string
}

function ActiveChat({
  chat,
  threadId,
  hasRealThread,
  interactionsEnabled,
  pending,
  turnNotice,
  onClearTurnNotice,
  carryoverAllowed
}: ActiveChatProps): React.JSX.Element {
  /** 实例就绪（round 76）：没就绪时不发不发、也不去服务端动历史，消息区画占位 */
  const ready = pending === null
  /**
   * round 62：排队队列**在会话 store 里**（按 threadId 存，见 sessions-store 的 `queues`）。
   *
   * 为什么不再用组件内的 ref：对话页按 `key={activeId}` 挂 ChatSession，切会话 = 卸载 ——
   * 队列与计数会静默消失（而 Composer 的承诺是"流式中按下发送不丢内容，交给上层排队"）。
   * 队列本体在 store 上之后，这里只**读自己那一格**的条数给界面看；回调里要最新值时走
   * `useSessionsStore.getState()`（闭包里的值可能是旧的）。队列装的是**完整载荷**
   * （正文 + 要真发的图片），不是纯文本——模块 2 起图片是 file part。
   */
  const queuedCount = useSessionsStore((state) => (state.queues[threadId] ?? []).length)
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
  /** PB-018：内核命令结果卡（`command/run` → `command/done` 驱动；不进消息流，可关闭） */
  const [commandResult, setCommandResult] = useState<{
    line: string
    running: boolean
    projection: KernelGoalProjection | null
    plan: KernelPlanProjection | null
    /** 命令给的可读结果（plan on/off、export 等；goal 六行已在 projection 里） */
    resultText?: string
    error?: string
  } | null>(null)
  /**
   * PB-018：本会话是否走内核命令平面（flag 开）。false = 0.1.6 旧路径（菜单静态三行；
   * `/goal` 仍交给网关，由 main 的 flag 关降级实现处理）。
   */
  const [kernelMode, setKernelMode] = useState(false)
  /** 内核 `commands/list` 的目录（kernelMode 下菜单的唯一来源） */
  const [kernelCommands, setKernelCommands] = useState<KernelCommandSummary[] | null>(null)
  /** 内核 plan 投影（只读；两种形态都算"在规划里"，见 kernelPlanActive） */
  const [kernelPlan, setKernelPlan] = useState<KernelPlanProjection | null>(null)
  /**
   * PB-039：本会话是否挂着 goal（`GoalDockContainer` 上报）。
   * 用途：dock 顺序「审批/提问 > goal > 海獭」+ **有 goal 时隐藏输入卡右上角的海獭**（避免两条状态抢视线）。
   */
  const [hasGoal, setHasGoal] = useState(false)
  /** 让 goal 条重取的计数器：/goal 命令改过 goal 后 +1（挂载/换会话之外的唯一刷新入口） */
  const [goalRefresh, setGoalRefresh] = useState(0)

  const {
    messages,
    setMessages,
    sendMessage,
    regenerate,
    stop,
    status,
    error,
    addToolApprovalResponse
  } = useChat({
    chat
  })
  const observedTodoResults = useRef(new Map<string, unknown>())
  useEffect(() => {
    if (!ready) return
    let changed = false
    for (const message of messages) {
      for (const part of message.parts) {
        if (
          (part.type !== 'tool-todo' &&
            !(part.type === 'dynamic-tool' && part.toolName === 'todo')) ||
          part.state !== 'output-available'
        )
          continue
        const key = JSON.stringify([message.id, part.toolCallId])
        if (observedTodoResults.current.get(key) === part.output) continue
        observedTodoResults.current.set(key, part.output)
        changed = true
      }
    }
    if (changed) void tasksStore.getState().load(threadId)
  }, [messages, ready, threadId])
  const busy = status === 'submitted' || status === 'streaming'
  /**
   * PB-033 接线：把**流内** provider usage（`data-usage` part）直推给输入框底部读数。
   * 只跟"最近一条助手消息"的 parts 走（parts 身份变了才重算），
   * 没拿到 reported 也没有 contextInput 时不推 —— 否则会把上一轮的数字清空。
   */
  const lastAssistantParts = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message !== undefined && message.role === 'assistant') return message.parts
    }
    return []
  }, [messages])
  const { latest: latestUsage } = useUsageStream(lastAssistantParts)
  useEffect(() => {
    if (!latestUsage.reported && latestUsage.contextInput === null) return
    pushUsage(latestUsage)
  }, [latestUsage])
  const workspaces = useSettingsStore((state) => state.settings.workspaces)
  /** 还停在等审批（挂起轮）：发送/编辑都要按"忙"处理，见下面各处 */
  const waitingApproval = pendingApprovals(messages[messages.length - 1]).length > 0
  /**
   * PB-037：失败轮的「消息内错误卡 vs 页脚 dock 错误卡」单一判定。
   * 有 turnFailure 的消息卡优先；dock 只在该轮没有消息卡时出现（见 turn-failure.ts）。
   */
  const failurePresentation = failurePresentationOf(messages, error ?? null)
  const askState = useAskUserStore((state) => state.threads.get(threadId) ?? EMPTY_ASK_USER_THREAD)
  const askDrafts = useAskUserStore((state) => state.drafts)
  const realThread = useSessionsStore((state) =>
    state.threads.some((thread) => thread.id === threadId)
  )
  /**
   * PB-026：内核交互快照/应答。只在 **kernelMode + 真会话** 时开——占位/未物化的本地 thread
   * 不能拿去打交互路由（否则 main 会 session/create，侧栏冒幽灵会话，PB-030）。
   */
  const kernelInteractions = useKernelInteractions({
    threadId,
    enabled: kernelMode && hasRealThread,
    active: busy
  })
  const kernelInteractionPending =
    kernelMode &&
    realThread &&
    (kernelInteractions.snapshot?.approvals.pending.length ?? 0) +
      (kernelInteractions.snapshot?.questions.pending.length ?? 0) >
      0
  const enterPlanLock = useRef(false)
  /**
   * PB-027：用宿主旧线程库替换当前消息列 —— **只允许在确有数据时替换**。
   *
   * 为什么要有这道闸：内核路径（PB-024 之后 threads 已切内核实现）的轮次**不写宿主旧线程库**，
   * `fetchThreadMessages` 返回空是"旧库没有这条会话的数据"，不是"会话是空的"。拿空数组
   * `setMessages([])` 会把用户消息 + 已交付文本整列抹掉（停止后回到欢迎空态，P1 数据丢失）。
   * 所以：① 内核模式直接不读旧库（旧库不是真源）；② flag 关读到了空快照也不覆盖。
   * 返回值 = 是否真的替换（调用方目前不需要，但便于测试/诊断）。
   */
  const replaceHistoryFromServer = useCallback(async (): Promise<boolean> => {
    if (kernelMode) return false
    const history = mapStoredMessages(await fetchThreadMessages(threadId))
    if (history.length === 0) return false
    setMessages(history)
    return true
  }, [kernelMode, threadId, setMessages])
  const refreshQuestions = useCallback(() => {
    // PB-030 配合：未物化的本地 thread / 占位 id 不能打 /ask-user/pending（main 会 session/create）
    if (!hasRealThread) return
    void useAskUserStore
      .getState()
      .refresh(threadId)
      .then(async (ok) => {
        if (!ok || chatStreamActive(chat)) return
        if (useAskUserStore.getState().threads.get(threadId)?.pending.length) return
        if (!hasPendingAskUser(chat.messages[chat.messages.length - 1])) return
        try {
          const replaced = await replaceHistoryFromServer()
          if (!replaced || chatStreamActive(chat)) return
        } catch {
          useAskUserStore.setState((state) => ({
            threads: new Map(state.threads).set(threadId, {
              ...(state.threads.get(threadId) ?? EMPTY_ASK_USER_THREAD),
              error: '历史刷新失败，请重试刷新待答问题'
            })
          }))
        }
      })
  }, [threadId, chat, replaceHistoryFromServer, hasRealThread])
  useEffect(() => {
    if (!ready || !interactionsEnabled || !hasRealThread) return
    refreshQuestions()
    const onFocus = (): void => refreshQuestions()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [ready, refreshQuestions, interactionsEnabled, hasRealThread])
  const waitingInteraction =
    waitingApproval ||
    kernelInteractionPending ||
    ((!interactionsEnabled || !askState.loaded || askState.error !== null) &&
      hasPendingAskUser(messages[messages.length - 1])) ||
    (interactionsEnabled &&
      (!askState.loaded ||
        askState.refreshing ||
        askState.submitting ||
        askState.stopping ||
        askState.error !== null ||
        askState.pending.length > 0))
  const stopInteraction = useCallback(() => {
    if (!interactionsEnabled || !hasRealThread) {
      void stop()
      return
    }
    // PB-027：内核路径停止 = 只 abort 本轮。消息列由 useChat 自己保留（abort 不丢已交付文本）；
    // **绝不**走旧 ask-user cancel → 旧线程库 history 覆盖（内核轮次不写旧库 → 空数组清列）。
    // 内核侧挂起的 ask_user/审批由内核 session/cancel 结算（PB-025 接 UI 应答后在此补取消语义）。
    if (kernelMode) {
      void stop()
      return
    }
    void useAskUserStore.getState().cancel(
      threadId,
      async () => {
        await stop()
      },
      async () => {
        try {
          await replaceHistoryFromServer()
        } catch {
          throw new Error('停止已确认，但历史刷新失败，请刷新待答问题')
        }
      }
    )
  }, [threadId, stop, replaceHistoryFromServer, interactionsEnabled, kernelMode, hasRealThread])
  /**
   * PB-018：探活 + 取内核命令目录。失败/flag 关一律回旧路径（`kernelEnabled` 内部吞错），
   * 不因为网关不可用把对话页推到错误态。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      const enabled = await kernelEnabled()
      if (!alive) return
      setKernelMode(enabled)
      if (!enabled) return
      const commands = await fetchKernelCatalog().catch(() => [] as KernelCommandSummary[])
      if (alive) setKernelCommands(commands)
    })()
    return () => {
      alive = false
    }
  }, [])
  /**
   * PB-018：执行一条内核命令并驱动结果卡（`command/run` → `command/done`）。
   * 命令**不经过 chat transport**：不发消息、不进历史；done 里带最新的 goal 六行/plan 投影。
   */
  const runCommandLine = useCallback(
    async (line: string): Promise<void> => {
      if (!ready) return
      setCommandResult({ line, running: true, projection: null, plan: null })
      try {
        await runKernelCommand(threadId, line, (frame) => {
          if (frame.type === 'command/run') {
            setCommandResult({ line: frame.line, running: true, projection: null, plan: null })
            return
          }
          const resultText =
            frame.result.kind === 'success' &&
            frame.result.text !== undefined &&
            frame.result.text.trim() !== ''
              ? frame.result.text
              : undefined
          setCommandResult({
            line: frame.line,
            running: false,
            projection: frame.goal,
            plan: frame.plan,
            ...(resultText === undefined ? {} : { resultText }),
            ...(frame.result.kind === 'error' ? { error: frame.result.text } : {})
          })
          if (frame.plan !== null) setKernelPlan(frame.plan)
          // 命令可能改了 goal → 让 dock 条重取一次（与旧 `/goal` 命令同一口径）
          setGoalRefresh((count) => count + 1)
        })
      } catch (cause) {
        setCommandResult({
          line,
          running: false,
          projection: null,
          plan: null,
          error: toError(cause).message
        })
      }
    },
    [ready, threadId]
  )
  /**
   * round 62：动作闸门只算一次。三档"状态忙"：流式中 / 挂起等审批 / 压缩中 —— 原来这一串在
   * 六处各写了一遍，加一条规则就得满文件找。**动作行的显隐看它**（渲染期的 state 就是它的全部）。
   */
  const locked = busy || waitingInteraction || compacting
  /**
   * round 62：**执行时**的最后一道闸 = `locked` + `sending.current`。
   *
   * 为什么 ref 也要算：`dispatch` 置 `sending.current = true` 之后，要 await 物化、await 取用量、
   * 可能还整轮压缩，才真正 `sendMessage` —— 这段窗口里 `busy` 还是 false（消息动作行照旧画着、
   * `/压缩上下文` 照旧可点）。此时若放行撤回/编辑/压缩，就会与在途的 `sendMessage` 并发写服务端
   * 历史。render 期读 ref 不触发更新，所以**显隐仍旧由 `locked` 决定**（观感不变），ref 只在事件
   * 回调里现读 —— 拦的是"已经点下去的那一下"。
   */
  const isLocked = useCallback((): boolean => locked || sending.current, [locked])
  /**
   * round 81：「进入规划模式」的**唯一实现**（入口收在左下角 ＋ 菜单里，见 Composer 的 mode props）。
   *
   * 草稿会话（还没物化）与已有会话走同一个动作：先物化（草稿在服务端还不存在，规划状态没处读写），
   * 再读最新计划状态、按服务端 CAS 版本进入 —— 与旧的工具条按钮逐字同一套顺序，只是入口换了地方。
   * 闸门用 `isLocked()`（现读 ref）：正在跑 / 等审批 / 压缩中都不放行；失败不静默，落到
   * 命令结果卡（PB-041：旧 plans 状态机入口已下架，只走内核命令平面）。
   */
  const enterPlan = useCallback((): void => {
    if (!kernelMode || isLocked() || enterPlanLock.current) return
    enterPlanLock.current = true
    void runCommandLine('/plan').finally(() => {
      enterPlanLock.current = false
    })
  }, [isLocked, kernelMode, runCommandLine])
  /** 会话任务清单的收起状态（round 81：唯一来源是 tasks-store 的 collapsed；＋菜单那条也翻它） */
  const taskCollapsed = useStore(tasksStore, (state) => taskSession(state, threadId).collapsed)
  const toggleTasks = useCallback((): void => {
    const state = tasksStore.getState()
    state.setCollapsed(threadId, !taskSession(state, threadId).collapsed)
  }, [threadId])
  /**
   * round 86（用户实报 016 问题二的后半）：**进入规划模式的那一刻**把任务清单自动展开一次
   * （上一轮只做到"规划里这一格不消失 + 一键展开"）。
   *
   * 只在"**读到过**非规划 → 规划"这一条上升沿动手：`active` 用三态 —— `null` = 内核投影还没读到，
   * `false` = 读到过且不在规划。
   *   - 主动进规划（`enterPlan`，普通模式 → 规划中）：`false → true`，展开；
   *   - 首次读到 / 切到（切回）一条**本来就在规划里**的会话、以及切会话本身：`null → true`
   *     或换了 threadId，都**不动** —— 那份 `collapsed` 是用户自己的（tasks-store 里持久留着），
   *     不该因为"页面刚打开"就被抹成展开；
   *   - 之后用户手动收起：模式没变，没有上升沿，不再被任何 plan 回包顶开（每次渲染都强开的话，
   *     收起状态就形同虚设）。
   *
   * 收起状态仍然只有一个来源：tasks-store 的 `collapsed`（这里只调 `setCollapsed`，
   * 不另存平行状态）。
   */
  /**
   * PB-041：规划中的**唯一判据**只剩内核投影（旧 plans 状态机入口已下架）。
   * `null` = 还没读到；flag 关 = false（没有可用的规划通道）。
   */
  const planIsActive: boolean | null = kernelMode
    ? kernelPlan === null
      ? null
      : kernelPlanActive(kernelPlan)
    : false
  const planExpandBaseline = useRef<{ threadId: string; active: boolean | null } | null>(null)
  useEffect(() => {
    const active = planIsActive
    const previous = planExpandBaseline.current
    planExpandBaseline.current = { threadId, active }
    if (previous === null || previous.threadId !== threadId) return
    if (active === true && previous.active === false) {
      tasksStore.getState().setCollapsed(threadId, false)
    }
  }, [planIsActive, threadId])
  /**
   * ＋ 菜单里的**模式分组**（round 81）：原先工具条上那两颗常驻按钮（「进入规划模式」「任务清单」）
   * 都收进这一个 ＋（用户口径：绝不另造第二个模式菜单）。两边都是真状态、真回调：
   *   - 规划：只在普通模式时给这条（已在规划里就没有"再进入"这件事）；运行 / 等审批 / 压缩中禁用；
   *   - 任务清单：读 tasks-store 的 collapsed（不是平行状态），点一下翻它，文案跟着走。
   * 实例没就绪（`ready` 假）或通道缺失时整组不给 —— 那时没有可动的对象，也不该摆一个点不动的门。
   */
  const modeMenu = useMemo<ComposerModeMenu | null>(() => {
    if (!ready || !interactionsEnabled) return null
    // PB-041：规划只走内核投影；旧 plans 入口已下架（不再有 flag 关的替代通道）。
    const canEnterPlan = kernelMode && planIsActive !== true
    return {
      plan: canEnterPlan ? { disabled: locked, onSelect: () => enterPlan() } : null,
      tasks: { expanded: !taskCollapsed, onSelect: toggleTasks }
    }
  }, [
    ready,
    interactionsEnabled,
    kernelMode,
    planIsActive,
    locked,
    enterPlan,
    taskCollapsed,
    toggleTasks
  ])
  /**
   * 输入框上方审批条的数据（round 29）：当前挂起的审批，刨掉"本会话允许"命中的那些 ——
   * 命中的会由下面的 effect 立刻回灌放行，先把它们画出来只会闪一下。
   * 同一步多个挂起 → 按 part 顺序堆叠，逐个处理。
   */
  const dockApprovals = useMemo(
    () =>
      pendingApprovals(messages[messages.length - 1]).filter((request) => {
        const workspace = resolveApprovalWorkspace(request.input, workspaces, request.toolName)
        // round 71：红线命令不算"本会话允许"命中的（否则会被藏起来 + 自动放行）
        return !isAllowedForSessionNow(threadId, request, workspace, workspaces)
      }),
    [messages, workspaces, threadId]
  )
  /** "永久允许"没写进设置（只在本次对话生效）：露一行给用户，不静默当成永久生效 */
  const [permissionError, setPermissionError] = useState<string | null>(null)

  /** 消息条数的实时值：压缩回调里要取"那一刻"的条数（useCallback 闭包里的是旧值） */
  useEffect(() => {
    messageCountRef.current = messages.length
  }, [messages.length])

  /** 压缩记录随会话挂载读一次（分界线的数据面；取不到就停在无分界线态，不打扰对话）。
   *  round 76：**就绪了才读** —— 未就绪时 threadId 还是占位 id，拿它去问服务端只会白跑一趟 404。 */
  useEffect(() => {
    if (!ready) return
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
  }, [ready, threadId])

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
      /**
       * 0.1.3 / 006+008：随消息挂一份**展示 metadata**（发送时刻 + 附件追加段的展示上下文）。
       * 它**不改正文、不改 file part** —— 模型读到的文本与这条消息永远与 composeOutgoing 的产物逐字相同；
       * 服务端会把它存进存储消息的 content.metadata（回读见 lib/message-map），气泡据此藏追加段、画图标项。
       * 挂在哪一刻：这里（真正 sendMessage 之前），所以它记的是**发送时刻**而不是进队/点击时刻。
       *
       * 时间**不走**消息顶层的 `createdAt`（AI SDK 的简写形态也没有这一格）：实测那一路落库的是
       * 服务端落库时刻（差 8–180ms，见 message-context-wire.spec.ts），而 `metadata.createdAt`
       * 会原样留在存储的 content.metadata 里 —— 于是回读拿到的是**逐毫秒**的发送时刻。
       */
      const metadata = await buildUserMessageMetadata({
        at: Date.now(),
        text: message.text,
        context: message.context ?? null
      })
      // 图片走 file part（module 2）：没有图片时连字段都不带，保持"纯文本消息"的老形状
      void sendMessage(
        {
          text: message.text,
          metadata,
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
   * round 62：审批回灌的**唯一出口** —— 手动决策与"会话记忆自动放行"共用一条，形状不可能再分叉。
   *
   * `options` 是给"决策触发的自动续跑请求"用的（AI SDK 的类型注释点名了这个用途）：
   * 续跑请求与普通发送走同一条路，线程上下文（memory.thread/resource）得同样带上，否则续跑那一轮
   * 服务端拿不到会话（round 51 修的是手动这条路，自动那条漏了同一处）。
   */
  const respondToApproval = useCallback(
    (request: ApprovalRequest, response: { approved: boolean; reason?: string }): void => {
      void addToolApprovalResponse({
        id: request.approvalId,
        approved: response.approved,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
        options: threadRequestOptions(threadId)
      })
    },
    [addToolApprovalResponse, threadId]
  )

  /**
   * 审批决策（T13）：
   *   - 本会话允许 → 记进模块级内存（同对话 + 同工具 + 同工作区），这个对话里之后不再打扰；
   *   - 永久允许 → **先登记本会话记忆**（同轮内紧随的第二次写不再弹卡），再落一条规则进
   *     settings.permissions.rules（服务端下一轮就不再问）；落盘失败要露出来（见 permissionError）；
   *   - 决策本身经 addToolApprovalResponse 回灌（走 respondToApproval）；`sendAutomaticallyWhen`
   *     （thread-chats 里挂的 `canResumeAfterApproval`，approval.ts）会在所有审批都有回应后自动把
   *     消息发回服务端执行。
   * 两个记忆入口都要求工作区明确（规则是 (工具 × 工作区) 粒度的，判不出工作区就没有规则可写）。
   * round 76（用户口径"允许就是永久允许"）：delete / move 与其它写类**同一套**——这里不再按工具
   * 身份分叉（服务端的 gate 一直吃 (工具 × 工作区) 规则，卡上不给入口才是两边的口径打架）。审批
   * 档位与判定链一个字没动：区内 full 免审、区内 ask 按规则/逐次问、区外按「工作区之外」那一档。
   */
  const decideApproval = useCallback(
    (request: ApprovalRequest, decision: ApprovalDecision) => {
      const workspace = resolveApprovalWorkspace(request.input, workspaces, request.toolName)
      if (workspace !== null) {
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
      respondToApproval(
        request,
        decision === 'deny' ? { approved: false, reason: '用户拒绝了这次操作' } : { approved: true }
      )
    },
    [respondToApproval, workspaces, threadId]
  )

  /**
   * 会话记忆命中的待批调用直接放行（"本会话允许"之后不再弹卡）。
   * round 62：与手动决策共用 respondToApproval —— 自动续跑那次请求同样带线程上下文。
   * round 71：红线命令不在此列（`isAllowedForSessionNow` 再挡一道，服务端的红线是 bypass-immune）。
   */
  useEffect(() => {
    for (const request of pendingApprovals(messages[messages.length - 1])) {
      const workspace = resolveApprovalWorkspace(request.input, workspaces, request.toolName)
      if (isAllowedForSessionNow(threadId, request, workspace, workspaces)) {
        respondToApproval(request, { approved: true })
      }
    }
  }, [messages, respondToApproval, workspaces, threadId])

  /**
   * round 33：新一轮开跑就清掉上一轮的"被截停/被截断"提示 —— 发送、审批续跑、重试、编辑重发
   * 都会把 status 推到 submitted/streaming，统一在这里收口（提示不会赖在界面上）。
   */
  useEffect(() => {
    if (status === 'submitted' || status === 'streaming') onClearTurnNotice()
  }, [status, onClearTurnNotice])

  const flushNext = useCallback(() => {
    // round 76：实例没就绪就不动队列（补发也会真的发出去 —— 那时占位 Chat 会当场抛）
    if (!ready) return
    // round 62：队列在 store 里（切会话不丢）；取走即出队，不会重复补发同一条
    const next = useSessionsStore.getState().takeQueuedMessage(threadId)
    if (next === null) return
    // 走统一发送入口：补发同样过"超阈值先压缩"的预检（用户排队时可能已越过阈值）
    dispatch(next)
  }, [dispatch, ready, threadId])

  /**
   * 一轮结束（从 busy 回到 ready）→ 补发排队的下一条。
   * 用 status 转移而不是 useChat 的 onFinish：Chat 实例是外部管理的（注册表持有），
   * onFinish 在构造时就绑给了完成通知那条路；这里只关心"忙完了、队列还排着没有"。
   * 出错收尾状态是 'error'（不是 ready），不自动补发——等用户决定重试还是改主意。
   * 还停在等审批（挂起轮）也不补发：用户还没做决策，替他往前跑只会把审批流搅乱。
   * round 57：同一处顺手把用量取数信号 +1（新一轮用量已落库 → 环与「压缩上下文」胶囊刷新）。
   * round 62：**首次挂载**（previousStatus 还是 null）也看一次队列 —— 组件是按会话 id 重挂的，
   * "切走再切回"时看不到"忙 → 空闲"那一下（那一轮的流是在别处收的尾），而队列还躺在 store 里：
   * 有排队就补发，不让它一直排着（这一档不动用量信号：没发生新的轮末）。
   * round 76：**没就绪就整段跳过**（`ready` 在依赖里）—— 那一段的 `status` 来自占位 Chat
   * （恒为 'ready'），要是照旧记账，就会把"还没开始的这一屏"当成一轮轮末。
   *
   * round 62 的另一条口径（`set-state-in-effect` 的豁免，下一行显式写下来）：`flushNext()` 会一路
   * 走到 `sendMessage`，同步那一段里有几处 setState（清压缩提示 / 置压缩中位）——于是 react-hooks
   * 的 set-state-in-effect 判它"effect 里同步 setState"。这里是**有意为之**：触发点是"一轮结束 /
   * 切回会话时队列还排着"这类**外部事件**（一次轮末最多跑一次），不是渲染派生的状态，也不会每次
   * 渲染级联。修前那条队列在组件内的 ref 里，规则按"ref 驱动的更新"放过；队列搬进 store 之后
   * 这层豁免不再成立，所以把理由写在这里。更彻底的走法是把补发挪进 thread-chats 的 onTurnEnd
   * 回调（外部系统的事件回调，规则认可的形状）——但那会绕开这里的发送预检与发送锁，本轮不动。
   */
  const previousStatus = useRef<string | null>(null)
  const approvalBlockedByAsk = useRef(false)
  useEffect(() => {
    if (!ready) return
    // 挂载时 previousStatus.current 还是 null：等价于"刚才很忙"（重挂时看不到轮末那一下）
    const firstRun = previousStatus.current === null
    const wasBusy =
      firstRun || previousStatus.current === 'submitted' || previousStatus.current === 'streaming'
    if (status === 'ready' && waitingInteraction) {
      if (
        canResumeAfterApproval(messages) &&
        (askState.pending.length > 0 || askState.submitting)
      ) {
        approvalBlockedByAsk.current = true
      }
      return
    }
    if (status === 'ready' && approvalBlockedByAsk.current && canResumeAfterApproval(messages)) {
      approvalBlockedByAsk.current = false
      void sendMessage(undefined, threadRequestOptions(threadId))
      return
    }
    if (status === 'ready' && canResumeAfterApproval(messages)) return
    previousStatus.current = status
    if (!wasBusy || status !== 'ready') return
    if (!firstRun) setUsageVersion((version) => version + 1)
    flushNext()
  }, [
    ready,
    status,
    flushNext,
    waitingInteraction,
    messages,
    sendMessage,
    threadId,
    askState.pending.length,
    askState.submitting
  ])

  /**
   * 发送：等审批期间与"流式中"同一口径 —— **不发**，进队列。
   * 为什么不是直发：审批挂起时直发会让 `sendAutomaticallyWhen` 的判定失效（它只看最后一条
   * 助手消息），决策回灌后再也不会自动续跑，卡片永远停在"审批已回应"；排队则等这一轮
   * （决策 → resume → 收尾）真正结束再发，语义与"流式中发送"完全一致。
   * round 62：排队内容落在会话 store 上（切会话不丢）；闸门用 `isLocked()`（现读 ref，
   * 预检在途的那段窗口也算忙）。
   * round 76：**实例没就绪直接丢**（输入卡那边已经挡住了：按钮禁用、回车不发、挂着「正在载入
   * 会话…」）。这里再守一道是为了防任何旁路 —— 未就绪时发出去只会打到占位 Chat 上当场抛。
   * 也**不排队**：排队意味着"稍后一定发"，而那时连会话是谁都还不知道（占位 id 上排队等于丢）。
   */
  const submit = useCallback(
    (message: OutgoingMessage) => {
      if (!ready) return
      const text = message.text.trimStart()
      const goalLine = /^\/goal(?:\s|$)/u.test(text)
      // PB-018：内核模式所有 slash 命令走命令平面（不进历史）；flag 关只拦 `/goal`
      // （由 main 的旧 store 降级实现处理 —— renderer 已无手写解析器）。
      if (text.startsWith('/') && (kernelMode || goalLine)) {
        if (message.files.length > 0) {
          setCommandResult({
            line: text,
            running: false,
            projection: null,
            plan: null,
            error: goalLine
              ? '/goal 附件提交（followup）尚未接入：请先移除附件再执行命令。'
              : '命令暂不支持附件提交：请先移除附件再执行命令。'
          })
          return
        }
        void runCommandLine(text)
        return
      }
      if (isLocked()) {
        useSessionsStore.getState().enqueueMessage(threadId, message)
        return
      }
      dispatch(message)
    },
    [dispatch, isLocked, kernelMode, ready, threadId, runCommandLine]
  )

  /**
   * 0.1.3 / 013 返工：选中助手正文 →「引用」→ **草稿附件**（不自动发送）。
   *
   * 与旧实现（把 Markdown 引用块 append 进输入框）的区别：长选区不再占输入框，Composer
   * 的附件条上出现一张可展开 / 可编辑的摘要卡；**原文完整保留**，发送时模型拿到的仍是全文
   * （不是卡上的摘要）。草稿通道只写 Composer 的本地状态（`publishDraft` 的 quote 分支），
   * 发送仍只由用户按发送钮 / Enter 触发。来源消息 id 一并带上，气泡下方图标项可追溯。
   * 空白选区不发布。
   */
  const quoteSelection = useCallback(
    (text: string, source: { messageId: string }): void => {
      if (text.trim() === '') return
      publishDraft({ threadId, quote: { text, messageId: source.messageId } })
    },
    [threadId]
  )

  /** 编辑重发（R2）：服务端截断 → 客户端截断重发；截断失败不重发（否则历史两边不一致）。
   *  T13 N1：与编辑入口同一道闸门——流式中/等审批期间不动作（截断会把挂起消息删掉，而服务端
   *  run 快照还在，决策会对着空气回灌；流式中则是对当前这条流并发。闸门只在旧重试卡这条
   *  窄路径上会被擦边：编辑入口本身在挂起期间是关的）。
   *  round 62：闸门 = `isLocked()`（多一道"发送预检在途"——那段窗口 busy 还是 false）。
   *  0.1.3 / 006：重发时**沿用原来的展示上下文**（用户只改了自己的字、附件段原样没动 → 按摘要
   *  认领得上，图标项与隐藏照旧）；认领不上（改到了附件段 / 原本就没有上下文）就只带发送时刻 ——
   *  展示回退成原文，绝不把用户改过的内容当附件藏掉。 */
  const editResend = useCallback(
    (messageId: string, text: string) => {
      if (isLocked()) return
      setPendingSync(null)
      const original = messages.find((message) => message.id === messageId)
      truncateThread(threadId, messageId).then(
        () => {
          void (async (): Promise<void> => {
            let context: MessageContext | null = null
            try {
              context = await carryOverMessageContext(original?.metadata, text)
            } catch (cause) {
              console.warn('[kyclaw] 编辑重发的展示上下文没能沿用（按原文展示）', cause)
            }
            const metadata = await buildUserMessageMetadata({ at: Date.now(), text, context })
            void sendMessage({ text, messageId, metadata }, threadRequestOptions(threadId))
          })()
        },
        () => {
          setPendingSync({ kind: 'edit', messageId, text })
        }
      )
    },
    [isLocked, messages, sendMessage, threadId]
  )

  /** 重试 = 整轮重生成：先删掉上一条助手回复，再 regenerate（防止新旧回复在存储里合并）。
   *  T13 N1：同 editResend——等审批/流式中不重试（错误卡的旧重试按钮不能绕开闸门）。
   *  round 61：`messageId` 给定时就是「重新生成**这一条**」（消息动作行；客户端历史会被
   *  regenerate 截到它之前，与服务端 truncate 同一刀）；缺省（null）= 列表最后一条 ——
   *  错误卡那条路（出错时最后一条就是那条失败的助手回复）的既有行为不变。 */
  const regenerateReply = useCallback(
    (messageId: string | null) => {
      // round 62：闸门统一成 isLocked()（含"发送预检在途"）
      if (isLocked()) return
      const target =
        messageId === null
          ? messages[messages.length - 1]
          : messages.find((message) => message.id === messageId)
      if (target === undefined) return
      setPendingSync(null)
      const explicit = messageId === null ? {} : { messageId: target.id }
      const truncateFirst =
        target.role === 'assistant' ? truncateThread(threadId, target.id) : Promise.resolve(0)
      truncateFirst.then(
        () => {
          void regenerate({ ...threadRequestOptions(threadId), ...explicit })
        },
        () => {
          setPendingSync({ kind: 'retry', messageId: target.id })
        }
      )
    },
    [isLocked, messages, regenerate, threadId]
  )

  const retry = useCallback(() => regenerateReply(null), [regenerateReply])

  /**
   * PB-035 B′（用户：「重试直接就是整轮重试 之前的东西都没了」）：
   * **保留已有内容再试** —— 不清空、不 truncate、不 regenerate，改为**新起一轮**：
   * 发一条带 `kyclawRetryKeep` 标记的 user 消息（UI 上隐藏，见 MessageList），
   * 新回复作为**新消息追加**在旧内容之后。
   * 安全口径：① 不带 `metadata.goalRound`（否则 goal 准入会拿已消费的 revision 再准入 → 409）；
   * ② 与既有重试走同一道 `isLocked()` 闸门（等审批/流式中不动作）。
   */
  const retryKeep = useCallback(() => {
    if (isLocked()) return
    setPendingSync(null)
    void sendMessage(
      { text: RETRY_KEEP_PROMPT, metadata: { [RETRY_KEEP_METADATA_KEY]: true } },
      threadRequestOptions(threadId)
    )
  }, [isLocked, sendMessage, threadId])

  /**
   * 失败轮（最后一条助手消息）里用户看得见的记录条数：非空正文 + 工具调用各算一条。
   * 0 → 错误卡只给一个按钮（没东西可丢，不给无意义的分叉）。
   */
  const lastMessage = messages.length === 0 ? undefined : messages[messages.length - 1]
  const retryPreservedRecords =
    lastMessage !== undefined && lastMessage.role === 'assistant'
      ? preservedRecordsOf(lastMessage)
      : 0

  /**
   * 撤回一条用户消息（round 61，消息动作行的「撤回」，Kimi 口径的 kyclaw 版）：
   * 这条消息**及之后的对话**从上下文与列表里移除，这条消息的原文放回输入框；
   * 工作区里已改动的文件不在这里、也不受影响（那是工具干的事）。
   *
   * 顺序与 editResend 同一条：**先服务端 truncate**（存储是权威），删成功了才动客户端 ——
   * 反过来的话服务端记忆里还留着这条，下一轮又会把它带回来。
   * 客户端移除走 useChat 的 setMessages（外部管理的 Chat 实例上直接改消息数组），**不重挂**：
   * 重挂（dropThreadChat + reloadToken）要把整段历史重新拉一遍，而撤回只是砍掉尾巴。
   * 截断失败不静默：走既有的 pendingSync（错误卡 + 「重试」把这一步重做一遍，原文也还在手里）。
   */
  const undoMessage = useCallback(
    (messageId: string, text: string) => {
      // round 62：闸门统一成 isLocked()（含"发送预检在途"）
      if (isLocked()) return
      setPendingSync(null)
      truncateThread(threadId, messageId).then(
        () => {
          setMessages((current) => {
            const index = current.findIndex((message) => message.id === messageId)
            return index === -1 ? current : current.slice(0, index)
          })
          // 原文放回输入框（草稿是 Composer 的内部 state，跨组件只这条通道，见 composer-inbox）
          publishDraft({ threadId, text })
        },
        () => {
          setPendingSync({ kind: 'undo', messageId, text })
        }
      )
    },
    [isLocked, setMessages, threadId]
  )

  /** 截断失败的重试：把刚才没做完的动作原样再做一遍 */
  const retryPendingSync = useCallback(() => {
    if (!pendingSync) return
    if (pendingSync.kind === 'edit') {
      editResend(pendingSync.messageId, pendingSync.text ?? '')
      return
    }
    if (pendingSync.kind === 'undo') {
      undoMessage(pendingSync.messageId, pendingSync.text ?? '')
      return
    }
    regenerateReply(pendingSync.messageId)
  }, [editResend, pendingSync, regenerateReply, undoMessage])

  /**
   * 「/」→「压缩上下文」（round 19）：立即压缩；流式/等审批/压缩中命令行为禁用态。
   * round 59：**成功不在这里报**——压缩是对话流里的一件事（分界线自己会说），输入框区只留
   * 操作失败的反馈（失败 / 没有可压缩的旧消息）。
   */
  const compactManually = useCallback(() => {
    // round 62：闸门统一成 isLocked()（含"发送预检在途"——那段窗口动历史会与在途 send 并发）
    if (isLocked()) return
    setCompactNotice(null)
    void runCompact().then((outcome) => {
      if (!outcome.ok) {
        setCompactNotice({ tone: 'danger', text: `压缩失败：${outcome.error}` })
      } else if (!outcome.compacted) {
        setCompactNotice({ tone: 'warning', text: '当前没有可压缩的旧消息' })
      }
    })
  }, [isLocked, runCompact])

  const syncError = pendingSync === null ? null : syncErrorOf(pendingSync)

  /**
   * round 61：消息动作（编辑 / 撤回 / 重新生成）的**同一道闸** —— 三者都要在服务端动历史，
   * 与"正在跑的那一轮"（流式、挂起等审批）和"正在压上下文"互斥。关着就不给回调，
   * 消息上连动作行都不出现（口径见 Message 的头注）。
   * round 62：就是上面算好的 `locked` —— 显隐看 state（"发送预检在途"那一下仍画着动作行，
   * 真正点下去由回调里的 `isLocked()` 拦）。
   */
  const actionsLocked = locked

  /**
   * round 59：初始页（空会话）—— 消息为空、没有错误、没有待审批时，输入框居中 + 品牌标题。
   *
   * 两条口径（都写在这里，免得后面来回猜）：
   *   1. **初始页优先于完成态分界线**：消息为空就没有"对话流里的时间点"可放，有压缩记录也不画
   *      （记录本身没丢，首条消息到达后按定位规则出现在流里；现实里保留窗口 ≥ 2 条，
   *      "空会话 + 记录"只有测试造得出来）；
   *   2. **"正在压缩"是例外**：它是正在发生的事，首条消息发出前的自动预压也得让用户看得见
   *      （那一步可能挺久），所以压缩中不按初始页算 —— 输入框正常落位、分界线显示进行中。
   *
   * round 64：除布局外它还给两处定档（同一枚"这一屏是不是初始页"的事实，不另算一套）——
   * 输入区在初始页高一档（Composer 的 `hero`）。
   *
   * round 66：它同时是初始页「选择项目」行的**生死线**（用户口径"进入到对话之后就不要显示
   * 这个「选择项目」了"）—— 这一行只在初始页出现，进对话常挂 + 收合（round 76 起，见
   * CollapsibleRow）。2026-10-18 用户又拍板：输入卡**下方**那排能力胶囊（文档/表格/报告/研究
   * + PPT 模板）整行移除（"chat页面下面这一排按钮可以去掉了"）—— 卡片下方现在没有行，
   * 能力入口后续收进输入卡的 ＋ 菜单（PPT 模板选择器组件保留，下一轮接）。
   *
   * round 76：**加一个前提 `ready`** —— 会话实例就绪前不算初始页。两个理由：
   *   ① 那行里的「选择项目」是会话级控件（按 threadId 读写映射），实例没就绪时没有可动的对象
   *      （threadId 还是占位 id）；
   *   ② 就绪那一刻整页才"落位"成初始页 —— 页脚带 `animate-message-in`（淡入 + 上浮）、
   *      标题与那一行跟着它一起进场、占位撑开把输入框送到竖直中位。就绪之前是"还没开始"的
   *      常规底部布局（输入区常态档），不是硬切：档位与占位都带主档过渡。
   */
  const hero = ready && messages.length === 0 && !error && !waitingInteraction && !compacting

  /**
   * round 76：交给输入卡的挂起态（`null` = 就绪）。出错那一档**不带状态行** —— 错误卡就在消息区里
   * （"为什么发不出去"已经交代了），输入卡这一行再说一遍后端的事就是小字解释（雷点 2）；
   * 但**发送照样挡住**（按钮禁用 + 回车不发），只是不重复解释。
   */
  const composerPending =
    pending === null
      ? null
      : {
          label:
            pending.kind === 'connecting'
              ? '正在连接…'
              : pending.kind === 'loading'
                ? '正在载入会话…'
                : null
        }

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
      {/* A · 信笺（task-50；task-53 收口）：内容区极淡纸感 —— 点阵（中心亮、四周收）
          + 640×430 暖光，两层两个伪元素；铺满 chat 内容层、`pointer-events:none`、z-index:-1
          （靠上一层 `isolate` 垫底，永不压正文）。hero 时 data-active=true 淡入，进对话后只淡出
          （DOM 保留，两个伪元素没有成本）。一键关：welcome.css 的 `--welcome-texture/--welcome-glow` 置 none。
          task-53 已移除初始页角落的第二只海獭：一屏一只，初始页只有报头 lockup 那只、
          进对话后只有 ChatHeader 状态灯（hero 时 header 灯由 welcome.css 的 :has 规则隐起）。 */}
      <div
        data-testid="welcome-paper"
        data-active={hero ? 'true' : 'false'}
        aria-hidden="true"
        className="welcome-paper"
      />
      {/* 消息区：常规布局里占满剩余高度；初始页里消息为空，它只是上半格的弹性占位。
          **必须自带 flex 列身份**（round 59 用户实拍回归）：MessageList 的 frame 是
          `flex min-h-0 flex-1 flex-col`，包在块级父级里 flex-1 不生效、滚动区不受高度约束，
          消息内容会溢到页脚（输入框）下面。
          round 27：对话顶部栏已外提到 ChatFrame 的 header 带（脱离限宽列）——这里只剩内容列
          round 76：就绪之前这一格画占位/错误卡（PendingNotice），**页脚那一格照常挂着** ——
          输入卡因此从第一帧就在，载入过程中也能聚焦、能打字。
          task-50：A 的纸感层用 z-index:-1 + 上一层 `isolate`，本格保持原样 —— 消息永远压不住也压不到纸感。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {pending === null ? (
          <MessageList
            messages={messages}
            status={status}
            // 流式中不给编辑入口：避免编辑触发的请求和当前这条流并发；
            // 等审批期间同样不给——编辑重发会先截断掉那条挂起消息，服务端 run 快照还在（决策会对着空气回灌）；
            // round 19：压缩进行中也不给（两边都动同一批消息）
            onEdit={actionsLocked ? undefined : editResend}
            // round 61：撤回 / 重新生成与编辑同一道闸（都能在服务端动历史，与流式/挂起轮/压缩互斥）
            onUndo={actionsLocked ? undefined : undoMessage}
            onRegenerate={actionsLocked ? undefined : regenerateReply}
            /* 0.1.3 / 013：选中回复 → 引用草稿（写草稿，不发送；流式中也能用） */
            onQuoteSelection={quoteSelection}
            compaction={hero ? null : compaction}
            compacting={compacting}
            compactionIndex={compactionIndex}
            interactionResults={
              kernelMode && hasRealThread ? (
                <KernelInteractionResults
                  results={kernelInteractions.snapshot?.approvals.results ?? []}
                  settled={kernelInteractions.snapshot?.askUser.settled ?? []}
                />
              ) : undefined
            }
          />
        ) : (
          <PendingNotice pending={pending} />
        )}
      </div>

      {/* 初始页的页脚浮起（淡入 + 上浮，比标题晚 80ms 起步）；
          切常规布局时这几条类名被摘掉，元素本身**不重挂**——输入框全程可用（draft/焦点不丢）。
          round 59 修正：`relative` 是给初始页标题的挂点（标题绝对定位在输入框正上方，
          **不占布局高度**，见 WelcomeHero）——上下两格因此等分剩余高度、输入框真正竖直居中。 */}
      <div
        data-testid="chat-footer"
        className={cn('relative shrink-0', hero && 'animate-message-in [animation-delay:80ms]')}
      >
        <WelcomeHero active={hero} />
        {/* PB-018：命令结果卡（command/run → command/done；不进历史，只挂在输入框上方，可关闭） */}
        {commandResult === null ? null : (
          <div className="pt-2">
            <GoalCommandCard
              line={commandResult.line}
              projection={commandResult.projection}
              plan={commandResult.plan}
              running={commandResult.running}
              resultText={commandResult.resultText}
              error={commandResult.error}
              onClose={() => setCommandResult(null)}
            />
          </div>
        )}
        {failurePresentation.dockErrorVisible && error ? (
          // PB-037：有消息内 turnFailure 卡时，同一轮不再在页脚重复 dock 错误卡
          // PB-036：轮次失败卡与消息正文同栅格——先与消息列同宽居中，再进 18px 阅读缩进，
          // 卡片左缘 = 正文文本左缘（不再横跨整个页脚、不超出正文左基线）
          <div className="mx-auto w-full max-w-[calc(var(--chat-content-width)+32px)] px-4 pt-2">
            <div className="pl-[var(--chat-reading-indent)]">
              <ErrorCard
                error={toError(error)}
                onRetry={retry}
                onRetryKeep={retryKeep}
                preservedRecords={retryPreservedRecords}
              />
            </div>
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
        <div className="shrink-0 px-4 pt-4 pb-2">
          {/* 停靠区（输入卡正上方那一格）的夹高从这里给。round 82（用户口径）：
              **有提问时不再用固定的 45vh 夹它** —— 45vh 会在正常窗口里就把提问卡裁成"卡里滚一层"，
              当前题（含选项 / 其它输入框 + 主操作）因此要滚才点得到。现在有提问时这一格只受
              **视口高度**约束（`100dvh − 17rem`：给聊天头部、输入卡与页脚内边距留的量），
              当前题自然撑开；真的放不下（极小窗口 / 超长题）就由这一格自己滚 —— 这是"外层正常滚动"，
              不是 `overflow-hidden` 裁切，也没有隐藏滚动条糊过去。没有提问时维持原夹高：
              任务清单 / 计划 / 审批自己的布局一个字不动。 */}
          <div
            data-testid="chat-dock-area"
            className={cn(
              'min-w-0 overflow-y-auto overscroll-contain',
              askState.pending.length > 0 ? 'max-h-[calc(100dvh-17rem)]' : 'max-h-[min(45vh,28rem)]'
            )}
          >
            {/* round 81：工具条那一行常驻模式按钮没了 —— 「进入规划模式」「任务清单」都在输入卡的
                ＋ 菜单里（见 Composer 的 mode props / ComposerControls 的 PlusMenu）。这一格就只剩
                任务清单本体：有任务给紧凑摘要、点摘要展开；没有任务且收起时整块不渲染。
                PB-041：规划状态只读内核投影；旧计划审批 / plans 状态机入口已下架。 */}
            <TaskDockSlot
              key={threadId}
              threadId={ready ? threadId : null}
              materialized={realThread}
              planActive={planIsActive === true}
            />
            {ready && (realThread || kernelMode) && interactionsEnabled ? (
              <div className="mx-auto mb-2 w-full max-w-(--chat-input-max-width)">
                {/* 模式状态摘要（round 81）：只在真在规划里时露一行（普通模式不铺常驻件） */}
                <PlanModeChip kernelPlan={kernelPlan} />
              </div>
            ) : null}
            {/* PB-026：内核模式挂起在 dock；结果在消息流（MessageList 的 interactionResults）。
                flag 关 / 未物化会话保持旧 AskUserDock + ApprovalDock 一行不动。 */}
            {kernelMode && hasRealThread ? (
              <KernelInteractionDock
                snapshot={kernelInteractions.snapshot}
                error={kernelInteractions.error}
                notice={kernelInteractions.notice}
                submittingEventId={kernelInteractions.submittingEventId}
                onRespondApproval={(eventId, outcome) => {
                  void kernelInteractions.respondApproval(eventId, outcome)
                }}
                onRespondQuestion={(eventId, answers) => {
                  void kernelInteractions.respondQuestion(eventId, answers)
                }}
                onClearNotice={kernelInteractions.clearNotice}
              />
            ) : (
              <>
                {askState.error ? (
                  <ErrorCard error={new Error(askState.error)} onRetry={refreshQuestions} />
                ) : null}
                <AskUserDock
                  requests={askState.pending.map((request) => {
                    const key = askUserCallKey({ threadId, ...request })
                    return {
                      ...request,
                      threadId,
                      draft: askDrafts.get(key) ?? {},
                      submitting: busy || askState.submitting || askState.refreshing,
                      stopping: askState.stopping,
                      error: askState.error,
                      onDraftChange: (draft) => useAskUserStore.getState().changeDraft(key, draft),
                      /* 0.1.2 / 001：把"服务端已接收"回执随请求带上（transport 在响应到手时响它，
                         见 lib/agent 的 `AskUserAccepted`）—— 收卡挂在"请求被受理"上，不挂在"整轮跑完"上。
                         但**这一轮到底成没成**必须如实往上抛：AI SDK 把失败吞进 `chat.error`
                         （`sendMessage` 照样 resolve），不回抛 store 就分不清"响应没到手"与"跑完了"。 */
                      onSubmit: (answer) => {
                        if (busy) return
                        void useAskUserStore
                          .getState()
                          .submit(threadId, request, answer, (accepted) =>
                            sendMessage(undefined, {
                              body: { askUserResume: askUserResumeBody(threadId, request, answer) },
                              metadata: askUserAcceptedMetadata(accepted)
                            }).then(() => {
                              if (chat.error) throw chat.error
                            })
                          )
                      },
                      onStop: stopInteraction
                    }
                  })}
                />
                <ApprovalDock
                  requests={dockApprovals}
                  workspaces={workspaces}
                  onDecide={decideApproval}
                />
              </>
            )}
            {/* PB-039：goal 条排在「审批/提问」之后、「海獭」（在输入卡里）之前；
                PB-030 配合：未物化/占位会话不打内核投影（否则 main 会 session/create 冒幽灵会话） */}
            {realThread ? (
              <GoalDockContainer
                threadId={threadId}
                onHasGoalChange={setHasGoal}
                onPlanChange={setKernelPlan}
                refreshKey={goalRefresh}
              />
            ) : null}
          </div>
          {/* round 66：「选择项目」在输入卡**上方**单独一行（用户口径："放到对话框上面，
              不要嵌入到里面"）——与卡片同列宽、左缘对齐（行的 px-1，与卡片内容同一口径），
              不描边、不铺底，只 hover 铺一层浅灰（它是卡片外的独立控件，不是卡内嵌件）。
              **只在初始页（空会话）出现**（用户口径："进入到对话之后就不要显示这个「选择项目」了"）。
              round 76：退场不再是 `{hero ? … : null}` 的整块卸载（离场硬切、雷点 5）——
              改成常挂 + 收合（见 CollapsibleRow）：淡出 + 高度收到 0（含外边距），主档时长。
              2026-10-18：卡片下方那排能力/PPT 胶囊已按用户口径整行移除 —— 上方这一行是初始页
              现在唯一的卡外行（将来会收进卡片，见下面 welcome-spacer 注释里的恢复值）。 */}
          {/* task-118 预留的容器；task-127 起 hero 时里面挂真实日历热力图（占位容器/宽度公式不变，
              高度由热力图内容自然撑开：footer 长高 → 消息区让位、输入卡仍贴底）。
              非 hero（进对话）时容器保持 h-0 且清空。 */}
          <div
            aria-hidden={hero ? undefined : true}
            data-testid="welcome-heatmap-placeholder"
            className={cn('shrink-0', hero ? 'min-h-0 flex-1' : 'h-0')}
          >
            {hero ? <WelcomeHeatmap /> : null}
          </div>
          <CollapsibleRow
            active={hero}
            testId="composer-project-row"
            className="mx-auto mb-2 flex w-full max-w-(--chat-input-max-width) items-center px-1"
          >
            <ProjectChip threadId={threadId} />
            {/* A · 信笺：行尾一根 1px 引线（l1）拉满剩余宽度，把这一行做成「收件人行」；
                纯装饰，进对话随整行一起收合。 */}
            <span
              data-testid="welcome-project-rule"
              aria-hidden="true"
              className="welcome-project-rule"
            />
          </CollapsibleRow>
          {/* 就绪之前：`threadId` 给 null（会话级控件——权限 chip、@ 文件、上下文环——在那一刻
              没有可动的对象，与其拿占位 id 去问服务端要个 404，不如先不出现），发送被 `pending` 挡住。 */}
          <Composer
            threadId={ready ? threadId : null}
            busy={busy}
            queuedCount={queuedCount}
            // round 64：初始页（空会话）输入区高一档 —— 那一屏没有消息，输入框是主角（见 Composer 头注）
            hero={hero}
            // round 76：实例就绪之前发送一律挡住 + 工具条那一行露一句状态（见 Composer 的 `pending`）
            pending={composerPending}
            // round 81：模式分组（进入规划模式 / 任务清单）收在输入卡的 ＋ 菜单里
            mode={modeMenu}
            onSend={submit}
            onStop={stopInteraction}
            onCompact={compactManually}
            // PB-018：内核模式下 `/` 菜单只列内核 catalog 的命令，选中直接交命令平面执行
            kernelCommands={kernelMode ? (kernelCommands ?? []) : null}
            onKernelCommand={(line) => void runCommandLine(line)}
            compactBusy={compacting}
            // round 76：没就绪时「压缩上下文」也点不得（那一条同样要真会话 id）
            compactDisabled={locked || !ready}
            externalNotice={compactNotice}
            usageVersion={usageVersion}
            // PB-033：轮末（不忙）→ 读数切回落库值；流式中走流内直推的实时值
            settled={!busy}
            // PB-039：挂着 goal 时隐藏输入卡右上角的海獭（两个状态不抢视线）
            hideOtter={hasGoal}
            // R92：草稿过桥放行位（只有"系统初始化落位"那一次为 true，见 ChatPage 的判定）
            allowCarryover={carryoverAllowed}
          />
          {/* 2026-10-18（用户原话「chat页面下面这一排按钮可以去掉了」）：输入卡下方的能力行
              （文档 / 表格 / 报告 / 研究 + PPT 模板胶囊）整行移除；能力行组件与 spec 一并删除。
              能力入口后续收进输入卡的 ＋ 菜单，PPT 模板选择器（PptTemplatePicker）组件保留、
              下一轮接。所以卡片下方现在只有 pb-6 的 24px 留白，初始页居中偏移的重算见下面
              welcome-spacer 注释。 */}
        </div>
      </div>

      {/* round 59：初始页的下半格弹性占位 —— 与消息区等分剩余高度，输入框因此落在**竖直中位**
          （标题不占高度，见 WelcomeHero）；首条消息到达时它收到 0（flex-grow 过渡，主档 .3s），
          输入框平滑落到常规底部，不硬切。
          round 64 修正（用户实拍"对话框有些偏下，居中一点好"）：等分只让**页脚**居中，页脚里卡片
          上下还有别的件，卡片的实际中心并不在窗口中心上。
          结构关系（round 66 推导，仍然成立）：
            记 above = 卡上方那段（pt-4 16 + 选择行 8+32 = 56）
               below = 卡下方那段（现在只剩 pb-6 24）
             自由高度在「消息区」与「本占位」之间等分，于是
              卡片中心 − 窗口中心 = (above − below − mt) / 2     ← 卡片高度在两边约掉，与它无关
          2026-10-18 A · 信笺重定基线（task-50）：mock 里卡片中心 ≈478，现状实拍 ≈445（mt-28/112 时），
            要下移 ~33px ⇒ mt 减 ~66 ⇒ 112 − 66 = 46，取整到 16 的倍数 = **mt-12（48px）**。
            公式代数是"等分参考点"的相对量（真实窗口还含顶栏等偏移），以真机实拍为准；
            A 版 hero 是绝对定位、不占布局高度，所以换报头/换字号**不会**改这里的 above/below。
            将来若把「选择项目」行收进卡片，above 会变 16，必须按当时实拍重测（早前
            "收进卡片后恢复 mt-18"的口径随 A 重定基线作废）。margin 与 flex-grow 一起过渡，
            首条消息到达时与占位收合同步落回（不硬切）。要再上提/下移，旋钮就是这条 mt。 */}
      <div
        data-testid="welcome-spacer"
        className={cn(
          'h-0 basis-0 transition-[flex-grow,margin-top] duration-(--motion-main) ease-main motion-reduce:transition-none',
          'grow-0'
        )}
      />
    </div>
  )
}
