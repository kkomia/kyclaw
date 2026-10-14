import { z } from './zod'

export const RULES_IPC_CHANNELS = {
  status: 'rules:status',
  read: 'rules:read-project',
  save: 'rules:save-project'
} as const
export const rulesStatusSchema = z.strictObject({ processorRegistered: z.boolean() })
export type RulesStatus = z.infer<typeof rulesStatusSchema>
export const projectRulesReadArgsSchema = z.tuple([z.string().min(1)])
export const projectRulesSaveArgsSchema = z.tuple([
  z.strictObject({ projectId: z.string().min(1), text: z.string() })
])
export const rulesDiagnosticSchema = z.strictObject({
  scope: z.enum(['global', 'project']),
  code: z.enum([
    'too-large',
    'invalid-text',
    'unsafe-path',
    'read-failed',
    'save-failed',
    'combined-too-large',
    'project-unavailable'
  ]),
  message: z.string()
})
export const projectRulesViewSchema = z.strictObject({
  projectId: z.string(),
  source: z.string(),
  text: z.string(),
  diagnostics: z.array(rulesDiagnosticSchema),
  processorRegistered: z.boolean(),
  projectIncluded: z.boolean()
})
export const projectRulesSaveResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), view: projectRulesViewSchema }),
  z.strictObject({ ok: z.literal(false), diagnostics: z.array(rulesDiagnosticSchema) })
])
export type ProjectRulesView = z.infer<typeof projectRulesViewSchema>
export type ProjectRulesSaveResponse = z.infer<typeof projectRulesSaveResponseSchema>
