// @vitest-environment node
/**
 * B3.4：内核 session 错误 → 用户可读文案（writer-held / conflict / agent-busy 当一等错误）。
 * 说明：writer-held 的真实触发在集成测试里**未复现**（第二进程可并发跑同一 session）；
 * 这里保证错误码映射与文案不会退化成「静默重试」。
 */
import { describe, expect, it } from 'vitest'
import { kernelUserError } from '../kernel-adapter'

describe('kernel session 错误文案', () => {
  it('writer-held → 明确提示“另一个窗口/进程占用”', () => {
    const mapped = kernelUserError(
      new Error('kernel rpc: session/prompt failed (session/writer-held)')
    )
    expect(mapped.message).toContain('另一个窗口/进程占用')
    expect(mapped.message).toContain('session/writer-held')
  })

  it('conflict → 明确提示“已属于另一个目录”', () => {
    const mapped = kernelUserError(new Error('session/conflict: session id belongs to another cwd'))
    expect(mapped.message).toContain('另一个目录')
    expect(mapped.message).toContain('session/conflict')
  })

  it('agent-busy → 明确提示“被子 agent 占用”', () => {
    const mapped = kernelUserError(new Error('session/agent-busy'))
    expect(mapped.message).toContain('子 agent 占用')
  })

  it('其它错误原样返回（不吞、不改写）', () => {
    const original = new Error('boom')
    expect(kernelUserError(original)).toBe(original)
  })
})
