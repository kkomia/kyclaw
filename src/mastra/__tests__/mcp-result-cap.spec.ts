// @vitest-environment node
/**
 * round 62 · MCP 结果尺寸护栏（效率复盘产物）：
 *   - `capMcpText` / `capMcpResult`：只动可识别的文本形态（string / content:[{type:'text'}]），
 *     超限时首尾保留 + 中间截去说明；未超限/非文本原样放行；
 *   - `collectMcpTools`：每个 MCP 工具的 execute 被包了一层——结果超限时真的被截（接线回归）。
 */
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../../shared/settings'
import { capMcpResult, capMcpText, collectMcpTools, MCP_RESULT_MAX_CHARS } from '../mcp'

const NO_APPROVAL = (): boolean => false

function stdioConfig(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'echo',
    name: '回显服务',
    transport: 'stdio',
    command: 'node',
    args: ['fixture.mjs'],
    enabled: true,
    readOnlyTools: [],
    ...patch
  }
}

describe('capMcpText（纯函数）', () => {
  it('未超限原样返回（含恰好等于上限）', () => {
    expect(capMcpText('hello')).toBe('hello')
    const exact = 'x'.repeat(MCP_RESULT_MAX_CHARS)
    expect(capMcpText(exact)).toBe(exact)
  })

  it('超限：首尾保留 + 中间截去说明；头尾内容正确、总长受限', () => {
    const head = 'H'.repeat(MCP_RESULT_MAX_CHARS - 1)
    const middle = 'M'.repeat(50_000)
    const tail = 'T'.repeat(20_000)
    const result = capMcpText(head + middle + tail)
    expect(result.length).toBeLessThan(head.length + middle.length + tail.length)
    expect(result.startsWith('H'.repeat(1000))).toBe(true)
    expect(result).toContain('结果过长')
    expect(result).toContain('请分段获取')
    expect(result.endsWith('T'.repeat(1000))).toBe(true)
    // 头部保留 = 上限 − 尾部额度；加上说明行与尾部，不超过上限 + 说明的余量
    expect(result.length).toBeLessThanOrEqual(MCP_RESULT_MAX_CHARS + 200)
  })
})

describe('capMcpResult（形状处理）', () => {
  it('string 走 capMcpText', () => {
    expect(capMcpResult('ok')).toBe('ok')
  })

  it('content:[{type:text}] 只截文本块；非文本块（图片等）原样保留', () => {
    const big = 'A'.repeat(MCP_RESULT_MAX_CHARS + 1)
    const image = { type: 'image', data: 'base64', mimeType: 'image/png' }
    const result = capMcpResult({
      content: [{ type: 'text', text: '短' }, { type: 'text', text: big }, image],
      isError: false
    }) as { content: Array<{ type: string; text?: string }>; isError: boolean }
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: '短' })
    expect(result.content[1]?.text).toContain('结果过长')
    expect(result.content[2]).toBe(image)
  })

  it('没有 content 数组 / 非对象：原样放行', () => {
    const structured = { foo: 'bar' }
    expect(capMcpResult(structured)).toBe(structured)
    expect(capMcpResult(null)).toBeNull()
    expect(capMcpResult(42)).toBe(42)
  })
})

describe('collectMcpTools 的 execute 包装（接线回归）', () => {
  it('超限结果经过护栏再回给模型', async () => {
    const big = 'Z'.repeat(MCP_RESULT_MAX_CHARS + 10_000)
    const collected = collectMcpTools({
      toolsets: {
        echo: { echo: { id: 'echo_echo', description: '', execute: async () => big } }
      } as never,
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    const execute = collected['mcp__echo__echo'].execute as unknown as (
      input: unknown,
      ctx: unknown
    ) => Promise<unknown>
    const result = (await execute({}, {})) as string
    expect(result.length).toBeLessThan(big.length)
    expect(result).toContain('结果过长')
  })

  it('未超限 / 没有 execute 的工具不受影响', async () => {
    const collected = collectMcpTools({
      toolsets: {
        echo: { small: { id: 'echo_small', description: '', execute: async () => 'ok' } }
      } as never,
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    const execute = collected['mcp__echo__small'].execute as unknown as (
      input: unknown,
      ctx: unknown
    ) => Promise<unknown>
    expect(await execute({}, {})).toBe('ok')
  })
})
