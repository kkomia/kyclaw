import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { sessionPlanSchema, submitPlanSchema, type SubmitPlan } from '../../shared/plan'
import { planRefOf, type PlanRuntime } from '../plan-runtime'

const outputSchema = z.strictObject({
  status: z.enum(['approved', 'revise']),
  state: sessionPlanSchema,
  feedback: z.string().nullable()
})
export async function createSubmitPlanTool(
  runtime: PlanRuntime
): Promise<Tool<SubmitPlan, z.infer<typeof outputSchema>>> {
  const { createTool } = await import('@mastra/core/tools')
  return createTool({
    id: 'submit_plan',
    description:
      'Persist the complete plan and wait for a user decision. Never invent approval; only the user API decides.',
    inputSchema: submitPlanSchema,
    outputSchema,
    execute: async (input, context) => {
      const identity = runtime.identityOf(context.requestContext)
      const agent = context.agent
      if (!agent?.suspend || !agent.toolCallId)
        throw new Error('submit_plan requires an agent suspension context')
      if (agent.resumeData !== undefined) {
        z.strictObject({ type: z.literal('server-plan-decision') }).parse(agent.resumeData)
        return runtime.resumeSubmit(identity, agent.toolCallId, input)
      }
      const saved = await runtime.submit(identity, input)
      await agent.suspend(planRefOf(saved))
      return undefined as never
    }
  })
}
