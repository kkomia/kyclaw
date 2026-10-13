/**
 * 每会话一个 Chat 实例（T9 的"切走不掐流"，spec §7.2 的目标语义）。
 *
 * 为什么不是 useChat 直接管：useChat 默认在组件卸载时 chat.stop()（`@ai-sdk/react` 的行为），
 * 切会话 = 卸载 = 掐断当前这轮生成。这里改成**外部管理的 Chat**（`useChat({ chat })`
 * 对自有实例不做卸载清理）：实例挂在模块级注册表里，切换会话只是换视图，
 * 生成继续跑完、消息留在实例里，切回去就是完整结果。
 *
 * "停止"仍然有效：Composer 的停止钮走 chat.stop()（用户显式要停），不受这层影响。
 *
 * 生命周期：
 *   - 首次进入某会话：拉服务端历史（message-map 回灌）→ 建 Chat（初值即历史）；
 *   - 出错（历史拉不到）时不缓存失败，交给 UI 重试（重试 = dropThreadChat + 重新挂载）；
 *   - 删除会话时 dropThreadChat 丢掉内存态。
 *
 * 审批（T13）：Chat 挂 `sendAutomaticallyWhen = canResumeAfterApproval`（approval.ts 里的自判，
 * 相对 AI SDK 内置版放宽了三类"永不在 UI 消息里收束"的 part：providerExecuted、Mastra 记忆工具、
 * 以及挂起时兄弟工具停在 input-available 的那档（round28 实测：不同步放宽会导致批准后永不续跑，
 * 见 approval.ts 头注）；用户做完决策（addToolApprovalResponse）后自动把消息发回服务端续跑；
 * onFinish 里把"还停在等审批"的轮次标出来（awaitingApproval），渲染端据此不把它当完成轮。
 * 重开会话时挂起的审批由 message-map 从存储 metadata 恢复成 approval-requested（round28）。
 * round 33：onFinish 把 ai@7 给的 finishReason 也带进 TurnOutcome（ChatPage 据此在轮末给一行
 * 可见提示：`tool-calls` 收尾 = 单轮步数预算用尽，`length` = 输出被截断）。
 */
import { Chat } from '@ai-sdk/react'
import type { ChatTransport, FinishReason, UIMessage } from 'ai'
import { mapStoredMessages } from '../../lib/message-map'
import { fetchThreadMessages } from '../../lib/threads-api'
import { canResumeAfterApproval, hasPendingApproval } from './approval'

export interface TurnOutcome {
  isError: boolean
  isAbort: boolean
  /**
   * 这一轮结束时仍停在"等审批"（挂起轮）：onFinish 照样以 isError:false/isAbort:false 触发，
   * 但语义上**不是完成轮** —— 标题生成/完成通知都得等用户做完决策、resume 那一轮跑完再走。
   */
  awaitingApproval: boolean
  /**
   * 这一轮的收尾原因（ai@7 Chat 的 onFinish 给的原生值）。渲染端用它给"被截停/被截断"的轮次
   * 加一行可见提示（round 33）：`tool-calls` 收尾 = 还欠一次模型调用就停了（单轮步数预算用尽），
   * `length` = 输出被长度上限截断。缺省（undefined）= 拿不到原因，不提示。
   */
  finishReason?: FinishReason
}

export interface ThreadChatRuntime {
  transport: ChatTransport<UIMessage>
  /** 历史回灌（默认走服务端；测试注入空实现，不碰网络） */
  loadHistory: (threadId: string) => Promise<UIMessage[]>
  /** 一轮结束的回调（默认 = sessions-store 的 handleTurnEnd / 完成通知） */
  onTurnEnd: (threadId: string, outcome: TurnOutcome) => void
}

/** 默认历史回灌：存储消息 → UIMessage */
async function loadHistoryFromServer(threadId: string): Promise<UIMessage[]> {
  return mapStoredMessages(await fetchThreadMessages(threadId))
}

const chats = new Map<string, Promise<Chat<UIMessage>>>()

/** 取某会话的 Chat 实例（存在即复用；不存在则先回灌历史再建） */
export function threadChat(threadId: string, runtime: ThreadChatRuntime): Promise<Chat<UIMessage>> {
  const existing = chats.get(threadId)
  if (existing !== undefined) return existing

  const created = (async (): Promise<Chat<UIMessage>> => {
    const messages = await runtime.loadHistory(threadId)
    return new Chat<UIMessage>({
      transport: runtime.transport,
      messages,
      onFinish: ({ message, isError, isAbort, finishReason }) =>
        runtime.onTurnEnd(threadId, {
          isError,
          isAbort,
          awaitingApproval: hasPendingApproval(message),
          finishReason
        }),
      /**
       * 审批回灌（T13）：`addToolApprovalResponse` 只把 part 改成 approval-responded，
       * **不会自己再发请求** —— 什么时候续跑由这个判定决定：最后一条助手消息的最后一步里所有
       * 审批都有了回应、且没有别的待办时，自动把消息发回服务端执行工具（判定细节见
       * approval.ts 的 canResumeAfterApproval，滤掉了记忆工具/提供方执行这两类 part）。
       */
      sendAutomaticallyWhen: ({ messages }) => canResumeAfterApproval(messages)
    })
  })()

  // 失败不入缓存（下次挂载会重试）；成功保持同一 Promise，重挂载直接复用
  created.catch(() => {
    if (chats.get(threadId) === created) chats.delete(threadId)
  })
  chats.set(threadId, created)
  return created
}

/** 丢掉一个会话的内存态（删除会话时用；`stop` 同时掐掉还在跑的流） */
export function dropThreadChat(threadId: string, options: { stop?: boolean } = {}): void {
  const entry = chats.get(threadId)
  chats.delete(threadId)
  if (options.stop === true && entry !== undefined) {
    // 取出实例再停：promise 还没解析（历史还在拉）时停不了，交给那句 catch 消化
    entry.then(
      (chat) => chat.stop(),
      () => {}
    )
  }
}

/** 用默认回灌造一条 runtime（ChatPage 用；测试自己给 runtime） */
export function createThreadChatRuntime(
  transport: ChatTransport<UIMessage>,
  onTurnEnd: ThreadChatRuntime['onTurnEnd']
): ThreadChatRuntime {
  return { transport, loadHistory: loadHistoryFromServer, onTurnEnd }
}

/** 测试用：清空注册表（模块级状态不随 render 重置） */
export function resetThreadChats(): void {
  chats.clear()
}

/**
 * 会话实例就绪之前的**占位 Chat**（round 76）。
 *
 * 为什么要有：输入卡要从这一屏的第一帧就在，而 `useChat` 必须拿到一个 Chat 实例。这一枚只用来
 * 占位 —— 消息恒空、状态恒 ready、不挂任何回调；真正的发送一律被 UI 挡住（ChatPage 的 `pending`：
 * 按钮禁用 + 回车不发），所以它**永远不该**被用来发请求。
 *
 * 守卫写在 transport 上而不是靠自觉：真被调用到（挡板漏了一处）就当场抛 —— 宁可炸在这里，
 * 也不要让它悄悄发到 DefaultChatTransport 的默认端点（`/api/chat`，跟我们本地服务不是一回事）。
 *
 * 单例、不进 `chats` 注册表：它与任何会话无关，`resetThreadChats` / `dropThreadChat` 都不该动它
 * （本身无状态，跨用例共享是安全的）。
 */
let placeholder: Chat<UIMessage> | null = null
export function pendingChat(): Chat<UIMessage> {
  placeholder ??= new Chat<UIMessage>({
    transport: {
      sendMessages: async () => {
        throw new Error('会话实例尚未就绪：不该有请求发出去')
      },
      reconnectToStream: async () => null
    }
  })
  return placeholder
}
