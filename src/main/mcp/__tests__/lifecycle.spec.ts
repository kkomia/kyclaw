// @vitest-environment node
/**
 * McpLifecycle 单测（T12 Step 3）：用假 client 钉四件事——
 *   1. 启用中的 server 会被连接/发现，工具按 `mcp__<server>__<tool>` 命名并挂上权限 gate；
 *   2. 设置变了（停用/删除/改命令/改 headers 或 env）就换连接：旧连接断开（子进程随之下线）；
 *   3. 崩溃重启 ≤ 2 次、每次记日志，用满就"暂停使用"（工具消失、不再拉起）；一次成功计数清零；
 *   4. stop()（应用退出）断开一切，之后不再重连。
 * 真子进程的起停/崩溃在 mcp.spec.ts 里用真 fixture 钉（这一份只管顺序与计数）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '@mastra/core/tools'
import type { McpServerConfig } from '../../../shared/settings'
import { McpLifecycle, MCP_MAX_RESTARTS, connectionKey, type McpClient } from '../lifecycle'

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
    // 判定走同一个 gate（参数是归一后的全名、模型给的入参，外加审批回调里取到的 session ——
    // round 51 起回调没带上下文时就是 undefined，见 mcp.ts 的 needsApprovalFn 接线）
    expect(tool.needsApprovalFn?.({ message: 'hi' })).toBe(true)
    expect(gate).toHaveBeenCalledWith('mcp__echo__echo', { message: 'hi' }, undefined)

    // round 51：回调带 requestContext（core 摊平后的 MastraMemory）时，线程 id 透传给 gate ——
    // MCP 工具靠它按会话根判"无显式目标"的 full 免审（guard.approvalSessionOf）
    gate.mockClear()
    const approval = { requestContext: { MastraMemory: { thread: { id: 'thread-9' } } } }
    expect(tool.needsApprovalFn?.({ message: 'hi2' }, approval as never)).toBe(true)
    expect(gate).toHaveBeenCalledWith('mcp__echo__echo', { message: 'hi2' }, 'thread-9')

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

  it('createClient 抛错：refresh()/tools() 都不泄 rejection（只记日志），下一轮会重试', async () => {
    const servers = [config()]
    const logs: string[] = []
    let attempts = 0
    let broken = true
    const lifecycle = new McpLifecycle({
      servers: () => servers,
      createClient: async () => {
        attempts += 1
        if (broken) throw new Error('建连接失败：地址半截（http://）')
        return new FakeClient([{ echo: 'ok' }]) as unknown as McpClient
      },
      log: (line) => logs.push(line)
    })

    // 两个入口都 resolve（调用方拿到的是"这轮没有 MCP 工具"，不是异常）
    await expect(lifecycle.refresh()).resolves.toBeUndefined()
    await expect(lifecycle.tools(gateTrue)).resolves.toEqual({})
    expect(logs.some((line) => line.includes('连接对齐失败'))).toBe(true)

    // 下一轮配置修好：照常连上（没卡在"半对齐"态）
    broken = false
    const tools = await lifecycle.tools(gateTrue)
    expect(Object.keys(tools)).toEqual(['mcp__echo__echo'])
    expect(attempts).toBeGreaterThanOrEqual(2)
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

describe('McpLifecycle：鉴权 / 环境变量改了要换连接（round 12，kybase 实锤）', () => {
  /** 用户的形态：HTTP server + Authorization 头（值是假的占位符，不打印真实凭据） */
  const kybase = (patch: Partial<McpServerConfig> = {}): McpServerConfig =>
    config({
      id: 'kybase',
      name: '知识库',
      transport: 'http',
      command: undefined,
      args: undefined,
      url: 'http://192.168.31.18:8765/mcp',
      ...patch
    })

  it('已连接的 http 加/改 headers：refresh() 换连接（旧断、新起、重新发现）', async () => {
    const servers = [kybase()]
    const { lifecycle, client, factories } = bench([{ kybase: 'ok' }], servers)
    expect(Object.keys(await lifecycle.tools(gateTrue))).toEqual(['mcp__kybase__echo'])
    expect(factories()).toBe(1)
    expect(client.disconnects).toBe(0)

    // 用户场景：给已连接的 server 加上 Authorization（或换 token）
    servers[0] = kybase({ headers: { Authorization: 'Bearer test-token' } })
    await lifecycle.refresh()

    expect(factories()).toBe(2)
    expect(client.disconnects).toBe(1)
    expect(client.listCalls).toBe(2)
    expect(Object.keys(await lifecycle.tools(gateTrue))).toEqual(['mcp__kybase__echo'])
  })

  it('headers 内容相同、仅键序不同：指纹不变（refresh 不重连）', async () => {
    const servers = [kybase({ headers: { Authorization: 'Bearer t', 'X-Trace': '1' } })]
    const { lifecycle, client, factories } = bench([{ kybase: 'ok' }], servers)
    await lifecycle.tools(gateTrue)

    servers[0] = kybase({ headers: { 'X-Trace': '1', Authorization: 'Bearer t' } })
    await lifecycle.refresh()

    expect(factories()).toBe(1)
    expect(client.disconnects).toBe(0)
  })

  it('stdio env 变化同样换连接（round 9 引入的 env 也在指纹里）', async () => {
    const servers = [config({ env: { API_KEY: 'old' } })]
    const { lifecycle, client, factories } = bench([{ echo: 'ok' }], servers)
    await lifecycle.tools(gateTrue)
    expect(factories()).toBe(1)

    servers[0] = config({ env: { API_KEY: 'new' } })
    await lifecycle.refresh()

    expect(factories()).toBe(2)
    expect(client.disconnects).toBe(1)
  })
})

describe('connectionKey：只含影响"怎么连"的字段（round 12）', () => {
  const http = (patch: Partial<McpServerConfig> = {}): McpServerConfig =>
    config({
      transport: 'http',
      command: undefined,
      args: undefined,
      url: 'http://127.0.0.1:8765/mcp',
      ...patch
    })

  it('headers / env 的值变化（含从无到有）都改变指纹', () => {
    expect(connectionKey([http()])).not.toBe(
      connectionKey([http({ headers: { Authorization: 'Bearer a' } })])
    )
    expect(connectionKey([http({ headers: { Authorization: 'Bearer a' } })])).not.toBe(
      connectionKey([http({ headers: { Authorization: 'Bearer b' } })])
    )
    expect(connectionKey([config()])).not.toBe(connectionKey([config({ env: { K: 'v' } })]))
    expect(connectionKey([config({ env: { K: 'v1' } })])).not.toBe(
      connectionKey([config({ env: { K: 'v2' } })])
    )
    // 空表与缺省等价（serverDefinition 里都不传，不必重连）
    expect(connectionKey([http({ headers: {} })])).toBe(connectionKey([http()]))
    expect(connectionKey([config({ env: {} })])).toBe(connectionKey([config()]))
  })

  it('键序无关：headers / env 的键换成不同顺序，指纹不变', () => {
    expect(connectionKey([http({ headers: { 'X-Trace': '1', Authorization: 'Bearer t' } })])).toBe(
      connectionKey([http({ headers: { Authorization: 'Bearer t', 'X-Trace': '1' } })])
    )
    expect(connectionKey([config({ env: { B: '2', A: '1' } })])).toBe(
      connectionKey([config({ env: { A: '1', B: '2' } })])
    )
  })

  it('不影响连接的字段不进指纹：name / readOnlyTools / enabled', () => {
    expect(connectionKey([config({ name: '甲' })])).toBe(connectionKey([config({ name: '乙' })]))
    expect(connectionKey([config({ readOnlyTools: ['echo'] })])).toBe(
      connectionKey([config({ readOnlyTools: [] })])
    )
    expect(connectionKey([config({ enabled: false })])).toBe(connectionKey([config()]))
  })
})

describe('McpLifecycle：发现不拖对话（round 54，等待预算 + 后台继续）', () => {
  type ToolsetsResult = Awaited<ReturnType<McpClient['listToolsetsWithErrors']>>

  /** 慢失败 client：每次发现都拖 delayMs 后才报"连不上"（复刻不可达 HTTP server 的 28.6s，压到毫秒级） */
  class SlowFailClient {
    listCalls = 0
    readonly reconnects: string[] = []
    disconnects = 0

    constructor(private readonly delayMs: number) {}

    async listToolsetsWithErrors(): Promise<ToolsetsResult> {
      this.listCalls += 1
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      return {
        toolsets: {},
        errors: { echo: '一直连不上' },
        errorDetails: { echo: { code: 'CONNECTION_CLOSED', message: '一直连不上' } }
      }
    }

    async reconnectServer(name: string): Promise<void> {
      this.reconnects.push(name)
    }

    async disconnect(): Promise<void> {
      this.disconnects += 1
    }
  }

  /** 闸门 client：发现挂起，由测试放行（模拟"慢但活着"的 server） */
  class GatedClient {
    listCalls = 0
    readonly gates: Array<(value: ToolsetsResult) => void> = []

    async listToolsetsWithErrors(): Promise<ToolsetsResult> {
      this.listCalls += 1
      return await new Promise<ToolsetsResult>((resolve) => {
        this.gates.push(resolve)
      })
    }

    async reconnectServer(): Promise<void> {
      /* 闸门用例的重连是空操作 */
    }

    async disconnect(): Promise<void> {
      /* 闸门用例的断开是空操作 */
    }
  }

  it('发现慢于预算：tools() 先交现状（不等挂起的发现）；后台放行后下一轮带上工具，且不重复发现', async () => {
    const client = new GatedClient()
    const lifecycle = new McpLifecycle({
      servers: () => [config()],
      createClient: async () => client as unknown as McpClient,
      log: () => {},
      discoveryBudgetMs: 30
    })

    const started = Date.now()
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(25) // 等过预算
    expect(waited).toBeLessThan(500) // 但没等挂起的发现
    expect(client.gates).toHaveLength(1)

    // 同一轮第二次问（Mastra 的 prepare-tools）：剩余预算归零 → 立即返回，不再等
    const again = Date.now()
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    expect(Date.now() - again).toBeLessThan(100)

    // refresh 也走同一条预算语义（此刻任务在飞、预算已用完 → 立即回来）
    const refreshAt = Date.now()
    await lifecycle.refresh()
    expect(Date.now() - refreshAt).toBeLessThan(100)

    // 放行：后台把发现做完，下一轮拿到工具；发现只发生过一次
    client.gates[0]({ toolsets: { echo: { echo: makeTool() } }, errors: {}, errorDetails: {} })
    await vi.waitFor(
      async () => {
        const tools = await lifecycle.tools(gateTrue)
        expect(Object.keys(tools)).toEqual(['mcp__echo__echo'])
      },
      { timeout: 3000, interval: 25 }
    )
    expect(client.listCalls).toBe(1)
  })

  it('发现失败循环转后台：预算内先返回；后台照常走满重启并暂停，之后不再拉起', async () => {
    const client = new SlowFailClient(300)
    const logs: string[] = []
    const lifecycle = new McpLifecycle({
      servers: () => [config()],
      createClient: async () => client as unknown as McpClient,
      log: (line) => logs.push(line),
      discoveryBudgetMs: 40
    })

    const started = Date.now()
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(30)
    expect(waited).toBeLessThan(250) // 一次 300ms 的尝试都没等到，更别说整轮三次
    expect(client.listCalls).toBe(1)

    // 后台继续：三次尝试（初始 + 重启 2 次）都失败后暂停使用
    await vi.waitFor(() => expect(client.listCalls).toBe(3), { timeout: 5000, interval: 50 })
    await vi.waitFor(() => expect(logs.some((line) => line.includes('暂停使用'))).toBe(true), {
      timeout: 3000,
      interval: 25
    })
    expect(client.reconnects).toEqual(['echo', 'echo'])

    // 暂停后：下一轮立即返回（不再等、也不再发起发现）
    const after = Date.now()
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    expect(Date.now() - after).toBeLessThan(100)
    expect(client.listCalls).toBe(3)
  })
})

describe('McpLifecycle：未启用的 server 不连接也不注入（round 71）', () => {
  it('createClient 只拿到启用的那条：停用的 server 连连接配置都不进，工具表里也没有它', async () => {
    const servers = [config(), config({ id: 'off', name: '停用的', enabled: false })]
    const seen: string[][] = []
    const client = new FakeClient([{ echo: 'ok' }])
    const lifecycle = new McpLifecycle({
      servers: () => servers,
      createClient: async (configs) => {
        seen.push(configs.map((candidate) => candidate.id))
        return client as unknown as McpClient
      },
      log: () => {}
    })

    const tools = await lifecycle.tools(gateTrue)

    // ① 连接：只把启用的交给 MCPClient（停用的那条不会起子进程 / 不会发请求）
    expect(seen).toEqual([['echo']])
    // ② 注入：工具表里一处 `mcp__off__` 都没有（工具定义不进模型请求 = 省 token）
    expect(Object.keys(tools)).toEqual(['mcp__echo__echo'])
    expect(lifecycle.enabled().map((server) => server.id)).toEqual(['echo'])
  })

  it('开关切一下就换连接，且下一轮 tools() 就生效（不必重启）', async () => {
    const servers = [config(), config({ id: 'off', name: '停用的', enabled: false })]
    const seen: string[][] = []
    const client = new FakeClient([{ echo: 'ok', off: 'ok' }])
    const lifecycle = new McpLifecycle({
      servers: () => servers,
      createClient: async (configs) => {
        seen.push(configs.map((candidate) => candidate.id))
        return client as unknown as McpClient
      },
      log: () => {}
    })

    expect(Object.keys(await lifecycle.tools(gateTrue))).toEqual(['mcp__echo__echo'])

    // 用户把两个开关同时翻过来：启用 off、停用 echo
    servers[0] = config({ enabled: false })
    servers[1] = config({ id: 'off', name: '停用的' })

    // 下一轮就按新设置重连（旧连接断开 = 停用那条的子进程下线）
    expect(lifecycle.enabled().map((server) => server.id)).toEqual(['off'])
    expect(Object.keys(await lifecycle.tools(gateTrue))).toEqual(['mcp__off__echo'])
    expect(seen).toEqual([['echo'], ['off']])
    expect(client.disconnects).toBe(1)
  })

  it('statusOf：未启用 / 连接中 / 就绪 / 暂停 四态互不混同（边界①）', async () => {
    const servers = [config(), config({ id: 'off', name: '停用的', enabled: false })]
    const { lifecycle } = bench([{ echo: 'ok' }], servers)
    await lifecycle.tools(gateTrue)

    expect(lifecycle.statusOf('echo')).toBe('ready')
    // 未启用 = 用户自己关的（连都没连）；与"连接失败"不是一件事
    expect(lifecycle.statusOf('off')).toBe('disabled')
    expect(lifecycle.statusOf('不存在的 id')).toBe('disabled')

    // 启用但连续起不来 = paused（另一种"没有工具"：日志里写着原因，状态与 disabled 分开）
    const broken = bench([{ echo: { code: 'CONNECTION_CLOSED', message: '一直起不来' } }])
    expect(await broken.lifecycle.tools(gateTrue)).toEqual({})
    expect(broken.lifecycle.statusOf('echo')).toBe('paused')
    expect(broken.logs.some((line) => line.includes('暂停使用'))).toBe(true)
  })

  it('刚启用还没发现完：留一条"正在连接中"的日志 + statusOf=connecting（不是静默失败，边界②）', async () => {
    type ToolsetsResult = Awaited<ReturnType<McpClient['listToolsetsWithErrors']>>
    /** 闸门 client：发现挂起，由测试放行（模拟冷启动/慢服务超过本轮预算） */
    class GatedClient {
      readonly gates: Array<(value: ToolsetsResult) => void> = []
      async listToolsetsWithErrors(): Promise<ToolsetsResult> {
        return await new Promise<ToolsetsResult>((resolve) => this.gates.push(resolve))
      }
      async reconnectServer(): Promise<void> {
        /* 闸门用例：重连是空操作 */
      }
      async disconnect(): Promise<void> {
        /* 闸门用例：断开是空操作 */
      }
    }

    const client = new GatedClient()
    const logs: string[] = []
    const lifecycle = new McpLifecycle({
      servers: () => [config()],
      createClient: async () => client as unknown as McpClient,
      log: (line) => logs.push(line),
      discoveryBudgetMs: 20
    })

    // 这一轮：工具表空着，但状态与日志都能说清"为什么"——不是静默地什么都没有
    expect(await lifecycle.tools(gateTrue)).toEqual({})
    expect(lifecycle.statusOf('echo')).toBe('connecting')
    expect(logs.some((line) => line.includes('正在连接中'))).toBe(true)

    // 同一轮里 Mastra 会再问一次工具：不重复刷日志
    await lifecycle.tools(gateTrue)
    expect(logs.filter((line) => line.includes('正在连接中'))).toHaveLength(1)

    // 后台发现回来：工具按约出现（下一轮），状态转 ready
    client.gates[0]({ toolsets: { echo: { echo: makeTool() } }, errors: {}, errorDetails: {} })
    await vi.waitFor(async () => {
      expect(Object.keys(await lifecycle.tools(gateTrue))).toEqual(['mcp__echo__echo'])
    })
    expect(lifecycle.statusOf('echo')).toBe('ready')
  })
})
