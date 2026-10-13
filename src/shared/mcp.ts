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

/**
 * 工具名前缀与拼装：`mcp__<serverId>__<toolName>`（round 14 从 mastra/mcp.ts 搬到 shared——
 * 渲染端也要用它把内部名翻译成「服务名 · 工具名」显示）。
 */
export const MCP_TOOL_PREFIX = 'mcp__'

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
 * 元工具的第三段（round 75「渐进披露」）：`mcp__<serverId>__meta`。
 *
 * 一个 server 的工具不再逐件进每轮请求前缀（实测 kybase 11 件 ≈5.2k 字符 ≈2k token/轮），
 * 而是换成这一个入口：`{action:"list"}` 拿清单（名字 + 一行 + 参数名与类型 + 审批档）、
 * `{action:"call", tool, args}` 真调用。构建方在 `mastra/mcp.ts` 的 `buildMcpToolTable`。
 *
 * 为什么取 `meta` 当第三段：它必须落在 `mcp__<serverId>__<tool>` 的既有形状里，渲染端与轨迹页
 * 才能沿用同一套解析（否则又要多一套命名规则）。服务端真有个叫 `meta` 的工具时不夺名 ——
 * 那个 server 退回逐件注入（见 buildMcpToolTable 的碰撞分支）。
 */
export const MCP_META_TOOL_SEGMENT = 'meta'

/** 元工具名：`mcp__<serverId>__meta` */
export function mcpMetaToolName(serverId: string): string {
  return mcpToolName(serverId, MCP_META_TOOL_SEGMENT)
}

/** `mcp__<serverId>__meta` → serverId；不是元工具名回 null（渲染端 / 轨迹页判断要不要解包） */
export function parseMcpMetaToolName(name: string): { serverId: string } | null {
  const parsed = parseMcpToolName(name)
  if (parsed === null || parsed.tool !== MCP_META_TOOL_SEGMENT) return null
  return { serverId: parsed.serverId }
}

/** 元工具 `call` 的入参形状（只有这两件事有意义；`list` 不带它们） */
export interface McpMetaCall {
  /** 被调用的真实工具名（第三段，不含 `mcp__<server>__` 前缀） */
  tool: string
  /** 传给该工具的入参对象（原样交给服务端 schema 校验） */
  args: unknown
}

/** 元工具入参 → 被调用的工具与入参；不是"这个元工具在 call"就回 null（认不出就不猜） */
export function mcpMetaCallOf(input: unknown): McpMetaCall | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as { action?: unknown; tool?: unknown; args?: unknown }
  if (record.action !== 'call') return null
  if (typeof record.tool !== 'string' || record.tool.trim() === '') return null
  return { tool: record.tool.trim(), args: record.args ?? {} }
}

/**
 * 用户可见面（工具卡 / 审批卡 / 轨迹页）显示的工具名：元工具在 `call` 时换成**被调用的真实工具名**
 * `mcp__<server>__<tool>`，而不是元工具名。
 *
 * 为什么必须换（round 75）：渲染端按工具名判"审批记忆的粒度"（`approval.ts` 的会话记忆 = 对话 ×
 * 工具 × 工作区），不换的话用户对某个只读工具的"本会话允许"会落到 `mcp__x__meta` 上 ——
 * 之后**这个服务的任何**调用都被客户端自动放行，粒度从"某个工具"塌成"某个服务"。
 * 非元工具 / 不是 call / 形状不对 → 原样返回（认不出就不猜）。
 */
export function resolveMcpToolCallName(toolName: string, input: unknown): string {
  const meta = parseMcpMetaToolName(toolName)
  if (meta === null) return toolName
  const call = mcpMetaCallOf(input)
  return call === null ? toolName : mcpToolName(meta.serverId, call.tool)
}

/** 与 `resolveMcpToolCallName` 配套：元工具调用的**真实入参**（`call.args`）；不是元工具调用原样返回。
 *  渲染端拿它算目标（path / cwd / save_to）、做 diff、判危险档 —— 元工具那层壳对用户是透明的。 */
export function resolveMcpToolCallInput(toolName: string, input: unknown): unknown {
  const meta = parseMcpMetaToolName(toolName)
  if (meta === null) return input
  const call = mcpMetaCallOf(input)
  return call === null ? input : call.args
}

/**
 * 展示名（round 14 用户实拍）：`mcp__<serverId>__<tool>` → 「<服务名> · <工具名>」——
 * 用户注册 MCP 时取了名字，界面上不该露出内部 id（`mcp__mcp-1__search`）。
 * 不是 MCP 名 / 列表里找不到该 server → 原样返回（认不出就不猜）。
 */
export function formatToolName(
  toolName: string,
  servers: ReadonlyArray<{ id: string; name: string }>
): string {
  const parsed = parseMcpToolName(toolName)
  if (parsed === null) return toolName
  const server = servers.find((candidate) => candidate.id === parsed.serverId)
  if (server === undefined) return toolName
  return `${server.name} · ${parsed.tool}`
}

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
    problems.push(...keyValueProblems('环境变量', server.env))
  } else {
    const url = (server.url ?? '').trim()
    if (url === '') problems.push('HTTP 服务需要填写地址')
    else if (!isHttpUrl(url)) problems.push(URL_PROBLEM)
    problems.push(...keyValueProblems('Header', server.headers, true))
  }
  return problems
}

const KEY_VALUE_NEWLINE = /[\r\n]/

/**
 * 键值表（headers / env）的人话校验（round 9）：空名、换行、以及 headers 的重名。
 * 换行是硬拦：HTTP 头里塞 CRLF 就是头注入；env 里塞换行也可能把子进程环境解析带歪。
 * headers 重名按**大小写不敏感**判（HTTP 头名不区分大小写，两个 `Authorization` 只会互相打架）。
 */
function keyValueProblems(
  label: 'Header' | '环境变量',
  record: Record<string, string> | undefined,
  checkDuplicates = false
): string[] {
  if (record === undefined) return []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(record)) {
    const trimmed = name.trim()
    if (trimmed === '') problems.push(`${label}名称不能为空`)
    if (KEY_VALUE_NEWLINE.test(name) || KEY_VALUE_NEWLINE.test(value)) {
      problems.push(`${label}不能包含换行`)
    }
    if (checkDuplicates && trimmed !== '') {
      const key = trimmed.toLowerCase()
      if (seen.has(key)) problems.push(`${label}重复：${trimmed}`)
      seen.add(key)
    }
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

/**
 * JSON 导入（round 9，用户实拍）：用户从别处（Claude Desktop / Cursor 等）复制的
 * `{"mcpServers": {...}}` 整段，或单个 server 对象（带 `url` / `command` 者），
 * 直接转成配置列表。**纯函数**：不合法就 throw 一句人话（调用方行内展示、保留输入）。
 *
 * 映射口径（brief 定案）：
 *   - id = 键规范化（小写、非法字符→`-`、截 32 位）；规范化后没有可用字符或重名
 *     （含 existing 与批内）→ 依次退到 `mcp-N`（沿用 MCP_ID_PREFIX 风格、保证唯一）；
 *   - type：`http`/`streamable-http`/`streamablehttp` → http（url 必须过 isHttpUrl）；
 *     `stdio` 或带 `command` → stdio（command 必填）；`sse` 明确报错（不静默当 http）；
 *   - headers / env 值为 string（数字 / 布尔→String 容忍）；args 给 string 也容忍成单元素；
 *   - 其余未知字段忽略；每条以 `enabled: false, readOnlyTools: []` 落地（与手动新增同口径）。
 */
export function parseMcpServersJson(
  text: string,
  existing: readonly McpServerConfig[]
): McpServerConfig[] {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('粘贴的内容是空的')

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('不是合法的 JSON，请检查粘贴内容')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('要贴一个对象：{"mcpServers": {...}} 或单个服务的配置')
  }

  const root = parsed as Record<string, unknown>
  const entries: Array<[string, Record<string, unknown>]> = []
  if (root.mcpServers !== undefined) {
    const map = root.mcpServers
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      throw new Error('mcpServers 要是一个对象（服务名 → 配置）')
    }
    for (const [name, value] of Object.entries(map)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${name.trim() === '' ? '（未命名）' : name.trim()}：配置要是一个对象`)
      }
      entries.push([name, value as Record<string, unknown>])
    }
  } else if (typeof root.url === 'string' || typeof root.command === 'string') {
    // 单个 server 对象：名字优先级 name 字段 > 默认
    const name =
      typeof root.name === 'string' && root.name.trim() !== '' ? root.name.trim() : 'MCP 服务'
    entries.push([name, root])
  } else {
    throw new Error('没认出可导入的服务：给 {"mcpServers": {...}}，或一个带 url / command 的对象')
  }
  if (entries.length === 0) throw new Error('mcpServers 里没有服务')

  const used = new Set(existing.map((server) => server.id))
  return entries.map(([name, raw]) => convertImportedEntry(name, raw, used))
}

/**
 * 键 → id：规范化后可用且不重名就用它，否则退 `mcp-N`（唯一）。
 * round 65 从内部函数改成导出：agent 侧的 add_mcp_server 也按同一口径给"没给 id"的服务命名 ——
 * 界面导入与模型写入两条路共用一个实现。
 */
export function claimMcpId(name: string, used: Set<string>): string {
  const candidate = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 32)
  // 「有用字符」：格式化后至少得留下一个字母/数字，否则 "--" 这种没法读的 id 不如直接退 mcp-N
  if (/[a-z0-9]/.test(candidate) && MCP_ID_PATTERN.test(candidate) && !used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let index = 1
  while (used.has(`${MCP_ID_PREFIX}${index}`)) index += 1
  const fallback = `${MCP_ID_PREFIX}${index}`
  used.add(fallback)
  return fallback
}

function importedValue(
  raw: unknown,
  label: string,
  field: 'headers' | 'env'
): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label}：${field} 要是一个对象`)
  }
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') record[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') record[key] = String(value)
    else throw new Error(`${label}：${field} 的值「${key}」要是字符串`)
  }
  return Object.keys(record).length === 0 ? undefined : record
}

function importedArgs(raw: unknown, label: string): string[] {
  if (raw === undefined) return []
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) return [...raw]
  throw new Error(`${label}：args 要是字符串数组`)
}

function convertImportedEntry(
  name: string,
  raw: Record<string, unknown>,
  used: Set<string>
): McpServerConfig {
  const label = name.trim() === '' ? '（未命名）' : name.trim()
  // 显式标类型：TS 只对"具名类型标注的 never 函数"做控制流收窄（下面 fail() 之后不认为继续）
  const fail: (detail: string) => never = (detail) => {
    throw new Error(`${label}：${detail}`)
  }

  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : undefined
  let transport: 'stdio' | 'http'
  if (type === undefined) {
    if (typeof raw.url === 'string') transport = 'http'
    else if (typeof raw.command === 'string') transport = 'stdio'
    else fail('缺少 url 或 command，认不出是 HTTP 还是 stdio 服务')
  } else if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp') {
    transport = 'http'
  } else if (type === 'stdio') {
    transport = 'stdio'
  } else if (type === 'sse') {
    fail('sse 暂不支持，请填 Streamable HTTP 地址')
  } else {
    fail(`不认识的 type：${type}`)
  }

  const id = claimMcpId(name, used)
  if (transport === 'http') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    const headers = importedValue(raw.headers, label, 'headers')
    if (!isHttpUrl(url)) fail('url 不是完整的 http(s) 地址')
    return {
      id,
      name: label,
      transport: 'http',
      url,
      ...(headers === undefined ? {} : { headers }),
      enabled: false,
      readOnlyTools: []
    }
  }

  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (command === '') fail('缺少 command（stdio 服务要填启动命令）')
  const env = importedValue(raw.env, label, 'env')
  return {
    id,
    name: label,
    transport: 'stdio',
    command,
    args: importedArgs(raw.args, label),
    ...(env === undefined ? {} : { env }),
    enabled: false,
    readOnlyTools: []
  }
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
