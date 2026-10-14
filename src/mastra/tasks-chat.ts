import type { ChatStreamHandlerParams } from '@mastra/ai-sdk'
import type { UIMessage } from 'ai'
import type { TasksContext } from './tasks-context'

const CHAT_FIELDS = new Set([
  'messages',
  'memory',
  'trigger',
  'id',
  'messageId',
  'providerOptions',
  'modelSettings',
  'resumeData',
  'runId',
  'toolCallId'
])

export function validateTaskChatBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('invalid-chat-body')
  const body = raw as Record<string, unknown>
  if (body.inputProcessors !== undefined || body.outputProcessors !== undefined)
    throw new Error('server-owned-processors')
  if (Object.keys(body).some((key) => !CHAT_FIELDS.has(key)))
    throw new Error('server-owned-chat-options')
  if (!Array.isArray(body.messages)) throw new Error('invalid-messages')
  if (body.runId !== undefined && body.resumeData === undefined)
    throw new Error('server-owned-run-id')
  return body
}

export function prepareTaskChatParams(
  body: Record<string, unknown>,
  tasksContext: TasksContext,
  threadId: string,
  resumedRunId?: string
): ChatStreamHandlerParams<UIMessage> {
  const request = tasksContext.prepareRequest(threadId, resumedRunId)
  return { ...body, ...request } as ChatStreamHandlerParams<UIMessage>
}
