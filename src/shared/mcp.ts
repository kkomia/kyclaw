/**
 * MCP 设置面（T12）：一个 server 配置的校验与"哪里不完整"的人话，以及管理路由的入参/回包 schema。
 *
 * 落点：`settings.mcpServers`（shared/settings.ts 追加字段，走 main/settings.ts 落盘）。
 * 写入口只有一条：agent 服务的 `PUT /api/mcp/servers`（mastra/routes/mcp.ts，整表替换）；
 * settings:update 的补丁 schema 里**没有**这个字段（见 shared/settings.ts），
 * 所以配置的校验只有这一份实现 —— 渲染端行内提示、主进程写盘前拦一道，都用它。
 *
 * id 会进工具名 `mcp__<id>__<tool>`，所以限制成"字母/数字/短横线"：`__` 是命名分隔符，
 * 出现在 id 里会让"哪个 server 的工具"变得有歧义（解析取第一个 `__`，其余都算工具名的一部分）。
 */
import { z } from './zod'
import { mcpServerSchema, type McpServerConfig } from './settings'

/** 新建 server 的 id 前缀（`mcp-1`、`mcp-2`…） */
export const MCP_ID_PREFIX = 'mcp-'

/** id 的合法形状：小写字母/数字/短横线，1..32 位 */
export const MCP_ID_PATTERN = /^[a-z0-9-]{1,32}$/

const ID_PROBLEM = '标识只能用 1–32 位小写字母、数字或短横线（它要进工具名）'

/** HTTP 地址问题的同一句人话（校验层与 serverDefinition 共用） */
export const URL_PROBLEM = 'HTTP 地址要是完整的 http:// 或 https:// 地址'

/**
 * HTTP 地址必须能被 URL 解析出来：`http://` 这类半截串过得了前缀检查，却会在 `new URL` 抛错——
 * 那时已经到连接阶段（保存/启用都显示成功），错误反而落在运行期。这里和 mastra/mcp.ts 的
 * serverDefinition 用同一把尺（真实解析一次），半截地址在 400 / 行内提示层就被挡下。
 */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 单条 server 配置"哪里不完整/不合法"的人话列表（空数组 = 可以启用 / 可以连接） */
export function mcpServerProblems(server: McpServerConfig): string[] {
  const problems: string[] = []
  if (!MCP_ID_PATTERN.test(server.id)) problems.push(ID_PROBLEM)
  if (server.name.trim() === '') problems.push('名称不能为空')

  if (server.transport === 'stdio') {
    if ((server.command ?? '').trim() === '') problems.push('stdio 服务需要填写启动命令')
  } else {
    const url = (server.url ?? '').trim()
    if (url === '') problems.push('HTTP 服务需要填写地址')
    else if (!isHttpUrl(url)) problems.push(URL_PROBLEM)
  }
  return problems
}

/**
 * 整表落盘前能拦住的问题：**启用中**的服务必须配置完整、标识不重复。
 * 停用中的服务允许存半截配置（先存草稿，改完再启用）——只有标识这一条是结构性的，始终拦。
 */
export function mcpServersProblems(servers: readonly McpServerConfig[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    const label = server.name.trim() === '' ? server.id : server.name
    if (server.enabled) {
      for (const problem of mcpServerProblems(server)) problems.push(`${label}：${problem}`)
    } else if (!MCP_ID_PATTERN.test(server.id)) {
      problems.push(`${label}：${ID_PROBLEM}`)
    }
    if (seen.has(server.id)) problems.push(`标识重复：${server.id}`)
    seen.add(server.id)
  }
  return problems
}

/** 新建一个空白 server（id 取下一个没被占用的 `mcp-N`）；一律以**停用**落盘，配好再启用 */
export function newMcpServer(
  servers: readonly McpServerConfig[],
  transport: 'stdio' | 'http'
): McpServerConfig {
  const used = new Set(servers.map((server) => server.id))
  let index = servers.length + 1
  while (used.has(`${MCP_ID_PREFIX}${index}`)) index += 1
  return {
    id: `${MCP_ID_PREFIX}${index}`,
    name: transport === 'stdio' ? '新服务' : '新 HTTP 服务',
    transport,
    ...(transport === 'stdio' ? { command: '', args: [] } : { url: '' }),
    enabled: false,
    readOnlyTools: []
  }
}

/** 参数输入框 ↔ string[]：空格分隔（带空格的参数用双引号包裹；带引号的参数原样保留） */
export function argsToText(args: readonly string[]): string {
  return args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')
}

export function textToArgs(text: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  for (const match of text.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? '')
  }
  return args
}

/** GET /api/mcp/servers 的回包（就是落盘的那份列表） */
export const mcpServersResponseSchema = z.strictObject({ servers: z.array(mcpServerSchema) })

/** PUT /api/mcp/servers 的入参：整表替换 */
export const putMcpServersRequestSchema = z.strictObject({ servers: z.array(mcpServerSchema) })

/** 测试连接发现的单个工具（只给用户看的信息；"只读"是用户自己的标记，不看服务端的 hint） */
export const mcpToolInfoSchema = z.strictObject({
  name: z.string(),
  description: z.string()
})

/** 连接失败的三种分类（mastra/mcp.ts 里就此分类；UI 只显示 message） */
export const mcpFailureKindSchema = z.enum(['spawn', 'handshake-timeout', 'protocol'])

/** 测试连接的结果：成功给延迟 + 工具清单；失败给分类与一句人话（UI 行内显示） */
export const mcpTestResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    latencyMs: z.number(),
    tools: z.array(mcpToolInfoSchema)
  }),
  z.strictObject({
    ok: z.literal(false),
    kind: mcpFailureKindSchema,
    message: z.string()
  })
])

export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>
export type McpFailureKind = z.infer<typeof mcpFailureKindSchema>
export type McpTestResult = z.infer<typeof mcpTestResultSchema>
