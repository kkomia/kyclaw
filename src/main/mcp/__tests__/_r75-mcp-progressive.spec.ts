// @vitest-environment node
/**
 * R75：MCP **渐进披露** —— 大 server 的工具不再逐件进请求前缀，换成每 server 一个元工具
 * （`mcp__<serverId>__meta`：`action:"list"` 拿清单、`action:"call"` 真调用）。
 *
 * 钉住四件事（用户口径的硬要求）：
 *   1. **大 server 换元工具、小 server 仍直接注入**（阈值 `MCP_INLINE_TOOL_THRESHOLD`，可调）；
 *      真工具恰好叫 `meta` 时不夺名（退回逐件）；
 *   2. **审批语义原样**：`call` 按**真实工具名 + 真实入参**过 gate —— 读/写/危险三档、
 *      工作区 full 免审、"永久允许"规则、危险命令红线，与逐件注入时逐字同一条路；
 *      `list` 零副作用、只读免问；
 *   3. **元工具的 list / call 真的能用**（真 stdio 子进程 fixtures/mcp-echo-server.mjs）：
 *      参数校验失败回文本不抛、未知工具名回文本；结果走真工具的 execute（所以结果护栏与
 *      生命周期崩溃监督都在）；
 *   4. **不双记崩溃**：渐进披露在"挂崩溃监督之后"做 —— 一次调用中断只记一次重启。
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Tool } from '@mastra/core/tools'
import { McpLifecycle } from '../lifecycle'
import {
  buildMcpToolTable,
  collectMcpTools,
  createMcpClassify,
  MCP_INLINE_TOOL_THRESHOLD,
  mcpMetaToolName,
  type McpToolGate
} from '../../../mastra/mcp'
import { createToolContext, needsApproval } from '../../../mastra/tools/guard'
import type { McpServerConfig, Workspace } from '../../../shared/settings'

const FIXTURE = join(process.cwd(), 'fixtures', 'mcp-echo-server.mjs')

function stdioConfig(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'echo',
    name: '回显服务',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    enabled: true,
    readOnlyTools: [],
    ...patch
  }
}

/** 最小 JSON Schema wrapper：形状与 @mastra/mcp 的 JsonSchemaWrapper 一致（~standard + jsonSchema.input） */
function schemaOf(jsonSchema: Record<string, unknown>): unknown {
  return {
    '~standard': {
      version: 1,
      vendor: 'r75-test',
      validate: (value: unknown) => {
        const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : []
        const record = (value ?? {}) as Record<string, unknown>
        const issues = required
          .filter((key) => !(key in record))
          .map((key) => ({ path: [key], message: `缺少必填参数 ${String(key)}` }))
        return issues.length === 0 ? { value } : { issues }
      },
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema }
    }
  }
}

interface StubTool {
  /** 服务端给的工具名（工具表里的键就是它） */
  name: string
  id: string
  description: string
  inputSchema: unknown
  execute: (input: unknown) => Promise<unknown>
}

/** 一件"像 @mastra/mcp 造出来的"MCP 工具（纯桩；调用记在 calls 里） */
function stubTool(
  name: string,
  options: {
    description?: string
    parameters?: Record<string, unknown>
    calls?: unknown[]
  } = {}
): StubTool {
  return {
    name,
    id: `echo_${name}`,
    description: options.description ?? '',
    inputSchema: schemaOf(options.parameters ?? { type: 'object', properties: {} }),
    execute: async (input: unknown) => {
      options.calls?.push(input)
      return `ok:${name}`
    }
  }
}

/** toolsets 的键 = 服务端给的工具名（与 @mastra/mcp 的 listToolsets 一致；Tool.id 是 `server_tool`） */
function toolsetsOf(serverId: string, tools: StubTool[]): Record<string, Record<string, Tool>> {
  return {
    [serverId]: Object.fromEntries(tools.map((tool) => [tool.name, tool as unknown as Tool]))
  }
}

const NO_APPROVAL = (): boolean => false

async function callTool(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: (input: unknown, context: unknown) => Promise<unknown> })
    .execute
  if (execute === undefined) throw new Error('工具没有 execute')
  return await execute.call(tool, input, { agent: { threadId: 'r75' } })
}

/** 元工具的真实审批判定（走生产那条路：core 读 needsApprovalFn） */
function approvalOf(tool: unknown, input: unknown, approval?: unknown): unknown {
  const fn = (tool as { needsApprovalFn?: (input: unknown, approval?: unknown) => unknown })
    .needsApprovalFn
  if (fn === undefined) throw new Error('元工具没挂 needsApprovalFn')
  return fn(input, approval)
}

/** 真 gate：guard.needsApproval + MCP 分级（与生产装配同一份实现） */
function realGate(servers: readonly McpServerConfig[], roots: readonly Workspace[]) {
  const ctx = createToolContext({
    roots,
    classify: createMcpClassify(() => servers),
    permissionRules: () => []
  })
  return (tool: string, input: unknown, session?: string): boolean =>
    needsApproval(ctx, tool, input, session)
}

describe('R75 渐进披露：大 server 换元工具，小 server 直接注入', () => {
  const fourTools = [
    stubTool('echo', { description: '原样回显 message' }),
    stubTool('write_remote', { description: '远端写入' }),
    stubTool('fail', { description: '总是回错误' }),
    stubTool('crash', { description: '退出进程' })
  ]

  it('4 件（> 阈值 3）→ 工具表里只有元工具；描述点名 server 与它的工具名', async () => {
    const collected = collectMcpTools({
      toolsets: toolsetsOf('echo', fourTools),
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    expect(Object.keys(collected).sort()).toEqual([
      'mcp__echo__crash',
      'mcp__echo__echo',
      'mcp__echo__fail',
      'mcp__echo__write_remote'
    ])

    const table = await buildMcpToolTable({
      collected,
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    expect(Object.keys(table)).toEqual([mcpMetaToolName('echo')])

    const description = String(table[mcpMetaToolName('echo')].description ?? '')
    expect(description).toContain('回显服务')
    for (const name of ['echo', 'write_remote', 'fail', 'crash']) {
      expect(description).toContain(name)
    }
    // 不许让模型以为"没有 MCP 工具"：描述要说清这是入口、别的 server 同样有这个入口
    expect(description).toContain('action:"list"')
    expect(description).toContain('Every MCP server on this machine')
  })

  it('2 件（≤ 阈值）→ 逐件注入，一个元工具都不出（小 server 的两次往返更贵）', async () => {
    const tools = [stubTool('echo'), stubTool('write_remote')]
    const collected = collectMcpTools({
      toolsets: toolsetsOf('echo', tools),
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    const table = await buildMcpToolTable({
      collected,
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    expect(Object.keys(table).sort()).toEqual(['mcp__echo__echo', 'mcp__echo__write_remote'])
  })

  it('阈值可调：调高逐件、调到 0 连一件也走元工具', async () => {
    const tools = [stubTool('echo'), stubTool('write_remote')]
    const collected = collectMcpTools({
      toolsets: toolsetsOf('echo', tools),
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })

    const widened = await buildMcpToolTable({
      collected,
      servers: [stdioConfig()],
      gate: NO_APPROVAL,
      threshold: 5
    })
    expect(Object.keys(widened).sort()).toEqual(['mcp__echo__echo', 'mcp__echo__write_remote'])

    const narrow = await buildMcpToolTable({
      collected: collectMcpTools({
        toolsets: toolsetsOf('echo', [stubTool('echo')]),
        servers: [stdioConfig()],
        gate: NO_APPROVAL
      }),
      servers: [stdioConfig()],
      gate: NO_APPROVAL,
      threshold: 0
    })
    expect(Object.keys(narrow)).toEqual([mcpMetaToolName('echo')])
    expect(MCP_INLINE_TOOL_THRESHOLD).toBe(3)
  })

  it('真工具恰好叫 meta：不夺名，这个 server 退回逐件注入', async () => {
    const tools = [stubTool('meta'), stubTool('a'), stubTool('b'), stubTool('c')]
    const collected = collectMcpTools({
      toolsets: toolsetsOf('echo', tools),
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    const table = await buildMcpToolTable({
      collected,
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    expect(Object.keys(table).sort()).toEqual([
      'mcp__echo__a',
      'mcp__echo__b',
      'mcp__echo__c',
      'mcp__echo__meta'
    ])
    expect(table['mcp__echo__meta'].description).toBe('')
  })

  it('停用的 server 一个字节都不进（元工具也不给它造）', async () => {
    const collected = collectMcpTools({
      toolsets: toolsetsOf('echo', fourTools),
      servers: [stdioConfig()],
      gate: NO_APPROVAL
    })
    const table = await buildMcpToolTable({
      collected,
      servers: [stdioConfig({ enabled: false })],
      gate: NO_APPROVAL
    })
    expect(table).toEqual({})
  })
})

describe('R75 元工具：list / call 的形状与审批档', () => {
  // 工作区必须**真实存在**：guard 的目标解析走引擎（realpath），路径不存在时 "a.txt" 解析不出去，
  // 会掉进"无显式目标"那条分支，就测不出"按路径绑工作区"的 full 免审与规则命中
  const wsDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kyclaw-r75-ws-')))
  const workspaceAsk: Workspace = { path: wsDir, mode: 'ask' }
  const workspaceFull: Workspace = { path: wsDir, mode: 'full' }

  afterAll(() => {
    rmSync(wsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  async function build(
    servers: McpServerConfig[],
    tools: StubTool[],
    gate: McpToolGate = NO_APPROVAL
  ): Promise<Record<string, Tool>> {
    const collected = collectMcpTools({
      toolsets: toolsetsOf('echo', tools),
      servers,
      gate
    })
    return await buildMcpToolTable({ collected, servers, gate })
  }

  it('list：每件工具一行「名字(参数) [档] — 一行说明」，正文里给调用写法', async () => {
    const servers = [stdioConfig({ readOnlyTools: ['echo'] })]
    const table = await build(servers, [
      stubTool('echo', {
        description: '原样回显 message',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message']
        }
      }),
      stubTool('write_remote', {
        description: '远端写入（测试用替身）',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['path']
        }
      }),
      stubTool('fail'),
      stubTool('crash')
    ])

    const text = String(await callTool(table[mcpMetaToolName('echo')], { action: 'list' }))
    expect(text).toContain('回显服务')
    expect(text).toContain('- echo(message: string) [只读] — 原样回显 message')
    expect(text).toContain('- write_remote(path: string, tags?: string[]) [需批准]')
    expect(text).toContain('{"action":"call","tool":"<上面的名字>","args":{…}}')
  })

  it('call：真调到那件工具的 execute（入参原样进去），结果原样回来', async () => {
    const calls: unknown[] = []
    const servers = [stdioConfig({ readOnlyTools: ['echo'] })]
    const table = await build(servers, [
      stubTool('echo', { calls }),
      stubTool('write_remote'),
      stubTool('fail'),
      stubTool('crash')
    ])
    const meta = table[mcpMetaToolName('echo')]

    const output = await callTool(meta, {
      action: 'call',
      tool: 'echo',
      args: { message: '你好' }
    })
    expect(output).toBe('ok:echo')
    expect(calls).toEqual([{ message: '你好' }])
  })

  it('call 的审批档与逐件注入逐字一致：只读放行 / 未标询问 / 危险名永远问', async () => {
    const calls: unknown[] = []
    const servers = [stdioConfig({ readOnlyTools: ['echo'] })]
    const gate = realGate(servers, [workspaceAsk])
    const table = await build(
      servers,
      [
        stubTool('echo', { calls }),
        stubTool('write_remote', { calls }),
        stubTool('delete', { calls }),
        stubTool('helper', { calls })
      ],
      gate
    )
    const meta = table[mcpMetaToolName('echo')]

    // ① 只读（用户勾了"只读"）→ 免审
    expect(approvalOf(meta, { action: 'call', tool: 'echo', args: { message: 'x' } })).toBe(false)
    // ② 未标只读 → 走 gate：ask 工作区、没有规则 → 问
    expect(
      approvalOf(meta, { action: 'call', tool: 'write_remote', args: { path: 'a.txt' } })
    ).toBe(true)
    // ③ 末段 delete/move → 危险档，永远问
    expect(approvalOf(meta, { action: 'call', tool: 'delete', args: { path: 'a.txt' } })).toBe(true)
    // ④ list 零副作用：不问
    expect(approvalOf(meta, { action: 'list' })).toBe(false)
    // ⑤ 名字不存在：没有副作用可发生，不弹卡（execute 只会回一句人话）
    expect(approvalOf(meta, { action: 'call', tool: 'nope', args: {} })).toBe(false)

    // 逐件注入的同一份 gate 逐条对齐（对照：不是"元工具版"另一套口径）
    expect(gate('mcp__echo__echo', { message: 'x' })).toBe(false)
    expect(gate('mcp__echo__write_remote', { path: 'a.txt' })).toBe(true)
    expect(gate('mcp__echo__delete', { path: 'a.txt' })).toBe(true)
  })

  it('call 走的是 gate 的真实入口：工作区 full 免审 + "永久允许"规则按真实工具名命中', async () => {
    const servers = [stdioConfig()]
    const tools = [
      stubTool('write_remote'),
      stubTool('helper'),
      stubTool('fail'),
      stubTool('crash')
    ]

    // ① full 工作区：未标只读也不问（round 36 口径原样过元工具）
    const full = await build(servers, tools, realGate(servers, [workspaceFull]))
    expect(
      approvalOf(full[mcpMetaToolName('echo')], {
        action: 'call',
        tool: 'write_remote',
        args: { path: 'a.txt' }
      })
    ).toBe(false)

    // ② ask 工作区 + 一条按**真实工具名**落下的"永久允许"规则 → 免审
    const ctx = createToolContext({
      roots: [workspaceAsk],
      classify: createMcpClassify(() => servers),
      permissionRules: () => [
        { tool: 'mcp__echo__write_remote', workspace: workspaceAsk.path, mode: 'allow' }
      ]
    })
    const gate = (tool: string, input: unknown, session?: string): boolean =>
      needsApproval(ctx, tool, input, session)
    const ruled = await build(servers, tools, gate)
    expect(
      approvalOf(ruled[mcpMetaToolName('echo')], {
        action: 'call',
        tool: 'write_remote',
        args: { path: 'a.txt' }
      })
    ).toBe(false)
    // 同一份设置下、别的工具照旧问（规则是"工具 × 工作区"，不是"server × 工作区"）
    expect(
      approvalOf(ruled[mcpMetaToolName('echo')], { action: 'call', tool: 'helper', args: {} })
    ).toBe(true)
  })

  it('call 会把线程 id 透传给 gate（round 46 的会话根判定不丢）', async () => {
    const seen: Array<string | undefined> = []
    const servers = [stdioConfig()]
    const gate = (_tool: string, _input: unknown, session?: string): boolean => {
      seen.push(session)
      return false
    }
    const table = await build(
      servers,
      [stubTool('echo'), stubTool('a'), stubTool('b'), stubTool('c')],
      gate
    )
    approvalOf(
      table[mcpMetaToolName('echo')],
      { action: 'call', tool: 'echo', args: {} },
      {
        requestContext: { MastraMemory: { thread: { id: 't-9' } } }
      }
    )
    expect(seen).toEqual(['t-9'])
  })

  it('参数校验失败：回文本不抛，且真工具**一次都没被调用**（服务端用真实 schema 校验）', async () => {
    const calls: unknown[] = []
    const servers = [stdioConfig()]
    const table = await build(servers, [
      stubTool('echo', {
        calls,
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message']
        }
      }),
      stubTool('a'),
      stubTool('b'),
      stubTool('c')
    ])

    const text = String(
      await callTool(table[mcpMetaToolName('echo')], { action: 'call', tool: 'echo', args: {} })
    )
    expect(text).toContain('参数没通过校验')
    expect(text).toContain('工具没有被调用')
    expect(text).toContain('/message')
    expect(text).toContain('缺少必填参数 message')
    expect(text).toContain('message: string')
    expect(calls).toEqual([])
  })

  it('未知工具名 / args 写成字符串：都回人话，不抛', async () => {
    const calls: unknown[] = []
    const servers = [stdioConfig()]
    const table = await build(servers, [
      stubTool('echo', { calls }),
      stubTool('a'),
      stubTool('b'),
      stubTool('c')
    ])
    const meta = table[mcpMetaToolName('echo')]

    const missing = String(await callTool(meta, { action: 'call', tool: 'nope', args: {} }))
    expect(missing).toContain('没有叫「nope」的工具')
    expect(missing).toContain('echo')

    // args 被写成 JSON 字符串（模型常见的另一种写法）：归一后照常调用
    const output = await callTool(meta, {
      action: 'call',
      tool: 'echo',
      args: '{"message":"字符串入参"}'
    })
    expect(output).toBe('ok:echo')
    expect(calls).toEqual([{ message: '字符串入参' }])
  })
})

describe('R75 渐进披露：真 stdio 子进程（fixtures/mcp-echo-server.mjs）', () => {
  it('lifecycle 出的工具表是元工具；list 给全四件、call 真跑通子进程', async () => {
    const servers = [stdioConfig()]
    const lifecycle = new McpLifecycle({
      servers: () => servers,
      timeoutMs: 10_000
    })
    try {
      const gate = realGate(servers, [])
      const table = await lifecycle.tools(gate)
      expect(Object.keys(table)).toEqual([mcpMetaToolName('echo')])

      const meta = table[mcpMetaToolName('echo')]
      const list = String(await callTool(meta, { action: 'list' }))
      for (const name of ['echo', 'write_remote', 'fail', 'crash']) expect(list).toContain(name)
      expect(list).toContain('message: string')
      expect(list).toContain('[只读]')
      expect(list).toContain('[需批准]')

      const output = await callTool(meta, {
        action: 'call',
        tool: 'echo',
        args: { message: '你好 MCP' }
      })
      expect(JSON.stringify(output)).toContain('echo: 你好 MCP')
    } finally {
      await lifecycle.stop()
    }
  }, 60_000)

  it('call 的审批按真实工具名：勾了只读的 echo 免问，write_remote 在 ask 工作区照问', async () => {
    const servers = [stdioConfig({ readOnlyTools: ['echo'] })]
    const lifecycle = new McpLifecycle({ servers: () => servers, timeoutMs: 10_000 })
    const workspace: Workspace = { path: 'D:/ws', mode: 'ask' }
    try {
      const table = await lifecycle.tools(realGate(servers, [workspace]))
      const meta = table[mcpMetaToolName('echo')]
      expect(approvalOf(meta, { action: 'call', tool: 'echo', args: { message: 'x' } })).toBe(false)
      expect(approvalOf(meta, { action: 'call', tool: 'write_remote', args: { path: 'x' } })).toBe(
        true
      )
    } finally {
      await lifecycle.stop()
    }
  }, 60_000)

  it('不双记崩溃：调 crash 杀掉子进程后，下一次调用只记一次重启（监督没被套两层）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-r75-crash-'))
    const stateFile = join(dir, 'broken')
    const servers = [stdioConfig({ args: [FIXTURE, `--state-file=${stateFile}`] })]
    const lifecycle = new McpLifecycle({ servers: () => servers, timeoutMs: 5000 })
    try {
      const table = await lifecycle.tools(realGate(servers, []))
      const meta = table[mcpMetaToolName('echo')]
      expect(table[mcpMetaToolName('echo')]).toBeDefined()

      await callTool(meta, { action: 'call', tool: 'crash', args: {} })
      await new Promise((resolve) => setTimeout(resolve, 400))

      await expect(
        callTool(meta, { action: 'call', tool: 'echo', args: { message: 'x' } })
      ).rejects.toThrow()
      expect(lifecycle.restartsOf('echo')).toBe(1)
    } finally {
      await lifecycle.stop()
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 60_000)
})
