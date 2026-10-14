import { z } from './zod'

export const PLAN_BODY_MAX_CHARS = 64_000
export const planThreadIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((id) => id !== 'default')
const idSchema = z.string().trim().min(1).max(256)
export const planBodySchema = z.string().min(1).max(PLAN_BODY_MAX_CHARS)
export const planRefSchema = z.strictObject({
  planId: idSchema,
  revision: z.number().int().positive(),
  version: z.number().int().nonnegative()
})
export const planBindingSchema = z.strictObject({ runId: idSchema, toolCallId: idSchema })
export const submitPlanSchema = planRefSchema.extend({ body: planBodySchema })
export const userPlanDecisionSchema = z.discriminatedUnion('decision', [
  planRefSchema.extend({ decision: z.literal('approve'), binding: planBindingSchema }),
  planRefSchema.extend({ decision: z.literal('revise'), feedback: planBodySchema }),
  planRefSchema.extend({ decision: z.literal('cancel') })
])
export const sessionPlanSchema = z
  .strictObject({
    threadId: planThreadIdSchema,
    version: z.number().int().nonnegative(),
    mode: z.enum(['normal', 'planning', 'awaiting_approval', 'executing', 'cancelled']),
    planId: idSchema.nullable(),
    revision: z.number().int().nonnegative(),
    body: planBodySchema.nullable(),
    feedback: planBodySchema.nullable(),
    approval: planBindingSchema.nullable(),
    pendingRevision: z
      .strictObject({
        binding: planBindingSchema,
        submittedRevision: z.number().int().positive()
      })
      .optional(),
    updatedAt: z.string().datetime()
  })
  .superRefine((state, ctx) => {
    const valid =
      state.mode === 'normal'
        ? state.planId === null &&
          state.revision === 0 &&
          state.body === null &&
          state.feedback === null &&
          state.approval === null
        : state.planId !== null &&
          state.revision > 0 &&
          ((state.mode !== 'awaiting_approval' && state.mode !== 'executing') ||
            state.body !== null) &&
          (state.mode === 'executing'
            ? state.approval !== null
            : state.mode === 'awaiting_approval' || state.approval === null)
    if (
      !valid ||
      (state.pendingRevision &&
        ((state.mode !== 'planning' && state.mode !== 'cancelled') ||
          state.pendingRevision.submittedRevision + 1 !== state.revision ||
          state.feedback === null))
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent plan state' })
  })

export type PlanRef = z.infer<typeof planRefSchema>
export type PlanBinding = z.infer<typeof planBindingSchema>
export type SubmitPlan = z.infer<typeof submitPlanSchema>
export type UserPlanDecision = z.infer<typeof userPlanDecisionSchema>
export type SessionPlan = z.infer<typeof sessionPlanSchema>
