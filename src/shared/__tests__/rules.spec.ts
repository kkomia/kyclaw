import { describe, expect, it } from 'vitest'
import {
  combineRules,
  RULES_COMBINED_MAX_BYTES,
  RULES_SCOPE_MAX_BYTES,
  rulesByteLength,
  rulesTextProblem,
  validateRulesForSave,
  type RulesReadResult
} from '../rules'

const read = (text: string): RulesReadResult => ({ text, diagnostics: [] })

describe('规则文本契约', () => {
  it('按 UTF-8 字节计量，两种范围允许空文本及恰好 16 KiB', () => {
    expect(rulesByteLength('中')).toBe(3)
    for (const scope of ['global', 'project'] as const) {
      expect(validateRulesForSave('', scope)).toEqual({ ok: true })
      expect(validateRulesForSave('a'.repeat(RULES_SCOPE_MAX_BYTES), scope)).toEqual({ ok: true })
      expect(validateRulesForSave('中'.repeat(5462), scope)).toMatchObject({ ok: false })
      expect(validateRulesForSave('a'.repeat(RULES_SCOPE_MAX_BYTES + 1), scope)).toMatchObject({
        ok: false,
        diagnostics: [{ scope, code: 'too-large' }]
      })
    }
  })

  it('拒绝 NUL 和孤立代理项，接受合法 Unicode', () => {
    for (const text of ['a\0b', '\uD800', '\uDC00', '\uD800a']) {
      expect(validateRulesForSave(text, 'global')).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'invalid-text' }]
      })
    }
    expect(validateRulesForSave('你好😀\uFEFF', 'global')).toEqual({ ok: true })
  })

  it('合计恰好 24 KiB 接受，超限完整拒绝项目而保留全局', () => {
    const global = 'g'.repeat(RULES_SCOPE_MAX_BYTES)
    const project = 'p'.repeat(RULES_COMBINED_MAX_BYTES - RULES_SCOPE_MAX_BYTES)
    expect(combineRules(read(global), read(project))).toEqual({ global, project, diagnostics: [] })
    expect(combineRules(read(global), read(project + 'p'))).toMatchObject({
      global,
      project: '',
      diagnostics: [{ scope: 'project', code: 'combined-too-large' }]
    })
  })

  it('外部读入的单份超限或非法文本整份拒绝，保留读取诊断', () => {
    const result = combineRules(read('正常'), {
      text: 'p'.repeat(RULES_SCOPE_MAX_BYTES + 1),
      diagnostics: [{ scope: 'project', code: 'read-failed', message: '读取诊断' }]
    })
    expect(result.global).toBe('正常')
    expect(result.project).toBe('')
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['read-failed', 'too-large'])
    expect(combineRules(read('\0'), read('项目'))).toMatchObject({ global: '', project: '项目' })
  })
})

/**
 * 用户口径：界面上统一叫「记忆指令」（更早的旧说法「约束」「我的规矩」只剩历史）。
 * `RulesDiagnostic.message` 就是要显示给用户的那句话 —— 它出现在设置页「记忆指令」栏与会话里，
 * 所以这一组把**每一句**的措辞钉住，外加一条"这四个文件里再没有旧说法"的守卫，
 * 免得改文案时漏掉某一处（这几句分散在四个模块里，靠人眼看不住）。
 */
describe('用户可见的诊断文案（统一说「记忆指令」）', () => {
  it('文本超限 / 非法文本 / 合计超限三句都用「记忆指令」', () => {
    expect(rulesTextProblem('a'.repeat(RULES_SCOPE_MAX_BYTES + 1), 'global')?.message).toBe(
      '每份记忆指令最多 16 KiB（UTF-8）。'
    )
    expect(rulesTextProblem('a\0b', 'project')?.message).toBe(
      '记忆指令必须是合法 UTF-8 文本，且不能包含 NUL。'
    )

    const global = 'g'.repeat(RULES_SCOPE_MAX_BYTES)
    const project = 'p'.repeat(RULES_COMBINED_MAX_BYTES - RULES_SCOPE_MAX_BYTES + 1)
    expect(
      combineRules(read(global), read(project)).diagnostics.map((entry) => entry.message)
    ).toEqual(['全局与项目记忆指令合计超过 24 KiB，已保留全局记忆指令，本轮未加载项目记忆指令。'])
  })

  it('产出这几句话的四个文件里不再出现旧说法「规矩」「约束」（改文案漏一处的守卫）', async () => {
    const files = [
      '../rules.ts',
      '../../main/project-rules.ts',
      '../../main/ipc/rules.ts',
      '../../mastra/rules.ts'
    ]
    const { readFile } = await import('node:fs/promises')
    for (const relative of files) {
      const text = await readFile(new URL(relative, import.meta.url), 'utf8')
      expect(text, relative).not.toContain('规矩')
      expect(text, relative).not.toContain('约束')
    }
  })
})
