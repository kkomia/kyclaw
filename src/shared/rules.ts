export const RULES_SCOPE_MAX_BYTES = 16 * 1024
export const RULES_COMBINED_MAX_BYTES = 24 * 1024
export const PROJECT_RULES_DIRECTORY = '.kyclaw'
export const PROJECT_RULES_FILENAME = 'rules.md'

export type RulesScope = 'global' | 'project'
export type RulesDiagnosticCode =
  | 'too-large'
  | 'invalid-text'
  | 'unsafe-path'
  | 'read-failed'
  | 'save-failed'
  | 'combined-too-large'
  | 'project-unavailable'

export interface RulesDiagnostic {
  scope: RulesScope
  code: RulesDiagnosticCode
  message: string
}

export interface RulesReadResult {
  text: string
  diagnostics: RulesDiagnostic[]
}

export type RulesSaveResult = { ok: true } | { ok: false; diagnostics: RulesDiagnostic[] }

export function rulesByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export function rulesTextProblem(text: string, scope: RulesScope): RulesDiagnostic | null {
  if (
    text.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
  ) {
    return { scope, code: 'invalid-text', message: '规矩必须是合法 UTF-8 文本，且不能包含 NUL。' }
  }
  if (rulesByteLength(text) > RULES_SCOPE_MAX_BYTES) {
    return { scope, code: 'too-large', message: '每份规矩最多 16 KiB（UTF-8）。' }
  }
  return null
}

export function validateRulesForSave(text: string, scope: RulesScope): RulesSaveResult {
  const problem = rulesTextProblem(text, scope)
  return problem === null ? { ok: true } : { ok: false, diagnostics: [problem] }
}

export interface CombinedRules {
  global: string
  project: string
  diagnostics: RulesDiagnostic[]
}

export function combineRules(global: RulesReadResult, project: RulesReadResult): CombinedRules {
  const diagnostics = [...global.diagnostics, ...project.diagnostics]
  const globalProblem = rulesTextProblem(global.text, 'global')
  const projectProblem = rulesTextProblem(project.text, 'project')
  if (globalProblem !== null) diagnostics.push(globalProblem)
  if (projectProblem !== null) diagnostics.push(projectProblem)
  const globalText = globalProblem === null ? global.text : ''
  let projectText = projectProblem === null ? project.text : ''
  if (rulesByteLength(globalText) + rulesByteLength(projectText) > RULES_COMBINED_MAX_BYTES) {
    projectText = ''
    diagnostics.push({
      scope: 'project',
      code: 'combined-too-large',
      message: '全局与项目规矩合计超过 24 KiB，已保留全局规矩，本轮未加载项目规矩。'
    })
  }
  return { global: globalText, project: projectText, diagnostics }
}
