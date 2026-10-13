// @vitest-environment node
/**
 * 工具表的**确定顺序**（round 70）：顺序即请求前缀的缓存形状。
 *
 * 为什么值得单开一份 spec：工具定义的顺序一变，模型请求的**前缀就变了**，DeepSeek 的
 * prompt cache 整体失效（缓存按前缀匹配）。内置表是对象字面量，顺序天然固定；MCP 那部分
 * 来自 server 的 `tools/list`——协议不保证顺序，两次发现、不同 server、甚至同一 server 重启
 * 之后都可能抖。这里钉住三件事：
 *   ① **同一份 MCP 工具、两种返回顺序 → 最终工具表逐名一致**（本条是这次的回归判据）；
 *   ② MCP 工具一律排在**内置表之后**，且按名字（= `mcp__<serverId>__<tool>`）**字典序**；
 *   ③ 内置表的前缀顺序不被动（改它就是改缓存形状，必须是一次有意的改动）。
 */
import { describe, expect, it } from 'vitest'
import type { Tool } from '@mastra/core/tools'
import type { KyclawModel } from '../model'
import { createKyclawAgent } from '../agents/kyclaw'

/** 模型解析器只在真跑模型时被调用；这一份只装配，给个空壳 */
const resolveModel = async (): Promise<KyclawModel> => ({}) as unknown as KyclawModel

/** MCP 工具的假件（只要求"不是函数"这一条形状约束，见 @mastra/core 的 ensureToolProperties） */
function fakeMcpTool(name: string): Tool<unknown, unknown, unknown, unknown> {
  return {
    id: name,
    description: `${name} 的假描述`,
    inputSchema: undefined,
    execute: async () => ''
  } as unknown as Tool<unknown, unknown, unknown, unknown>
}

/** 把"名字 → 工具"按给定顺序造成一个对象（模拟 server 的 tools/list 顺序） */
function toolsetInOrder(names: readonly string[]): Record<string, Tool> {
  const table: Record<string, Tool> = {}
  for (const name of names) table[name] = fakeMcpTool(name)
  return table
}

async function toolNamesWith(
  mcp: Record<string, Tool>
): Promise<string[]> {
  const agent = await createKyclawAgent(resolveModel, undefined, {
    mcpTools: async () => mcp
  })
  return Object.keys(await agent.listTools())
}

const SERVER_A = ['mcp__alpha__search', 'mcp__alpha__create', 'mcp__alpha__append']
const SERVER_B = ['mcp__beta__zap', 'mcp__beta__alpha']

describe('工具表顺序：MCP 的返回顺序不许影响最终形状', () => {
  it('同一份 MCP 工具，两种返回顺序 → 最终工具表逐名一致', async () => {
    const forward = await toolNamesWith(toolsetInOrder([...SERVER_A, ...SERVER_B]))
    const reverse = await toolNamesWith(toolsetInOrder([...SERVER_B, ...SERVER_A].reverse()))

    expect(reverse).toEqual(forward)
  })

  it('MCP 工具排在内置表之后，且按 serverId + 工具名字典序', async () => {
    const names = await toolNamesWith(toolsetInOrder([...SERVER_B, ...SERVER_A]))

    const mcp = names.filter((name) => name.startsWith('mcp__'))
    expect(mcp).toEqual([
      'mcp__alpha__append',
      'mcp__alpha__create',
      'mcp__alpha__search',
      'mcp__beta__alpha',
      'mcp__beta__zap'
    ])
    // 内置表全在 MCP 之前：MCP 段必须是一整块（不能插进内置表中间）
    expect(names.indexOf(mcp[0])).toBe(names.length - mcp.length)
  })

  it('内置表的前缀顺序固定（改它就是改缓存形状）', async () => {
    const names = await toolNamesWith({})

    expect(names.slice(0, 5)).toEqual(['read', 'write', 'edit', 'glob', 'grep'])
    // bash 每轮现建（描述按当前 shell 算），但它仍属于内置段——排在 MCP 之前
    expect(names).toContain('bash')
    expect(names.filter((name) => !name.startsWith('mcp__'))).toContain('bash')
  })
})
