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
 * 相对 AI SDK 内置版滤掉了 providerExecuted 与 Mastra 记忆工具这两类"永不在 UI 消息里收束"的
 * part——否则同一步里既写记忆又发待审批写工具时不会自动续跑，T18 复核 concern②）；用户做完决策
 * （addToolApprovalResponse）后自动把消息发回服务端续跑；onFinish 里把"还停在等审批"的轮次标出来
 * （awaitingApproval），渲染端据此不把它当完成轮。
 */
import { Chat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage } from 'ai'
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
      onFinish: ({ message, isError, isAbort }) =>
        runtime.onTurnEnd(threadId, {
          isError,
          isAbort,
          awaitingApproval: hasPendingApproval(message)
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
