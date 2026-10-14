import { describe, expect, it } from 'vitest'
import {
  combineRules,
  RULES_COMBINED_MAX_BYTES,
  RULES_SCOPE_MAX_BYTES,
  rulesByteLength,
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
