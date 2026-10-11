/**
 * MCP 外部工具接入（T12）：@mastra/mcp 的 MCPClient 封装 + 工具命名 + 权限 gate 接线。
 *
 * 三件事：
 *   1. **命名**：工具在 agent 里叫 `mcp__<serverId>__<tool>`（brief 的契约）。@mastra/mcp 自己的
 *      命名是 `serverId_toolName`，这里统一换成带 `__` 的名字，和内置工具一眼分得开、也不跟内置名撞。
 *      `parseMcpToolName` 是反向解析（取第一个 `__` 当分隔；server id 的 schema 里不含 `__`）。
 *   2. **分级**（`createMcpClassify`）：MCP 工具**未标记只读一律按写类询问**——只有用户在设置里
 *      对某个工具勾了"只读"，它才是 read 档；名字像 read 不算数（外部工具的行为我们没法靠名字相信）。
 *      末段是 delete/move 的仍保留"危险类"这一保守信号（永远问，连"永久允许"也放不倒它）。
 *   3. **连接与错误分类**：stdio / Streamable HTTP 两种 server 定义；`testMcpServer` 连接 + 列工具，
 *      失败归到"启动失败 / 握手超时 / 服务没正常响应"三类（UI 行内提示、日志都用同一句）。
 *
 * 本模块不持有状态（生命周期与缓存见 main/mcp/lifecycle.ts）；Mastra 系依赖 ESM-only、
 * 主进程产物是 CJS，所以运行期对象一律动态 import()，静态 import 只拿类型。
 */
import type { Tool } from '@mastra/core/tools'
import { classifyToolCall, type ToolClass } from '../main/permission/classify'
import type { ToolClassifier } from './tools/guard'
import type { McpServerConfig } from '../shared/settings'
import {
  isHttpUrl,
  URL_PROBLEM,
  type McpFailureKind,
  type McpTestResult,
  type McpToolInfo
} from '../shared/mcp'
import type { MastraMCPServerDefinition } from '@mastra/mcp'

/** 工具名前缀；`mcp__<serverId>__<toolName>` */
export const MCP_TOOL_PREFIX = 'mcp__'

/** 运行期请求超时（握手/列工具/调用共用；MCP 工具的慢调用也受这一档约束） */
export const MCP_TIMEOUT_MS = 30_000

/** "测试连接"的超时：用户在设置页等着看结果，短一些 */
export const MCP_TEST_TIMEOUT_MS = 15_000

/** 工具名拼装：`mcp__echo__echo` */
export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`
}

/** 反向解析；不是 `mcp__server__tool` 形状回 null（server id 不含 `__`，取第一个分隔） */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
  const trimmed = name.trim()
  if (!trimmed.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = trimmed.slice(MCP_TOOL_PREFIX.length)
  const at = rest.indexOf('__')
  if (at <= 0) return null
  const serverId = rest.slice(0, at)
  const tool = rest.slice(at + 2)
  if (tool === '') return null
  return { serverId, tool }
}

/**
 * MCP 工具的分级（spec §5.2「只读类 MCP 工具」由用户确认）：
 *   - 末段是 delete/move → **dangerous（永远问）**：这一档先判，用户的"只读"标记也盖不过它
 *     （危险类工具不受任何放行手段影响，与内置 delete/move 同一口径）；
 *   - 设置里标了只读 → read（放行）；
 *   - 没标 → write（默认询问）。
 */
export function classifyMcpToolCall(
  tool: string,
  input: unknown,
  servers: readonly McpServerConfig[]
): ToolClass {
  const parsed = parseMcpToolName(tool)
  if (parsed === null) return classifyToolCall(tool, input)

  // 危险档优先于只读标记：名字像删除/移动的外部工具，勾了"只读"也照问
  if (classifyToolCall(parsed.tool, input) === 'dangerous') return 'dangerous'

  const server = servers.find((candidate) => candidate.id === parsed.serverId)
  if (server?.readOnlyTools.includes(parsed.tool)) return 'read'
  return 'write'
}

/** 注入 agent 的分级器：MCP 名走上面的口径，其余名字回落内置分级（现读设置） */
export function createMcpClassify(servers: () => readonly McpServerConfig[]): ToolClassifier {
  return (tool, input) => classifyMcpToolCall(tool, input, servers())
}

/** 配置 → @mastra/mcp 的 server 定义（transport 自动按 command/url 识别） */
export function serverDefinition(
  config: McpServerConfig,
  timeoutMs: number = MCP_TIMEOUT_MS
): MastraMCPServerDefinition {
  if (config.transport === 'stdio') {
    const command = (config.command ?? '').trim()
    if (command === '') throw new Error(`${config.name}：stdio 服务没有填写启动命令`)
    // env（round 9）：用户配的环境变量原样交给子进程；空表不传（保持库的默认环境继承口径）
    const env = config.env
    return {
      command,
      args: config.args ?? [],
      ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
      timeout: timeoutMs,
      // 子进程的 stderr 收进管道（默认会直接喷到应用日志里；出问题看 getServerStderr）
      stderr: 'pipe'
    }
  }

  const url = (config.url ?? '').trim()
  if (url === '') throw new Error(`${config.name}：HTTP 服务没有填写地址`)
  if (!isHttpUrl(url)) throw new Error(`${config.name}：${URL_PROBLEM}`)
  // headers（round 9）：自定义请求头（如 Authorization）透传给 Streamable HTTP transport；
  // 空表不传（避免空 requestInit 影响库的默认构造）
  const headers = config.headers
  return {
    url: new URL(url),
    ...(headers === undefined || Object.keys(headers).length === 0
      ? {}
      : { requestInit: { headers } }),
    timeout: timeoutMs,
    connectTimeout: timeoutMs
  }
}

/** 工具调用的审批判定入口（agent 装配把它接到 guard.needsApproval 上） */
export type McpToolGate = (tool: string, input: unknown) => boolean

/**
 * listToolsets 的结果 → agent 的工具表：只取**启用中**的 server；命名 `mcp__<server>__<tool>`；
 * 每个工具挂上同一个权限 gate（requireApproval，走 guard.needsApproval —— 和内置工具一条路）。
 *
 * 直接改 @mastra/mcp 造出来的 Tool 实例（和该库自己挂 `needsApprovalFn` 的手法一致）：
 * id 改成 `__` 命名（Tool Search 之类的按 id 索引的地方也一致），审批判定换成我们的 gate。
 */
export function collectMcpTools(options: {
  toolsets: Record<string, Record<string, Tool>>
  servers: readonly McpServerConfig[]
  gate: McpToolGate
}): Record<string, Tool> {
  const collected: Record<string, Tool> = {}

  for (const server of options.servers) {
    if (!server.enabled) continue
    const tools = options.toolsets[server.id]
    if (tools === undefined) continue

    for (const [toolName, tool] of Object.entries(tools)) {
      const name = mcpToolName(server.id, toolName)
      tool.id = name
      tool.requireApproval = true
      tool.needsApprovalFn = (args: unknown) => options.gate(name, args)
      collected[name] = tool
    }
  }

  return collected
}

/** 失败分类用到的最小形状（MastraError / SdkError / 普通 Error 都装得下） */
interface ErrorShape {
  code?: unknown
  message?: unknown
  cause?: unknown
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as ErrorShape).code
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as ErrorShape).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** 取首行、截断：错误消息里常带 SDK 栈帧，不适合整段进 UI 或日志 */
function firstLine(message: string, max = 200): string {
  const line = message.split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 错误码（MastraError 会把 SDK 的 code 放进 cause，自己带 domain 级的 code）→ 人话分类 */
function kindOfCode(code: unknown): McpFailureKind {
  if (code === 'REQUEST_TIMEOUT' || code === -32001) return 'handshake-timeout'
  if (code === 'CONNECTION_CLOSED') return 'spawn'
  return 'protocol'
}

/** 没有机器可读 code 时看消息：发现阶段的超时就是"握手超时"（服务没在期限内应答） */
function kindOfMessage(message: string): McpFailureKind {
  return /timed out|timeout/i.test(message) ? 'handshake-timeout' : 'protocol'
}

/**
 * 连接/列工具失败 → 分类 + 一句人话。`detail` 可以是 @mastra/mcp 的 errorDetails
 * （带机器可读的 code），也可以是任意 Error。
 */
export function classifyMcpFailure(
  detail: unknown,
  fallbackMessage?: string
): {
  kind: McpFailureKind
  message: string
} {
  const code = errorCode(detail) ?? errorCode(asErrorShape(detail)?.cause)
  const raw = firstLine(errorMessage(detail), 300) || fallbackMessage || '未知原因'
  const kind = code === undefined ? kindOfMessage(raw) : kindOfCode(code)

  if (kind === 'handshake-timeout') return { kind, message: `连接超时：${raw}` }
  if (kind === 'spawn') return { kind, message: `服务没能启动或立刻退出：${raw}` }
  return { kind, message: `服务没有正常响应：${raw}` }
}

function asErrorShape(value: unknown): ErrorShape | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as ErrorShape
}

/**
 * "测试连接"：连上 + 列一次工具，返回延迟与工具清单（UI 用它填"单工具只读"开关）。
 * 每次都是**独立的一次连接**（一次性 client），测完就断——不和 agent 运行期那条连接共用。
 */
export async function testMcpServer(
  config: McpServerConfig,
  options: { timeoutMs?: number } = {}
): Promise<McpTestResult> {
  const timeoutMs = options.timeoutMs ?? MCP_TEST_TIMEOUT_MS
  const { MCPClient } = await import('@mastra/mcp')

  const startedAt = Date.now()
  let client: InstanceType<typeof MCPClient> | undefined
  try {
    client = new MCPClient({
      id: `kyclaw-mcp-test-${config.id}-${startedAt}`,
      servers: { [config.id]: serverDefinition(config, timeoutMs) }
    })
    const { toolsets, errorDetails } = await client.listToolsetsWithErrors({
      perServerTimeoutMs: timeoutMs
    })

    const detail = errorDetails[config.id]
    if (detail !== undefined) {
      return { ok: false, ...classifyMcpFailure(detail) }
    }

    const tools: McpToolInfo[] = Object.entries(toolsets[config.id] ?? {}).map(([name, tool]) => ({
      name,
      description: tool.description ?? ''
    }))
    return { ok: true, latencyMs: Date.now() - startedAt, tools }
  } catch (error) {
    return { ok: false, ...classifyMcpFailure(error) }
  } finally {
    await client?.disconnect().catch(() => {})
  }
}
