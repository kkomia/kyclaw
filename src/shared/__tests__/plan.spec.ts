import { describe, expect, it } from 'vitest'
import {
  PLAN_BODY_MAX_CHARS,
  planBodySchema,
  sessionPlanSchema,
  submitPlanSchema,
  userPlanDecisionSchema
} from '../plan'

describe('Plan wire contract', () => {
  const ref = { planId: 'p', revision: 1, version: 2 }
  it('rejects model-fabricated approved and excess payload', () => {
    expect(submitPlanSchema.safeParse({ ...ref, body: 'plan', approved: true }).success).toBe(false)
    expect(userPlanDecisionSchema.safeParse({ ...ref, decision: 'approved' }).success).toBe(false)
    expect(planBodySchema.safeParse('x'.repeat(PLAN_BODY_MAX_CHARS + 1)).success).toBe(false)
    expect(planBodySchema.safeParse('x'.repeat(PLAN_BODY_MAX_CHARS)).success).toBe(true)
  })
  it('requires execution binding and rejects inconsistent state', () => {
    expect(userPlanDecisionSchema.safeParse({ ...ref, decision: 'approve' }).success).toBe(false)
    expect(
      sessionPlanSchema.safeParse({
        threadId: 't',
        ...ref,
        mode: 'executing',
        body: 'plan',
        feedback: null,
        approval: null,
        updatedAt: new Date().toISOString()
      }).success
    ).toBe(false)
  })
})
