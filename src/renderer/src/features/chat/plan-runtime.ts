import type { Chat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import { createPlansStore, planSession } from '@renderer/lib/plans-store'
import { planRefSchema, planThreadIdSchema } from '@shared/plan'
import { askUserWaiting } from './ask-user-store'
import { hasPendingApproval } from './approval'

const chats = new Map<string, Chat<UIMessage>>()
export const rendererPlansStore = createPlansStore({
  onResume: async (threadId, request) => {
    const chat = chats.get(threadId)
    if (!chat) throw new Error('会话尚未就绪，请切回会话后重试')
    if (chat.status === 'submitted' || chat.status === 'streaming')
      throw new Error('当前对话仍在运行')
    if (askUserWaiting(threadId) || hasPendingApproval(chat.messages[chat.messages.length - 1])) {
      throw new Error('请先处理其它挂起交互')
    }
    const body: unknown = JSON.parse(request.init.body)
    if (typeof body !== 'object' || body === null || !('threadId' in body) || !('ref' in body)) {
      throw new Error('计划恢复请求格式不对')
    }
    const target = planThreadIdSchema.parse(body.threadId)
    if (target !== threadId) throw new Error('计划恢复会话不一致')
    const ref = planRefSchema.parse(body.ref)
    await chat.sendMessage(undefined, { body: { planResume: { threadId: target, ref } } })
    if (chat.error) throw chat.error
  }
})

export function registerPlanChat(threadId: string, chat: Chat<UIMessage>): void {
  chats.set(threadId, chat)
}

export function forgetPlanChat(threadId: string, forgetState = false): void {
  chats.delete(threadId)
  if (forgetState) rendererPlansStore.getState().forget(threadId)
}

export async function settledPlan(threadId: string): Promise<void> {
  if (!planSession(rendererPlansStore.getState(), threadId).busy) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('计划操作尚未结束，停止未确认，请稍后重试'))
    }, 15_000)
    const unsubscribe = rendererPlansStore.subscribe((state) => {
      if (planSession(state, threadId).busy) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

export function planWaiting(threadId: string): boolean {
  const session = planSession(rendererPlansStore.getState(), threadId)
  return (
    session.busy ||
    (session.error !== null && session.state !== null && session.state.mode !== 'normal') ||
    session.state?.mode === 'awaiting_approval' ||
    session.state?.pendingRevision !== undefined
  )
}

export function resetPlanRuntime(): void {
  for (const threadId of chats.keys()) rendererPlansStore.getState().forget(threadId)
  chats.clear()
}
