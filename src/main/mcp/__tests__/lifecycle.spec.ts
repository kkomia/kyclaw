// @vitest-environment node
/**
 * McpLifecycle 单测（T12 Step 3）：用假 client 钉四件事——
 *   1. 启用中的 server 会被连接/发现，工具按 `mcp__<server>__<tool>` 命名并挂上权限 gate；
 *   2. 设置变了（停用/删除/改命令）就换连接：旧连接断开（子进程随之下线）；
 *   3. 崩溃重启 ≤ 2 次、每次记日志，用满就"暂停使用"（工具消失、不再拉起）；一次成功计数清零；
 *   4. stop()（应用退出）断开一切，之后不再重连。
 * 真子进程的起停/崩溃在 mcp.spec.ts 里用真 fixture 钉（这一份只管顺序与计数）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '@mastra/core/tools'
import type { McpServerConfig } from '../../../shared/settings'
import { McpLifecycle, MCP_MAX_RESTARTS, type McpClient } from '../lifecycle'

type DiscoveryStep = Record<string, 'ok' | { code: string; message: string }>

function makeTool(execute?: (input: unknown, context: unknown) => Promise<unknown>): Tool {
  return {
    id: 'raw-name',
    description: '测试工具',
    requireApproval: false,
    ...(execute === undefined ? {} : { execute })
  } as unknown as Tool
}

/** 假 client：按脚本回放每一轮发现；记录 reconnect / disconnect */
class FakeClient {
  listCalls = 0
  readonly reconnects: string[] = []
  disconnects = 0
  readonly tools: Record<string, Tool>

  constructor(
    private readonly steps: DiscoveryStep[],
    tools?: Record<string, Tool>
  ) {
    this.tools = tools ?? { echo: makeTool() }
  }

  async listToolsetsWithErrors(): Promise<{
    toolsets: Record<string, Record<string, Tool>>
    errors: Record<string, string>
    errorDetails: Record<string, { code: string; message: string }>
  }> {
    this.listCalls += 1
    // 脚本用完后重复最后一步（"一直起不来"的用例只给一步）
    const step = this.steps.length > 1 ? this.steps.shift()! : this.steps[0]
    const toolsets: Record<string, Record<string, Tool>> = {}
    const errors: Record<string, string> = {}
    const errorDetails: Record<string, { code: string; message: string }> = {}
    for (const [id, result] of Object.entries(step)) {
      if (result === 'ok') toolsets[id] = this.tools
      else {
        errors[id] = result.message
        errorDetails[id] = result
      }
    }
    return { toolsets, errors, errorDetails }
  }

  async reconnectServer(name: string): Promise<void> {
    this.reconnects.push(name)
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1
  }
}

function config(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'echo',
    name: '回显服务',
    transport: 'stdio',
    command: 'node',
    args: ['echo.mjs'],
    enabled: true,
    readOnlyTools: [],
    ...patch
  }
}

/** 一个"设置可变"的生命周期 + 它造出的假 client（全部记录拿在手里断言） */
function bench(
  steps: DiscoveryStep[],
  servers: McpServerConfig[] = [config()],
  tools?: Record<string, Tool>
): { lifecycle: McpLifecycle; client: FakeClient; logs: string[]; factories: () => number } {
  const client = new FakeClient(steps, tools)
  const logs: string[] = []
  let created = 0
  const lifecycle = new McpLifecycle({
    servers: () => servers,
    createClient: async () => {
      created += 1
      return client as unknown as McpClient
    },
    log: (line) => logs.push(line)
  })
  return { lifecycle, client, logs, factories: () => created }
}

const gateTrue = (): boolean => true

/** 调工具（单元用不到真实执行上下文；supervise 包装也不看 context） */
async function callTool(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: (input: unknown, context: unknown) => Promise<unknown> })
    .execute
  if (execute === undefined) throw new Error('工具没有 execute')
  return await execute.call(tool, input, {})
}

describe('McpLifecycle：连接、命名与 gate', () => {
  it('发现成功的 server：工具命名 mcp__<server>__<tool>，requireApproval 挂到 gate 上', async () => {
    const { lifecycle, client, factories } = bench([{ echo: 'ok' }])
    const gate = vi.fn(() => true)

    const tools = await lifecycle.tools(gate)

    expect(Object.keys(tools)).toEqual(['mcp__echo__echo'])
    expect(factories()).toBe(1)
    expect(client.listCalls).toBe(1)

    const tool = tools['mcp__echo__echo']
    expect(tool.requireApproval).toBe(true)
    // 判定走同一个 gate（参数是归一后的全名与模型给的入参）
    expect(tool.needsApprovalFn?.({ message: 'hi' })).toBe(true)
    expect(gate).toHaveBeenCalledWith('mcp__echo__echo', { message: 'hi' })

    // 设置没变：不重复发现，工具表还是那份
    const again = await lifecycle.tools(gateTrue)
    expect(client.listCalls).toBe(1)
    expect(Object.keys(again)).toEqual(['mcp__echo__echo'])
  })

  it('停用 server：旧连接断开（子进程随之下线），工具消失；再启用会重新建立', async () => {
    const servers = [config()]
    const { lifecycle, client, factories } = bench([{ echo: 'ok' }], servers)

    expect(Object.keys(await lifecycle.tools(gateTrue))).toEqual(['mcp__echo__echo'])

    servers[0] = config({ enabled: false })
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    expect(client.disconnects).toBe(1)

    servers[0] = config({ enabled: true })
    expect(Object.keys(await lifecycle.tools(gateTrue))).toEqual(['mcp__echo__echo'])
    expect(factories()).toBe(2)
  })

  it('stop()：断开连接、清空工具表，之后不再建连接', async () => {
    const { lifecycle, client, factories } = bench([{ echo: 'ok' }])
    await lifecycle.tools(gateTrue)

    await lifecycle.stop()

    expect(client.disconnects).toBe(1)
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    expect(factories()).toBe(1)
  })

  it('refresh()：设置改完立刻对齐（停用即断开、再启用即重连），不必等下一次对话', async () => {
    const servers = [config()]
    const { lifecycle, client, factories } = bench([{ echo: 'ok' }], servers)
    await lifecycle.tools(gateTrue)
    expect(client.disconnects).toBe(0)

    servers[0] = config({ enabled: false })
    await lifecycle.refresh()
    expect(client.disconnects).toBe(1)

    // 配置没变时是空操作（不会多余地重连）
    await lifecycle.refresh()
    expect(client.disconnects).toBe(1)

    servers[0] = config({ enabled: true })
    await lifecycle.refresh()
    expect(factories()).toBe(2)
  })
})

describe('McpLifecycle：崩溃重启（≤2 次，记日志）', () => {
  it('发现失败 → 记一次重启与日志、重连；下一轮成功 → 计数清零', async () => {
    const { lifecycle, client, logs } = bench([
      { echo: { code: 'CONNECTION_CLOSED', message: '服务进程没了' } },
      { echo: 'ok' }
    ])

    const tools = await lifecycle.tools(gateTrue)

    expect(Object.keys(tools)).toEqual(['mcp__echo__echo'])
    expect(client.reconnects).toEqual(['echo'])
    expect(logs.some((line) => line.includes('重启（第 1/2 次）'))).toBe(true)
    expect(logs.some((line) => line.includes('暂停使用'))).toBe(false)
    expect(lifecycle.restartsOf('echo')).toBe(0)
  })

  it('连续失败用满 2 次：只重启两次，之后暂停使用（工具消失、不再拉起）', async () => {
    const { lifecycle, client, logs } = bench([
      { echo: { code: 'CONNECTION_CLOSED', message: '一直起不来' } }
    ])

    const tools = await lifecycle.tools(gateTrue)

    expect(tools).toEqual({})
    expect(client.reconnects).toEqual(['echo', 'echo'])
    expect(logs.filter((line) => line.includes('重启（第'))).toHaveLength(MCP_MAX_RESTARTS)
    expect(logs.some((line) => line.includes('第 2/2 次'))).toBe(true)
    expect(logs.some((line) => line.includes('暂停使用'))).toBe(true)
    expect(lifecycle.restartsOf('echo')).toBe(MCP_MAX_RESTARTS)

    // 暂停后不再反复发现
    const listCallsAtPause = client.listCalls
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    expect(client.listCalls).toBe(listCallsAtPause)
  })

  it('调用报连接类错误（子进程死在调用中间）→ 计一次重启并重连；业务错误不计', async () => {
    const business = makeTool(async () => {
      throw new Error('远端拒绝了这次调用')
    })
    const broken = makeTool(async () => {
      throw new Error('Failed to connect: Connection closed')
    })
    const { lifecycle, client, logs } = bench([{ echo: 'ok' }], [config()], {
      echo: broken,
      'echo.business': business
    })

    const tools = await lifecycle.tools(gateTrue)
    await expect(callTool(tools['mcp__echo__echo'], {})).rejects.toThrow('Connection closed')

    expect(client.reconnects).toEqual(['echo'])
    expect(logs.some((line) => line.includes('调用中断，重启（第 1/2 次）'))).toBe(true)

    await expect(callTool(tools['mcp__echo__echo.business'], {})).rejects.toThrow('远端拒绝')
    expect(client.reconnects).toEqual(['echo'])
  })
})
