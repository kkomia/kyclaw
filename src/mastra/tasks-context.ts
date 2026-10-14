import { randomUUID } from 'node:crypto'
import type { InputProcessor, ProcessInputStepArgs } from '@mastra/core/processors'
import { RequestContext } from '@mastra/core/request-context'

export interface TaskResponseIdentity {
  messageId: string
  runId: string
  threadId: string
}

export interface TasksContext {
  processor: InputProcessor
  prepareRequest(
    threadId: string,
    runId?: string
  ): { requestContext: RequestContext; runId: string }
  identityOf(
    requestContext: RequestContext | undefined,
    threadId: string
  ): TaskResponseIdentity | null
}

export function createTasksContext(): TasksContext {
  const key = `tasks-response-${randomUUID()}`
  const scopeKey = `tasks-scope-${randomUUID()}`
  return {
    prepareRequest(threadId, runId = randomUUID()) {
      if (!threadId.trim() || !runId.trim()) throw new Error('任务请求身份不能为空')
      const requestContext = new RequestContext()
      requestContext.set(scopeKey, { threadId, runId })
      return { requestContext, runId }
    },
    processor: {
      id: 'tasks-response-identity',
      processInputStep(args: ProcessInputStepArgs) {
        const { requestContext, messageId, runId } = args
        if (requestContext === undefined) return
        requestContext.set(key, null)
        const scope = requestContext.get(scopeKey) as
          { threadId: string; runId: string } | undefined
        if (!scope || !messageId?.trim()) return
        if (runId !== undefined && runId !== scope.runId) throw new Error('任务请求 runId 不一致')
        const threadIds = new Set(
          args.messages.flatMap((message) => (message.threadId ? [message.threadId] : []))
        )
        if (threadIds.size !== 1 || !threadIds.has(scope.threadId)) return
        requestContext.set(key, { messageId, runId: scope.runId, threadId: scope.threadId })
      }
    },
    identityOf(requestContext, threadId) {
      if (requestContext === undefined) return null
      const identity = requestContext.get(key) as TaskResponseIdentity | null | undefined
      return identity?.threadId === threadId ? { ...identity } : null
    }
  }
}
