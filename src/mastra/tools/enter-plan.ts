import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { sessionPlanSchema, type SessionPlan } from '../../shared/plan'
import type { PlanRuntime } from '../plan-runtime'

const inputSchema = z.strictObject({ expectedVersion: z.number().int().nonnegative() })
export async function createEnterPlanTool(
  runtime: PlanRuntime
): Promise<Tool<z.infer<typeof inputSchema>, SessionPlan>> {
  const { createTool } = await import('@mastra/core/tools')
  return createTool({
    id: 'enter_plan',
    description:
      'Enter read-only planning. This does not approve a plan or grant tool permissions.',
    inputSchema,
    outputSchema: sessionPlanSchema,
    execute: async (input, context) => {
      const identity = runtime.identityOf(context.requestContext)
      const state = await runtime.state(identity.threadId)
      if (state.mode !== 'planning' || state.version !== input.expectedVersion)
        throw new Error(
          'enter_plan requires the user to enter planning from the Plan control before starting this run'
        )
      return state
    }
  })
}
