import { expect, it } from 'vitest'
import { planDecisionRequestSchema, planResumeRequestSchema } from '../routes/plans'

it('HTTP decisions/resume exclude caller run binding and fabricated resumeData', () => {
  const input = { threadId: 't', ref: { planId: 'p', revision: 1, version: 2 } }
  expect(planDecisionRequestSchema.safeParse({ ...input, decision: 'approve' }).success).toBe(true)
  expect(
    planDecisionRequestSchema.safeParse({
      ...input,
      decision: 'approve',
      binding: { runId: 'fake', toolCallId: 'fake' }
    }).success
  ).toBe(false)
  expect(
    planDecisionRequestSchema.safeParse({ ...input, decision: 'revise', feedback: '' }).success
  ).toBe(false)
  expect(
    planResumeRequestSchema.safeParse({ ...input, runId: 'fake', resumeData: { approved: true } })
      .success
  ).toBe(false)
})
