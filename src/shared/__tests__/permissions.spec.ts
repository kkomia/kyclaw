import { describe, expect, it } from 'vitest'
import {
  isAllowedByRules,
  normalizeToolName,
  normalizeWorkspacePath,
  ruleMatches,
  withAllowedRule
} from '../permissions'

/**
 * 权限规则（T13「永久允许」）的归一与匹配：粒度 = 工具 + 工作区。
 * 主进程（guard.needsApproval）与渲染端（审批卡写设置）共用这一份 —— 两边对
 * "哪条规则覆盖这次调用"必须是同一个答案，否则会出现"UI 说已永久允许、服务端还在问"。
 */
describe('normalizeToolName', () => {
  it('MCP 名取最后一段；去空白、大小写归一', () => {
    expect(normalizeToolName('write')).toBe('write')
    expect(normalizeToolName('  Write ')).toBe('write')
    expect(normalizeToolName('mcp__filesystem__write')).toBe('write')
  })
})

describe('normalizeWorkspacePath', () => {
  it('分隔符与大小写归一、去尾部分隔符', () => {
    expect(normalizeWorkspacePath('D:\\项目\\demo')).toBe('d:/项目/demo')
    expect(normalizeWorkspacePath('d:/项目/demo/')).toBe('d:/项目/demo')
    expect(normalizeWorkspacePath('D:\\项目\\demo\\')).toBe('d:/项目/demo')
  })
})

describe('ruleMatches / isAllowedByRules', () => {
  const rule = { tool: 'write', workspace: 'D:\\项目\\demo', mode: 'allow' } as const

  it('同工具 + 同工作区（写法归一后）才算命中', () => {
    expect(ruleMatches(rule, 'write', 'D:\\项目\\demo')).toBe(true)
    expect(ruleMatches(rule, 'write', 'd:/项目/demo')).toBe(true)
    expect(ruleMatches(rule, 'edit', 'D:\\项目\\demo')).toBe(false)
    expect(ruleMatches(rule, 'write', 'D:\\项目\\另一个')).toBe(false)
    expect(ruleMatches(rule, 'mcp__x__write', 'D:\\项目\\demo')).toBe(true)
  })

  it('isAllowedByRules：任一命中即放行；空表一律不放行', () => {
    expect(isAllowedByRules([], 'write', 'D:\\项目\\demo')).toBe(false)
    expect(isAllowedByRules([rule], 'write', 'D:\\项目\\demo')).toBe(true)
    expect(isAllowedByRules([rule], 'write', 'D:\\项目\\另一个')).toBe(false)
  })
})

describe('withAllowedRule', () => {
  it('追加一条新的允许规则（不动原数组）', () => {
    const before = [] as const
    const after = withAllowedRule(before, 'write', 'D:\\项目\\demo')

    expect(after).toEqual([{ tool: 'write', workspace: 'D:\\项目\\demo', mode: 'allow' }])
    expect(before).toEqual([])
  })

  it('已有同工具 + 同工作区（写法归一后）的规则就不重复加', () => {
    const rules = [{ tool: 'write', workspace: 'd:/项目/demo', mode: 'allow' } as const]

    expect(withAllowedRule(rules, 'write', 'D:\\项目\\demo')).toHaveLength(1)
    expect(withAllowedRule(rules, 'edit', 'D:\\项目\\demo')).toHaveLength(2)
  })
})
