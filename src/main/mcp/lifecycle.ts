/**
 * MCP server 连接的生命周期（T12）：跟着 agent 服务起停、崩溃重启有上限、日志说人话。
 *
 * 谁在用：agent 的动态工具集（agents/kyclaw.ts 的 tools 函数）每次对话前问它要一遍 MCP 工具；
 * 它负责保证"设置里启用中的 server 是连着的"，并把发现到的工具交给 mcp.ts 命名 + 挂权限 gate。
 *
 * 四条纪律：
 *   1. **随应用启停**：client（stdio 子进程的持有者）在第一次需要工具时建立；`stop()`（应用退出、
 *      服务收尾）一定断开——子进程随 transport 关闭而下线。停掉以后 `tools()` 恒为空，不再重连。
 *   2. **设置现读**：每次 `tools()` 比一次"启用中 server 的连接指纹"（id/transport/command/args/url/headers/env，
 *      name 与 readOnlyTools 不影响连接）。变了就整体换一条连接——旧连接断开、失败/重启计数清零。
 *   3. **崩溃重启 ≤ maxRestarts（缺省 2）**：发现失败、或工具调用报连接类错误时，记一条日志、
 *      尝试重连；同一个 server **连续**失败用满次数就"暂停使用"（工具从下一轮消失，不再反复拉起）。
 *      任何一次成功（发现成功 / 调用成功）把计数清零——上限管的是"连续崩溃"，不是服务器的一生。
 *   4. **失败不静默**：连不上只记日志并从工具表里拿掉（该 server 的工具消失），不挡这一轮对话。
 *
 * 客户端可注入（测试用假件钉顺序与计数）；真件是 @mastra/mcp 的 MCPClient（ESM-only，动态 import）。
 */
import type { Tool } from '@mastra/core/tools'
import type { MCPClient } from '@mastra/mcp'
import type { McpServerConfig } from '../../shared/settings'
import {
  classifyMcpFailure,
  collectMcpTools,
  MCP_TIMEOUT_MS,
  parseMcpToolName,
  serverDefinition,
  type McpToolGate
} from '../../mastra/mcp'

/** agent 工具表里的 MCP 工具（@mastra/mcp 造出来的就是这一族） */
type McpTool = Tool<unknown, unknown, unknown, unknown>

/** 生命周期只需要 MCPClient 的这三件事（测试可以造结构相同的假件） */
export type McpClient = Pick<MCPClient, 'listToolsetsWithErrors' | 'reconnectServer' | 'disconnect'>

/** 缺省的重启上限：连续崩溃只拉两次，之后暂停（brief 的 ≤2） */
export const MCP_MAX_RESTARTS = 2

export interface McpLifecycleOptions {
  /** 现读设置里的 server 列表（生产 = dataDir/settings.json） */
  servers: () => readonly McpServerConfig[]
  /** 建客户端（测试注入假件；缺省 = 真 MCPClient） */
  createClient?: (configs: readonly McpServerConfig[]) => Promise<McpClient>
  /** 日志出口（缺省 console.warn；测试收集断言） */
  log?: (line: string) => void
  /** 连续崩溃的重启上限（缺省 2） */
  maxRestarts?: number
  /** 每个 server 的发现超时（缺省 MCP_TIMEOUT_MS） */
  timeoutMs?: number
}

/** 已挂过监督包装的工具（重挂会套娃，WeakSet 去重） */
const supervised = new WeakSet<object>()

/** 连接类错误（子进程死了/管道断了）：这类失败才计入"崩溃重启" */
const CONNECTION_ERROR_PATTERN =
  /connection closed|econnreset|epipe|transport|socket hang up|-32000|closed/i

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isConnectionFailure(error: unknown): boolean {
  const shape = error as { code?: unknown; cause?: { code?: unknown } } | null
  const code = shape?.code ?? shape?.cause?.code
  if (code === 'CONNECTION_CLOSED') return true
  return CONNECTION_ERROR_PATTERN.test(errorText(error))
}

function firstLine(message: string, max = 200): string {
  const line = message.split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export class McpLifecycle {
  private readonly serversFor: () => readonly McpServerConfig[]
  private readonly createClient: (configs: readonly McpServerConfig[]) => Promise<McpClient>
  private readonly log: (line: string) => void
  private readonly maxRestarts: number
  private readonly timeoutMs: number

  private client: McpClient | undefined
  /** 当前连接对应的"连接指纹"（undefined = 还没连过；'' = 一条启用的 server 都没有） */
  private key: string | undefined
  private readonly toolsets = new Map<string, Record<string, McpTool>>()
  private readonly restarts = new Map<string, number>()
  private readonly failed = new Set<string>()
  private clientCounter = 0
  private stopped = false
  /** 同一时刻只跑一次同步（并发对话不该重复建连接） */
  private syncing: Promise<void> | undefined

  constructor(options: McpLifecycleOptions) {
    this.serversFor = options.servers
    this.log = options.log ?? ((line) => console.warn(`[kyclaw] ${line}`))
    this.maxRestarts = Math.max(0, options.maxRestarts ?? MCP_MAX_RESTARTS)
    this.timeoutMs = options.timeoutMs ?? MCP_TIMEOUT_MS
    this.createClient =
      options.createClient ??
      (async (configs) => {
        const { MCPClient: MCPClientClass } = await import('@mastra/mcp')
        this.clientCounter += 1
        return new MCPClientClass({
          // 唯一 id：MCPClient 对"同配置的多实例"会抛内存泄漏保护错误
          id: `kyclaw-mcp-${this.clientCounter}`,
          servers: Object.fromEntries(
            configs.map((config) => [config.id, serverDefinition(config, this.timeoutMs)])
          )
        })
      })
  }

  /** 现读设置里启用的 server 列表（诊断/测试用） */
  enabled(): readonly McpServerConfig[] {
    return this.serversFor().filter((server) => server.enabled)
  }

  /** 连续重启次数（诊断/测试用；一次成功即清零） */
  restartsOf(serverId: string): number {
    return this.restarts.get(serverId) ?? 0
  }

  /**
   * 当前可用的 MCP 工具（`mcp__<server>__<tool>` → Tool，已挂权限 gate）。
   * 发现失败/暂停中的 server 不出现在结果里；设置变了会先换连接。
   */
  async tools(gate: McpToolGate): Promise<Record<string, McpTool>> {
    if (this.stopped) return {}
    const enabled = this.enabled()
    await this.sync(enabled)
    if (this.client === undefined) return {}

    const toolsets: Record<string, Record<string, McpTool>> = {}
    for (const server of enabled) {
      if (this.failed.has(server.id)) continue
      const tools = this.toolsets.get(server.id)
      if (tools !== undefined) toolsets[server.id] = tools
    }

    const collected = collectMcpTools({ toolsets, servers: enabled, gate })
    for (const [name, tool] of Object.entries(collected)) {
      const parsed = parseMcpToolName(name)
      if (parsed !== null) this.supervise(parsed.serverId, tool)
    }
    return collected
  }

  /** 应用退出/服务收尾：断开连接（子进程随 transport 关闭下线），之后不再重连 */
  async stop(): Promise<void> {
    this.stopped = true
    this.toolsets.clear()
    this.key = undefined
    await this.disposeClient()
  }

  /**
   * 与设置对齐（不取工具）：设置页改完立即调用——启停/删除当场生效（子进程下线/上线），
   * 不用等下一次对话。配置没变时是空操作（不会多余地重连或重新发现）。
   */
  async refresh(): Promise<void> {
    if (this.stopped) return
    await this.sync(this.enabled())
  }

  /** 与设置对齐：指纹变了换连接（旧连接断开、计数清零），然后把还没发现的启用 server 发现一遍 */
  private async sync(enabled: readonly McpServerConfig[]): Promise<void> {
    if (this.syncing !== undefined) return this.syncing
    this.syncing = this.syncNow(enabled)
      // 对齐失败不泄给调用方（工具表只是少几条，对话照走；下一轮会再对齐）
      .catch((error) => {
        this.log(`MCP 连接对齐失败（本轮跳过，下一轮再试）：${firstLine(errorText(error))}`)
      })
      .finally(() => {
        this.syncing = undefined
      })
    return this.syncing
  }

  private async syncNow(enabled: readonly McpServerConfig[]): Promise<void> {
    const key = connectionKey(enabled)
    if (this.key !== key) {
      await this.disposeClient()
      this.toolsets.clear()
      this.restarts.clear()
      this.failed.clear()
      // 先清指纹再建连接：createClient 抛错时不会卡在"新指纹 + 没有 client"的半对齐态，
      // 下一轮（或下一次 refresh）会照常重试
      this.key = undefined
      if (enabled.length > 0) {
        const client = await this.createClient(enabled)
        this.client = client
      }
      this.key = key
    }
    if (this.client === undefined) return

    const pending = enabled.filter(
      (server) => !this.toolsets.has(server.id) && !this.failed.has(server.id)
    )
    if (pending.length > 0) await this.discover(pending)
  }

  /**
   * 发现 + 崩溃重启循环：每轮对"还缺的 server"记一次重启、重连、再发现；
   * 连续用满 maxRestarts 次都没起来就暂停。计数每轮 +1，maxRestarts = 2 时最多两条"重启（第 n/2 次）"。
   */
  private async discover(pending: readonly McpServerConfig[]): Promise<void> {
    let missing: McpServerConfig[] = [...pending]

    while (missing.length > 0) {
      const result = await this.client!.listToolsetsWithErrors({
        perServerTimeoutMs: this.timeoutMs
      })

      const stillMissing: McpServerConfig[] = []
      for (const server of missing) {
        const tools = result.toolsets[server.id]
        if (tools !== undefined) {
          this.toolsets.set(server.id, tools)
          this.restarts.set(server.id, 0)
          continue
        }
        stillMissing.push(server)
      }
      if (stillMissing.length === 0) return

      missing = []
      for (const server of stillMissing) {
        const detail = result.errorDetails[server.id]
        const { message } = classifyMcpFailure(detail, result.errors[server.id] ?? '连接失败', {
          command: server.command
        })
        const prior = this.restarts.get(server.id) ?? 0

        if (prior >= this.maxRestarts) {
          this.failed.add(server.id)
          this.log(
            `MCP 服务「${server.name}」连续 ${this.maxRestarts} 次重启都没起来，暂停使用（改配置或重新启停后恢复）：${firstLine(message)}`
          )
          continue
        }
        const count = prior + 1
        this.restarts.set(server.id, count)
        this.log(
          `MCP 服务「${server.name}」连接失败，重启（第 ${count}/${this.maxRestarts} 次）：${firstLine(message)}`
        )
        await this.reconnect(server.id)
        missing.push(server)
      }
    }
  }

  /** 重连一次（失败不抛：下一轮发现会再撞上同一个错误） */
  private async reconnect(serverId: string): Promise<void> {
    const name = this.serversFor().find((server) => server.id === serverId)?.name ?? serverId
    try {
      await this.client?.reconnectServer(serverId)
    } catch (error) {
      this.log(`MCP 服务「${name}」重连失败：${firstLine(errorText(error))}`)
    }
  }

  /**
   * 工具调用的崩溃监督：调用报"连接类错误"（子进程死在调用中间）时记一次重启、尝试重连；
   * 连续用满上限就暂停（下一轮该 server 的工具消失）。业务错误（服务自己回的 isError）不算崩溃。
   */
  private supervise(serverId: string, tool: McpTool): void {
    if (supervised.has(tool)) return
    supervised.add(tool)
    const original = tool.execute
    if (typeof original !== 'function') return
    const callOriginal = original as unknown as (
      input: unknown,
      context: unknown
    ) => Promise<unknown>

    tool.execute = async (input, context) => {
      try {
        const output = await callOriginal.call(tool, input, context)
        this.restarts.set(serverId, 0)
        return output
      } catch (error) {
        if (isConnectionFailure(error)) await this.noteCallFailure(serverId, error)
        throw error
      }
    }
  }

  private async noteCallFailure(serverId: string, error: unknown): Promise<void> {
    if (this.stopped || this.failed.has(serverId)) return
    const name = this.serversFor().find((server) => server.id === serverId)?.name ?? serverId
    const message = firstLine(errorText(error))
    const prior = this.restarts.get(serverId) ?? 0

    if (prior >= this.maxRestarts) {
      this.failed.add(serverId)
      this.toolsets.delete(serverId)
      this.log(
        `MCP 服务「${name}」连续 ${this.maxRestarts} 次重启都没恢复，暂停使用（改配置或重新启停后恢复）：${message}`
      )
      return
    }
    const count = prior + 1
    this.restarts.set(serverId, count)
    this.log(`MCP 服务「${name}」调用中断，重启（第 ${count}/${this.maxRestarts} 次）：${message}`)
    // 调用不在中途重试（可能有副作用）：只把连接拉起来，下一次调用走新连接
    this.toolsets.delete(serverId)
    await this.reconnect(serverId)
  }

  private async disposeClient(): Promise<void> {
    const client = this.client
    this.client = undefined
    if (client === undefined) return
    try {
      await client.disconnect()
    } catch (error) {
      this.log(`MCP 连接断开失败（忽略）：${firstLine(errorText(error))}`)
    }
  }
}

/**
 * 连接指纹：只含影响"怎么连"的字段（name / readOnlyTools / enabled 不进指纹——
 * 前两者不改变连接，enabled 由调用方过滤成列表后再进来）。
 *
 * headers / env 必须进（round 12：用户给 kybase 加了 `Authorization` 却不重连，
 * 旧的无头连接被继续复用 → 一直「没有身份」）；两个 record 按键名排序后再序列化，
 * 键序不同但内容相同 = 同一个指纹。空表与缺省等价（`serverDefinition` 里都不传）。
 */
export function connectionKey(servers: readonly McpServerConfig[]): string {
  return JSON.stringify(
    servers
      .map((server) => ({
        id: server.id,
        transport: server.transport,
        command: server.command ?? '',
        args: server.args ?? [],
        url: server.url ?? '',
        headers: sortedEntries(server.headers),
        env: sortedEntries(server.env)
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  )
}

/** record → 按键名排序的 [k, v] 表（键序无关；值原样） */
function sortedEntries(record: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
