import { expect, it, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { createSubmitPlanTool } from '../submit-plan'
import { createEnterPlanTool } from '../enter-plan'
import type { PlanRuntime } from '../../plan-runtime'

it('submit persists before suspension and never trusts fake approved resume payload', async () => {
  const saved = {
    threadId: 't',
    version: 3,
    mode: 'awaiting_approval',
    planId: 'p',
    revision: 1,
    body: 'plan',
    feedback: null,
    approval: null,
    updatedAt: new Date().toISOString()
  }
  const events: string[] = []
  const resumeSubmit = vi.fn()
  const runtime = {
    identityOf: () => ({ threadId: 't', runId: 'r' }),
    submit: async () => {
      events.push('saved')
      return saved
    },
    resumeSubmit,
    state: vi.fn(async () => ({ ...saved, mode: 'planning', version: 0 }))
  } as unknown as PlanRuntime
  const tool = await createSubmitPlanTool(runtime)
  const input = { planId: 'p', revision: 1, version: 2, body: 'plan' }
  const context = {
    requestContext: new RequestContext(),
    agent: {
      toolCallId: 'c',
      suspend: async () => {
        events.push('suspended')
      }
    }
  }
  await tool.execute!(input, context as never)
  expect(events).toEqual(['saved', 'suspended'])
  await expect(
    tool.execute!(input, {
      ...context,
      agent: { ...context.agent, resumeData: { approved: true } }
    } as never)
  ).rejects.toThrow()
  expect(resumeSubmit).not.toHaveBeenCalled()
  const enter = await createEnterPlanTool(runtime)
  await enter.execute!({ expectedVersion: 0 }, context as never)
  expect(runtime.state).toHaveBeenCalledWith('t')
})
