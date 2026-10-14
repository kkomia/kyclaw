import { randomUUID } from 'node:crypto'
import type { Mastra } from '@mastra/core/mastra'
import type { MastraMemory } from '@mastra/core/memory'
import type { LibSQLStore } from '@mastra/libsql'
import type { ApiRoute, MiddlewareHandler } from '@mastra/core/server'
import { AskUserHttpError, AskUserRuntime, type StreamLease } from '../ask-user-runtime'
import { ownStream } from '../stream-lifecycle'
import { validateTaskChatBody } from '../tasks-chat'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'
import { z } from '../../shared/zod'

const targetSchema = z.object({
  threadId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  toolCallId: z.string().min(1).max(200),
  resumeData: z.unknown()
})

export async function createAskUserRoutes(options: {
  memory: MastraMemory
  storage: LibSQLStore
  runtime?: AskUserRuntime
  prepareThread?: (threadId: string) => Promise<void>
  resume: (input: {
    runId: string
    toolCallId: string
    answer: unknown
    threadId: string
  }) => Promise<ReadableStream>
}): Promise<{
  routes: ApiRoute[]
  middleware: MiddlewareHandler
  preparedBody: (request: Request) => Record<string, unknown> | undefined
  resumedRunId: (request: Request) => string | undefined
}> {
  const { registerApiRoute } = await import('@mastra/core/server')
  const resumedRuns = new WeakMap<Request, string>()
  const preparedBodies = new WeakMap<Request, Record<string, unknown>>()
  let runtime: AskUserRuntime | undefined = options.runtime
  const runtimeFor = (mastra: Mastra): AskUserRuntime =>
    (runtime ??= new AskUserRuntime(
      mastra.getAgentById(KYCLAW_AGENT_ID),
      options.memory,
      options.storage
    ))
  const middleware: MiddlewareHandler = async (context, next) => {
    const activeRuntime = runtimeFor(context.get('mastra'))
    const body = (await context.req.raw
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null
    try {
      validateTaskChatBody(body)
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : 'invalid-chat-body' },
        400
      )
    }
    if (!body) return context.json({ error: 'invalid-chat-body' }, 400)
    const approvals: Array<{ runId: string; toolCallId: string }> = []
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      // 只认助手消息：与 SDK 的 extractV6NativeApprovals 同口径，非助手消息里的伪造回应不作数
      const candidate = message as {
        role?: string
        parts?: Array<{ state?: string; toolCallId?: string; approval?: { id?: string } }>
      }
      if (candidate.role !== 'assistant') continue
      for (const part of candidate.parts ?? []) {
        if (part.state !== 'approval-responded' || !part.approval?.id || !part.toolCallId) continue
        const separator = part.approval.id.lastIndexOf('::')
        if (separator < 0 || part.approval.id.slice(separator + 2) !== part.toolCallId) continue
        approvals.push({ runId: part.approval.id.slice(0, separator), toolCallId: part.toolCallId })
      }
    }
    if (body.memory === undefined && body.resumeData === undefined && approvals.length === 0)
      body.memory = { thread: randomUUID(), resource: LOCAL_USER_RESOURCE_ID }
    const memory = body.memory as { thread?: unknown; resource?: unknown } | undefined
    if (!memory) return context.json({ error: 'wrong-scope' }, 409)
    preparedBodies.set(context.req.raw, body)
    if (
      context.req.param('agentId') !== KYCLAW_AGENT_ID ||
      memory?.resource !== LOCAL_USER_RESOURCE_ID ||
      typeof memory.thread !== 'string' ||
      !memory.thread.trim() ||
      memory.thread.length > 200
    )
      return context.json({ error: 'wrong-scope' }, 409)
    let lease: StreamLease | undefined
    try {
      await options.prepareThread?.(memory.thread)
      if (body.resumeData !== undefined) {
        const parsed = targetSchema.safeParse({ ...body, threadId: memory.thread })
        if (!parsed.success) return context.json({ error: 'invalid-target' }, 400)
        lease = await activeRuntime.claim(
          parsed.data.threadId,
          parsed.data.runId,
          parsed.data.toolCallId,
          parsed.data.resumeData
        )
        resumedRuns.set(context.req.raw, parsed.data.runId)
      } else if (approvals.length) {
        if (new Set(approvals.map((approval) => approval.runId)).size !== 1)
          return context.json({ error: 'multiple-resume-runs' }, 400)
        lease = await activeRuntime.claimApprovals(memory.thread, approvals)
        resumedRuns.set(context.req.raw, approvals[0].runId)
      } else lease = activeRuntime.claimInitial(memory.thread)
      await next()
      const response = context.res
      if (!response.body) {
        lease.release()
        return undefined
      }
      context.res = new Response(ownStream(response.body, lease), {
        status: response.status,
        headers: response.headers
      })
      return undefined
    } catch (error) {
      lease?.release()
      if (error instanceof AskUserHttpError)
        return context.json({ error: error.message }, error.status)
      throw error
    }
  }
  const routes = [
    registerApiRoute('/ask-user/pending', {
      method: 'GET',
      handler: async (context) => {
        const threadId = context.req.query('threadId')
        if (!threadId || threadId.length > 200)
          return context.json({ error: 'invalid-thread' }, 400)
        try {
          return context.json(await runtimeFor(context.get('mastra')).pending(threadId))
        } catch (error) {
          if (error instanceof AskUserHttpError)
            return context.json({ error: error.message }, error.status)
          return context.json({ error: 'interaction-storage-error' }, 500)
        }
      }
    }),
    registerApiRoute('/ask-user/cancel', {
      method: 'POST',
      handler: async (context) => {
        const parsed = z
          .object({
            threadId: z.string().min(1).max(200),
            runId: z.string().min(1).max(200).optional()
          })
          .safeParse(await context.req.json().catch(() => null))
        if (!parsed.success) return context.json({ error: 'invalid-target' }, 400)
        try {
          return context.json(
            await runtimeFor(context.get('mastra')).cancel(parsed.data.threadId, parsed.data.runId)
          )
        } catch (error) {
          if (error instanceof AskUserHttpError)
            return context.json({ error: error.message }, error.status)
          return context.json({ error: 'interaction-storage-error' }, 500)
        }
      }
    }),
    registerApiRoute('/ask-user/resume', {
      method: 'POST',
      handler: async (context) => {
        const parsed = targetSchema.safeParse(await context.req.json().catch(() => null))
        if (!parsed.success) return context.json({ error: 'invalid-target' }, 400)
        let release: (() => void) | undefined
        try {
          const claim = await runtimeFor(context.get('mastra')).claim(
            parsed.data.threadId,
            parsed.data.runId,
            parsed.data.toolCallId,
            parsed.data.resumeData
          )
          release = claim.release
          const { createUIMessageStreamResponse } = await import('ai')
          const stream = await options.resume({
            runId: parsed.data.runId,
            toolCallId: parsed.data.toolCallId,
            answer: claim.answer,
            threadId: parsed.data.threadId
          })
          const guarded = ownStream(stream, claim)
          return createUIMessageStreamResponse({ stream: guarded })
        } catch (error) {
          release?.()
          if (error instanceof AskUserHttpError)
            return context.json({ error: error.message }, error.status)
          return context.json({ error: 'interaction-storage-error' }, 500)
        }
      }
    })
  ]
  return {
    routes,
    middleware,
    preparedBody: (request: Request) => preparedBodies.get(request),
    resumedRunId: (request: Request): string | undefined => resumedRuns.get(request)
  }
}
