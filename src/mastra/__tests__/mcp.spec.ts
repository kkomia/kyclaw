// @vitest-environment node
/**
 * MCP 接入（T12）的真链路用例：fixtures/mcp-echo-server.mjs 是一个不依赖 SDK 的最小 MCP server，
 * 所有网络/子进程行为都是真的。
 *
 * 覆盖：
 *   1. mcp.ts：命名、分级（未标只读按写类问）、连接（stdio + Streamable HTTP）、错误分类、测试连接；
 *   2. 装配：collectMcpTools 只取启用的 server、命名 mcp__<server>__<tool>、挂同一权限 gate；
 *   3. lifecycle：真子进程崩溃（fixture 的 crash 工具 + 状态文件）→ 重启 ≤2 次、记日志、暂停；
 *   4. 路由：GET/PUT /api/mcp/servers（校验 + 落盘）、POST /:id/test；
 *   5. agent 集成（mock 模型 + 真服务）：未标只读 → approval-requested → 批准执行回显；
 *      标了只读不弹；外部工具带工作区外 path 也**必须**弹（T12 必查项①）；全名规则才放行（必查项②）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { McpLifecycle } from '../../main/mcp/lifecycle'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import {
  classifyMcpFailure,
  classifyMcpToolCall,
  collectMcpTools,
  mcpToolName,
  parseMcpToolName,
  serverDefinition,
  testMcpServer
} from '../mcp'
import { threadMemoryBody } from '../../shared/threads'
import { readSettings, settingsPath, writeSettings } from '../../main/settings'
import { defaultSettings, type McpServerConfig, type Workspace } from '../../shared/settings'

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

const NO_APPROVAL = (): boolean => false

/** 直接调工具（单元用不到真实执行上下文，给个最小 context） */
async function callTool(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: (input: unknown, context: unknown) => Promise<unknown> })
    .execute
  if (execute === undefined) throw new Error('工具没有 execute')
  return await execute.call(tool, input, { agent: { threadId: 'mcp-spec' } })
}

describe('mcp.ts：命名与分级', () => {
  it('工具名 mcp__<server>__<tool>；反向解析取第一个 __（server id 不含分隔符）', () => {
    expect(mcpToolName('echo', 'read_file')).toBe('mcp__echo__read_file')
    expect(parseMcpToolName('mcp__echo__read_file')).toEqual({
      serverId: 'echo',
      tool: 'read_file'
    })
    expect(parseMcpToolName('write')).toBeNull()
    expect(parseMcpToolName('mcp__echo')).toBeNull()
    expect(parseMcpToolName('mcp____tool')).toBeNull()
  })

  it('未标只读 → write（默认问）；标了只读才 read；末段 delete 仍是 dangerous', () => {
    const servers = [stdioConfig({ readOnlyTools: ['echo'] })]

    expect(classifyMcpToolCall('mcp__echo__echo', {}, servers)).toBe('read')
    expect(classifyMcpToolCall('mcp__echo__write_remote', {}, servers)).toBe('write')
    // 名字像 read 不算数：没有只读标记就按写类问（外部工具的名字不可信）
    expect(classifyMcpToolCall('mcp__echo__read', {}, servers)).toBe('write')
    expect(classifyMcpToolCall('mcp__echo__delete', {}, servers)).toBe('dangerous')
    // 别家 server / 非 MCP 名
    expect(classifyMcpToolCall('mcp__other__echo', {}, servers)).toBe('write')
    expect(classifyMcpToolCall('write', {}, servers)).toBe('write')
    expect(classifyMcpToolCall('read', {}, servers)).toBe('read')
  })

  it('失败分类：握手超时 / 启动失败 / 服务没正常响应', () => {
    expect(classifyMcpFailure({ code: 'REQUEST_TIMEOUT', message: 'Request timed out' }).kind).toBe(
      'handshake-timeout'
    )
    expect(
      classifyMcpFailure({ code: 'CONNECTION_CLOSED', message: 'Connection closed' }).kind
    ).toBe('spawn')
    expect(classifyMcpFailure({ code: -32603, message: 'boom' }).kind).toBe('protocol')
    expect(classifyMcpFailure(new Error('随便什么错')).kind).toBe('protocol')
  })

  it('serverDefinition：stdio 带命令与参数；http 解析 URL 并拒绝非 http(s)', () => {
    expect(serverDefinition(stdioConfig(), 1000)).toMatchObject({
      command: process.execPath,
      args: [FIXTURE],
      timeout: 1000
    })
    const http = serverDefinition(
      stdioConfig({
        transport: 'http',
        command: undefined,
        args: undefined,
        url: 'http://127.0.0.1:9/mcp'
      }),
      1000
    )
    expect(String((http as { url: URL }).url)).toBe('http://127.0.0.1:9/mcp')
    expect(() =>
      serverDefinition(
        stdioConfig({ transport: 'http', command: undefined, url: 'ftp://x/mcp' }),
        1000
      )
    ).toThrow(/http/)
  })

  it('collectMcpTools：停用的 server 不进工具表；启用并发现到的才进，gate 逐调用生效', () => {
    const toolsets = { echo: { echo: { id: 'echo_echo', description: '' } } }
    const gate = (tool: string, input: unknown): boolean =>
      tool === 'mcp__echo__echo' && input !== 1

    const collected = collectMcpTools({
      toolsets: toolsets as never,
      servers: [stdioConfig({ enabled: false })],
      gate: NO_APPROVAL
    })
    expect(collected).toEqual({})

    const enabled = collectMcpTools({
      toolsets: toolsets as never,
      servers: [stdioConfig()],
      gate
    })
    expect(Object.keys(enabled)).toEqual(['mcp__echo__echo'])
    expect(enabled['mcp__echo__echo'].id).toBe('mcp__echo__echo')
    expect(enabled['mcp__echo__echo'].requireApproval).toBe(true)
    expect(enabled['mcp__echo__echo'].needsApprovalFn?.({}, {})).toBe(true)
    expect(enabled['mcp__echo__echo'].needsApprovalFn?.(1, {})).toBe(false)
  })
})

describe('mcp.ts：真 stdio 子进程', () => {
  it('连上 fixture：listTools 含 echo，调用真回显；测试连接返回工具清单与延迟', async () => {
    const result = await testMcpServer(stdioConfig(), { timeoutMs: 10_000 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tools.map((tool) => tool.name)).toContain('echo')
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    }

    const { MCPClient } = await import('@mastra/mcp')
    const client = new MCPClient({
      id: `kyclaw-mcp-spec-${Date.now()}`,
      servers: { echo: serverDefinition(stdioConfig(), 10_000) }
    })
    try {
      const toolsets = await client.listToolsets()
      const collected = collectMcpTools({
        toolsets,
        servers: [stdioConfig()],
        gate: NO_APPROVAL
      })
      expect(Object.keys(collected).sort()).toEqual([
        'mcp__echo__crash',
        'mcp__echo__echo',
        'mcp__echo__fail',
        'mcp__echo__write_remote'
      ])

      const output = await callTool(collected['mcp__echo__echo'], { message: '你好 MCP' })
      expect(JSON.stringify(output)).toContain('echo: 你好 MCP')
    } finally {
      await client.disconnect()
    }
  }, 30_000)

  it('错误分类是真的：命令不存在 → 启动失败；--hang → 握手超时；--fail-list → 服务没正常响应', async () => {
    const ghost = await testMcpServer(
      stdioConfig({ command: 'definitely-not-a-real-command-xyz' }),
      {
        timeoutMs: 3000
      }
    )
    expect(ghost).toMatchObject({ ok: false, kind: 'spawn' })

    const hang = await testMcpServer(stdioConfig({ args: [FIXTURE, '--hang'] }), { timeoutMs: 600 })
    expect(hang).toMatchObject({ ok: false, kind: 'handshake-timeout' })

    const failList = await testMcpServer(stdioConfig({ args: [FIXTURE, '--fail-list'] }), {
      timeoutMs: 5000
    })
    expect(failList).toMatchObject({ ok: false, kind: 'protocol' })
    if (!failList.ok) expect(failList.message).toContain('没有正常响应')
  }, 30_000)
})

describe('mcp.ts：真 Streamable HTTP（fixture 的 --http 模式）', () => {
  let child: ChildProcess | undefined
  let port = 0

  beforeAll(async () => {
    port = await freePort()
    child = spawn(process.execPath, [FIXTURE, `--http=${port}`], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture HTTP 模式没起来')), 10_000)
      child!.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('listening')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  }, 20_000)

  afterAll(() => {
    child?.kill()
  })

  it('HTTP transport：测试连接成功，工具可真调用', async () => {
    const config = stdioConfig({
      id: 'remote',
      transport: 'http',
      command: undefined,
      args: undefined,
      url: `http://127.0.0.1:${port}/mcp`
    })

    const result = await testMcpServer(config, { timeoutMs: 8000 })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.tools.map((tool) => tool.name)).toContain('echo')

    const { MCPClient } = await import('@mastra/mcp')
    const client = new MCPClient({
      id: `kyclaw-mcp-http-${Date.now()}`,
      servers: { remote: serverDefinition(config, 8000) }
    })
    try {
      const toolsets = await client.listToolsets()
      const collected = collectMcpTools({ toolsets, servers: [config], gate: NO_APPROVAL })
      const output = await callTool(collected['mcp__remote__echo'], { message: 'HTTP 你好' })
      expect(JSON.stringify(output)).toContain('echo: HTTP 你好')
    } finally {
      await client.disconnect()
    }
  }, 30_000)
})

describe('McpLifecycle：真子进程崩溃 → 重启 ≤2 次并暂停', () => {
  it('crash 工具杀掉子进程并留下坏标记：调用中断记一次重启，连不上后暂停（工具消失）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-mcp-crash-'))
    const stateFile = join(dir, 'broken-flag')
    const servers = [stdioConfig({ args: [FIXTURE, `--state-file=${stateFile}`] })]
    const logs: string[] = []
    const lifecycle = new McpLifecycle({
      servers: () => servers,
      log: (line) => logs.push(line),
      timeoutMs: 5000
    })

    try {
      const tools = await lifecycle.tools(NO_APPROVAL)
      expect(tools['mcp__echo__crash']).toBeDefined()

      // 崩掉子进程（并写下"起不来"的状态文件）
      await callTool(tools['mcp__echo__crash'], {})
      await new Promise((resolve) => setTimeout(resolve, 400))

      // 下一次调用撞上死连接：记一次重启（不在中途重试）
      await expect(callTool(tools['mcp__echo__echo'], { message: 'x' })).rejects.toThrow()
      expect(lifecycle.restartsOf('echo')).toBe(1)
      expect(logs.some((line) => line.includes('调用中断，重启（第 1/2 次）'))).toBe(true)

      // 服务已经起不来：发现阶段用满第二次重启后暂停，工具从表里消失
      const after = await lifecycle.tools(NO_APPROVAL)
      expect(after).toEqual({})
      expect(logs.some((line) => line.includes('重启（第 2/2 次）'))).toBe(true)
      expect(logs.some((line) => line.includes('暂停使用'))).toBe(true)
      expect(lifecycle.restartsOf('echo')).toBe(2)
    } finally {
      await lifecycle.stop()
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 60_000)
})

describe('MCP 路由：写成功后通知连接对齐', () => {
  it('PUT 成功 → onServersChanged 触发一次；校验失败（400）不触发', async () => {
    const { createMcpRouter } = await import('../routes/mcp')
    const changed = vi.fn()
    const saved: McpServerConfig[] = []
    const router = createMcpRouter({
      readServers: () => saved,
      saveServers: (servers) => {
        saved.splice(0, saved.length, ...servers)
        return saved
      },
      onServersChanged: changed,
      testServer: async () => ({ ok: true, latencyMs: 1, tools: [] })
    })

    const put = async (servers: McpServerConfig[]): Promise<Response> =>
      await router.request('/servers', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ servers })
      })

    const bad = await put([stdioConfig({ command: '' })])
    expect(bad.status).toBe(400)
    expect(changed).not.toHaveBeenCalled()

    const good = await put([stdioConfig({ enabled: false })])
    expect(good.status).toBe(200)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(saved).toHaveLength(1)
  })
})

describe('MCP 管理路由（GET/PUT/test）', () => {
  let dir: string
  let server: AgentServerHandle

  const authed = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
        ...init.headers
      }
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-mcp-routes-'))
    server = await startAgentServer({ dataDir: dir })
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it('GET 空列表 / PUT 落盘（供 GET 读回、settings.json 真有）', async () => {
    const initial = await authed('/api/mcp/servers')
    expect(await initial.json()).toEqual({ servers: [] })

    const config = stdioConfig({ name: '回显', enabled: false })
    const saved = await authed('/api/mcp/servers', {
      method: 'PUT',
      body: JSON.stringify({ servers: [config] })
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ servers: [config] })

    const readBack = await authed('/api/mcp/servers')
    expect(await readBack.json()).toEqual({ servers: [config] })
    expect(readSettings(settingsPath(dir)).mcpServers).toEqual([config])
  })

  it('PUT 校验：启用的 server 缺命令 / id 重复 / 形状不对 → 400 且不落盘', async () => {
    const bad = await authed('/api/mcp/servers', {
      method: 'PUT',
      body: JSON.stringify({ servers: [stdioConfig({ command: '' })] })
    })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).toContain('启动命令')

    const duplicated = await authed('/api/mcp/servers', {
      method: 'PUT',
      body: JSON.stringify({
        servers: [stdioConfig({ enabled: false }), stdioConfig({ enabled: false })]
      })
    })
    expect(duplicated.status).toBe(400)
    expect(JSON.stringify(await duplicated.json())).toContain('标识重复')

    const malformed = await authed('/api/mcp/servers', {
      method: 'PUT',
      body: JSON.stringify({ servers: [{ nope: 1 }] })
    })
    expect(malformed.status).toBe(400)

    // 没被任何一次坏请求写脏
    expect(readSettings(settingsPath(dir)).mcpServers).toHaveLength(1)
    expect(readSettings(settingsPath(dir)).mcpServers[0].name).toBe('回显')
  })

  it('POST /:id/test：真连 fixture 返回工具清单；未知 id → 404', async () => {
    await authed('/api/mcp/servers', {
      method: 'PUT',
      body: JSON.stringify({ servers: [stdioConfig({ name: '回显', enabled: false })] })
    })

    const result = await authed('/api/mcp/servers/echo/test', { method: 'POST' })
    expect(result.status).toBe(200)
    const body = (await result.json()) as { ok: boolean; tools?: Array<{ name: string }> }
    expect(body.ok).toBe(true)
    expect(body.tools?.map((tool) => tool.name)).toContain('echo')

    const missing = await authed('/api/mcp/servers/nope/test', { method: 'POST' })
    expect(missing.status).toBe(404)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// agent 集成：mock 模型 + 真 agent 服务 + 真 MCP 子进程
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

function toolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

describe('agent 集成：MCP 工具走同一权限 gate', () => {
  let dir: string
  let workspace: string
  let workspaces: Workspace[]
  let server: AgentServerHandle
  const scripts: Array<() => StreamPart[]> = []
  const servers: McpServerConfig[] = []

  function writeMcpSettings(): void {
    writeSettings(settingsPath(dir), { ...defaultSettings(), mcpServers: servers })
  }

  async function chat(
    messages: unknown[],
    threadId: string
  ): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ messages, ...threadMemoryBody(threadId) })
    })
    expect(response.status).toBe(200)
    return sseParts(await response.text())
  }

  function user(id: string, text: string): Record<string, unknown> {
    return { id, role: 'user', parts: [{ type: 'text', text }] }
  }

  function approvalReply(
    messageId: unknown,
    toolName: string,
    toolCallId: string,
    input: unknown,
    approvalId: unknown,
    approved: boolean
  ): Record<string, unknown> {
    return {
      id: messageId,
      role: 'assistant',
      parts: [
        {
          type: `tool-${toolName}`,
          toolCallId,
          state: 'approval-responded',
          input,
          approval: { id: approvalId, approved }
        }
      ]
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-mcp-agent-'))
    mkdirSync(join(dir, 'ws'), { recursive: true })
    workspace = realpathSync.native(join(dir, 'ws'))
    workspaces = [{ path: workspace, mode: 'ask' }]
    servers.push(stdioConfig({ name: '回显服务' }))
    writeMcpSettings()

    const model = new MockLanguageModelV4({
      provider: 'kyclaw-mcp-mock',
      modelId: 'kyclaw-mcp-mock',
      doStream: async () => {
        const script = scripts.shift()
        if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
        return {
          stream: simulateReadableStream({
            chunks: script(),
            initialDelayInMs: 0,
            chunkDelayInMs: 0
          })
        }
      }
    })

    server = await startAgentServer({ dataDir: dir, model, workspaces: () => workspaces })
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it('未标只读：调用 echo → 弹审批；批准后才真执行并回显（真子进程往返）', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('mcp-a', 'mcp__echo__echo', { message: '你好 世界' }))
    scripts.push(() => textScript('回显完了。'))

    const first = await chat([user('u-mcp-a', '让回显服务说句话')], 'thread-mcp-a')
    const approval = first.find((part) => part.type === 'tool-approval-request')
    expect(approval).toBeDefined()
    expect(approval?.toolCallId).toBe('mcp-a')
    expect(first.some((part) => part.type === 'tool-output-available')).toBe(false)

    const messageId = first.find((part) => part.type === 'start')?.messageId
    const second = await chat(
      [
        user('u-mcp-a', '让回显服务说句话'),
        approvalReply(
          messageId,
          'mcp__echo__echo',
          'mcp-a',
          { message: '你好 世界' },
          approval?.approvalId,
          true
        )
      ],
      'thread-mcp-a'
    )
    const output = second.find((part) => part.type === 'tool-output-available')
    expect(output).toBeDefined()
    expect(JSON.stringify(output?.output)).toContain('echo: 你好 世界')
  }, 60_000)

  it('标了只读：同一个工具直接执行，不弹审批', async () => {
    servers[0] = stdioConfig({ readOnlyTools: ['echo'], name: '回显服务' })
    writeMcpSettings()

    scripts.length = 0
    scripts.push(() => toolCallScript('mcp-b', 'mcp__echo__echo', { message: '只读放行' }))
    scripts.push(() => textScript('好。'))

    const parts = await chat([user('u-mcp-b', '直接回显')], 'thread-mcp-b')
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
    const output = parts.find((part) => part.type === 'tool-output-available')
    expect(JSON.stringify(output?.output)).toContain('echo: 只读放行')

    servers[0] = stdioConfig({ name: '回显服务' })
    writeMcpSettings()
  }, 60_000)

  it('必查项①：外部工具带工作区外的 path 也必须弹审批（旧的"路径解析不到就不问"不再适用）', async () => {
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('mcp-c', 'mcp__echo__write_remote', {
        path: join(dir, 'outside', 'evil.txt'),
        content: 'x'
      })
    )
    scripts.push(() => textScript('处理完了。'))

    const parts = await chat([user('u-mcp-c', '往外面写点东西')], 'thread-mcp-c')
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(parts.some((part) => part.type === 'tool-output-available')).toBe(false)
  }, 60_000)

  it('必查项②：只有全名规则（mcp__echo__write_remote）才免审批；内置 write 的规则不顶用', async () => {
    // 先写一条内置 write 的规则：对 MCP 工具无效
    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      mcpServers: servers,
      permissions: { rules: [{ tool: 'write', workspace, mode: 'allow' }] }
    })
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('mcp-d', 'mcp__echo__write_remote', { path: 'note.txt', content: 'x' })
    )
    scripts.push(() => textScript('处理完了。'))
    const stillAsks = await chat([user('u-mcp-d', '写 note.txt')], 'thread-mcp-d')
    expect(stillAsks.some((part) => part.type === 'tool-approval-request')).toBe(true)

    // 换成该 MCP 工具的全名规则：下一轮不再问，直接执行
    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      mcpServers: servers,
      permissions: {
        rules: [{ tool: 'mcp__echo__write_remote', workspace, mode: 'allow' }]
      }
    })
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('mcp-e', 'mcp__echo__write_remote', { path: 'note.txt', content: 'x' })
    )
    scripts.push(() => textScript('处理完了。'))
    const allowed = await chat([user('u-mcp-e', '写 note.txt')], 'thread-mcp-e')
    expect(allowed.some((part) => part.type === 'tool-approval-request')).toBe(false)
    const output = allowed.find((part) => part.type === 'tool-output-available')
    expect(JSON.stringify(output?.output)).toContain('note.txt')

    writeSettings(settingsPath(dir), { ...defaultSettings(), mcpServers: servers })
  }, 60_000)
})

/** 让 OS 分配一个空闲端口（fixture 的 HTTP 模式用） */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
