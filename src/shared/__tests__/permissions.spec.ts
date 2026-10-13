import { describe, expect, it } from 'vitest'
import {
  isAllowedByRules,
  normalizeToolName,
  normalizeWorkspacePath,
  ruleMatches,
  toolBasename,
  withAllowedRule,
  withoutAllowedRule
} from '../permissions'

/**
 * 权限规则（T13「永久允许」）的归一与匹配：粒度 = 工具 + 工作区。
 * 主进程（guard.needsApproval）与渲染端（审批卡写设置）共用这一份 —— 两边对
 * "哪条规则覆盖这次调用"必须是同一个答案，否则会出现"UI 说已永久允许、服务端还在问"。
 *
 * T12 重审：工具名匹配用**整名**（`mcp__a__write` ≠ `mcp__b__write` ≠ `write`），
 * 只有分级才取 `__` 末段（toolBasename）。
 */
describe('normalizeToolName：整名归一（规则匹配 / 会话记忆）', () => {
  it('去空白、大小写归一；MCP 名不拆段', () => {
    expect(normalizeToolName('write')).toBe('write')
    expect(normalizeToolName('  Write ')).toBe('write')
    expect(normalizeToolName('mcp__filesystem__write')).toBe('mcp__filesystem__write')
  })

  it('不同 server 的同名工具、以及内置同名工具，彼此都不相等（T12：串名是越权）', () => {
    expect(normalizeToolName('mcp__a__write')).not.toBe(normalizeToolName('mcp__b__write'))
    expect(normalizeToolName('mcp__a__write')).not.toBe(normalizeToolName('write'))
  })
})

describe('toolBasename：分级用的末段', () => {
  it('mcp__server__tool 取最后一段；无 __ 的名字原样', () => {
    expect(toolBasename('write')).toBe('write')
    expect(toolBasename(' mcp__shell__delete ')).toBe('delete')
    expect(toolBasename('mcp__a__b__read')).toBe('read')
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
  })

  it('内置 write 的规则不覆盖 mcp__x__write；反向也一样（T12：粒度是整个工具名）', () => {
    expect(ruleMatches(rule, 'mcp__x__write', 'D:\\项目\\demo')).toBe(false)

    const mcpRule = { tool: 'mcp__x__write', workspace: 'D:\\项目\\demo', mode: 'allow' } as const
    expect(ruleMatches(mcpRule, 'mcp__x__write', 'D:\\项目\\demo')).toBe(true)
    expect(ruleMatches(mcpRule, 'mcp__y__write', 'D:\\项目\\demo')).toBe(false)
    expect(ruleMatches(mcpRule, 'write', 'D:\\项目\\demo')).toBe(false)
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

describe('withoutAllowedRule：撤销一条允许规则（round 71）', () => {
  it('按同一把尺摘掉命中的条目（写法归一后相等就算同一条）；返回新数组，不改入参', () => {
    const rules = [
      { tool: 'write', workspace: 'D:\\项目\\demo', mode: 'allow' },
      { tool: 'edit', workspace: 'D:\\项目\\demo', mode: 'allow' }
    ] as const

    const after = withoutAllowedRule(rules, 'write', 'd:/项目/demo')
    expect(after).toEqual([{ tool: 'edit', workspace: 'D:\\项目\\demo', mode: 'allow' }])
    expect(rules).toHaveLength(2)
  })

  it('没有命中就是原样一份（不抛、不误删别的工具/工作区）', () => {
    const rules = [{ tool: 'write', workspace: 'D:\\项目\\demo', mode: 'allow' }] as const

    expect(withoutAllowedRule(rules, 'write', 'D:\\项目\\另一个')).toHaveLength(1)
    expect(withoutAllowedRule(rules, 'edit', 'D:\\项目\\demo')).toHaveLength(1)
    expect(withoutAllowedRule([], 'write', 'D:\\项目\\demo')).toEqual([])
  })
})
