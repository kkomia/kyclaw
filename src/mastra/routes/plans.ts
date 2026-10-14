import type { ApiRoute } from '@mastra/core/server'
import { z } from '../../shared/zod'
import { planBodySchema, planRefSchema, planThreadIdSchema } from '../../shared/plan'
import { PlanHttpError, type PlanRuntime } from '../plan-runtime'

const scope = z.strictObject({ threadId: planThreadIdSchema })
export const planEnterRequestSchema = scope.extend({
  expectedVersion: z.number().int().nonnegative()
})
export const planDecisionRequestSchema = z.discriminatedUnion('decision', [
  scope.extend({ ref: planRefSchema, decision: z.literal('approve') }),
  scope.extend({ ref: planRefSchema, decision: z.literal('revise'), feedback: planBodySchema })
])
export const planResumeRequestSchema = scope.extend({ ref: planRefSchema })
export const planCancelRequestSchema = planEnterRequestSchema

export async function createPlanRoutes(runtime: PlanRuntime): Promise<ApiRoute[]> {
  const { registerApiRoute } = await import('@mastra/core/server')
  const { createUIMessageStreamResponse } = await import('ai')
  const handle = async (operation: () => Promise<Response>): Promise<Response> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof z.ZodError)
        return Response.json({ error: 'invalid-plan-request' }, { status: 400 })
      if (error instanceof PlanHttpError)
        return Response.json({ error: error.message }, { status: error.status })
      return Response.json({ error: 'plan-operation-failed' }, { status: 409 })
    }
  }
  return [
    registerApiRoute('/plans/state', {
      method: 'GET',
      handler: async (context) =>
        handle(async () => {
          const { threadId } = scope.parse({ threadId: context.req.query('threadId') })
          return Response.json({ state: await runtime.state(threadId) })
        })
    }),
    registerApiRoute('/plans/enter', {
      method: 'POST',
      handler: async (context) =>
        handle(async () => {
          const input = planEnterRequestSchema.parse(await context.req.json())
          return Response.json({
            state: await runtime.enter(input.threadId, input.expectedVersion)
          })
        })
    }),
    registerApiRoute('/plans/decision', {
      method: 'POST',
      handler: async (context) =>
        handle(async () => {
          const input = planDecisionRequestSchema.parse(await context.req.json())
          return Response.json({
            state: await runtime.decision(
              input.threadId,
              input.ref,
              input.decision,
              input.decision === 'revise' ? input.feedback : undefined
            )
          })
        })
    }),
    registerApiRoute('/plans/resume', {
      method: 'POST',
      handler: async (context) =>
        handle(async () => {
          const input = planResumeRequestSchema.parse(await context.req.json())
          const stream = await runtime.resume(input.threadId, input.ref)
          return createUIMessageStreamResponse({
            stream: stream as Parameters<typeof createUIMessageStreamResponse>[0]['stream']
          })
        })
    }),
    registerApiRoute('/plans/cancel', {
      method: 'POST',
      handler: async (context) =>
        handle(async () => {
          const input = planCancelRequestSchema.parse(await context.req.json())
          return Response.json({
            state: await runtime.cancel(input.threadId, input.expectedVersion)
          })
        })
    })
  ]
}
