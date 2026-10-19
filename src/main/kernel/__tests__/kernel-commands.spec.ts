// @vitest-environment node
/**
 * PB-005-F2：未知命令**不再静默丢弃**（纯函数层）。
 *
 * 背景（Eve 实测）：内核 `commands/execute` 对 `/eve-nope-command` 返回 `undefined`、不产生
 * `command/run` 事件。我们在 adapter 里用内核自己的 `commands/list` 先校验，合成与内核同形的
 * `{commandId, result:{kind:'error', text}}`。这里只测纯函数；"真的没把未知命令发给内核"的行为
 * 在 `b3-4-persistence.spec.ts` 的命令平面用例里（同一套 fake 传输层）。
 */
import { describe, expect, it } from 'vitest'
import { commandNameFromLine, isCommandLine, unknownCommandResult } from '../kernel-commands'

const AVAILABLE = [
  { name: 'compact' },
  { name: 'export' },
  { name: 'feedback' },
  { name: 'goal' },
  { name: 'permission' },
  { name: 'plan' }
]

describe('commandNameFromLine', () => {
  it('带斜杠/参数/空白都能取到命令名', () => {
    expect(commandNameFromLine('/goal')).toBe('goal')
    expect(commandNameFromLine('/goal pause')).toBe('goal')
    expect(commandNameFromLine('  /plan off  ')).toBe('plan')
    expect(commandNameFromLine('goal resume')).toBe('goal')
    expect(commandNameFromLine('/eve-nope-command')).toBe('eve-nope-command')
  })

  it('空行与只有斜杠 → null', () => {
    expect(commandNameFromLine('')).toBeNull()
    expect(commandNameFromLine('   ')).toBeNull()
    expect(commandNameFromLine('/')).toBeNull()
    expect(commandNameFromLine('/ ')).toBeNull()
  })
})

describe('unknownCommandResult', () => {
  it('形状与内核同形：commandId + result{kind:error,text}，commandId 带 kyclaw- 前缀', () => {
    const result = unknownCommandResult('/eve-nope-command', AVAILABLE)
    expect(result.commandId).toMatch(/^kyclaw-unknown-/u)
    expect(result.result.kind).toBe('error')
  })

  it('文案含原样命令 + 可用命令清单（清单来自内核，不硬编码）', () => {
    const result = unknownCommandResult('/eve-nope-command', AVAILABLE)
    expect(result.result.text).toContain('/eve-nope-command')
    for (const command of AVAILABLE) expect(result.result.text).toContain(`/${command.name}`)
    // 明确"不会发到内核"，避免用户以为执行了
    expect(result.result.text).toContain('不会发送到内核')
  })

  it('空命令行给出专门文案，不说成"未识别的命令：/xxx"', () => {
    const result = unknownCommandResult('   ', AVAILABLE)
    expect(result.commandId).toBe('kyclaw-unknown-empty')
    expect(result.result.text).toContain('命令行是空的')
    expect(result.result.text).not.toContain('未识别的命令：')
  })

  it('不带 / 的行（Eve P3 残留）：判未知并说清"要以 / 开头"，不交给内核', () => {
    expect(isCommandLine('goal')).toBe(false)
    expect(isCommandLine(' /goal ')).toBe(true)
    const result = unknownCommandResult('goal', AVAILABLE)
    expect(result.result.text).toContain('未识别的命令：goal')
    expect(result.result.text).toContain('命令要以 / 开头')
    expect(result.result.text).toContain('/goal')
  })

  it('清单拉不到时文案仍可读（不出现"可用命令："后空一截）', () => {
    const result = unknownCommandResult('/x', [])
    expect(result.result.text).toContain('命令清单')
    expect(result.result.text).not.toContain('可用命令：。')
  })
})
