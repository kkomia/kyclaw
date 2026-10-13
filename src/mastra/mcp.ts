/**
 * MCP 外部工具接入（T12）：@mastra/mcp 的 MCPClient 封装 + 工具命名 + 权限 gate 接线。
 *
 * 三件事：
 *   1. **命名**：工具在 agent 里叫 `mcp__<serverId>__<tool>`（brief 的契约）。@mastra/mcp 自己的
 *      命名是 `serverId_toolName`，这里统一换成带 `__` 的名字，和内置工具一眼分得开、也不跟内置名撞。
 *      `parseMcpToolName` 是反向解析（取第一个 `__` 当分隔；server id 的 schema 里不含 `__`）。
 *   2. **分级**（`createMcpClassify`）：MCP 工具**未标记只读一律按写类**（"写类"= 默认询问档）——
 *      只有用户在设置里对某个工具勾了"只读"，它才是 read 档；名字像 read 不算数（外部工具的行为
 *      我们没法靠名字相信）。**最终要不要弹卡由 guard.needsApproval 判**：round 36 起写类的外部
 *      工具与 bash/fetch 同一套 full 判定（工作区「完全访问」→ 免审）。
 *      末段是 delete/move 的仍保留"危险类"这一保守信号（永远问，连"永久允许"也放不倒它）。
 *   3. **连接与错误分类**：stdio / Streamable HTTP 两种 server 定义；`testMcpServer` 连接 + 列工具，
 *      失败归到"启动失败 / 握手超时 / 服务没正常响应"三类（UI 行内提示、日志都用同一句）。
 *
 * 本模块不持有状态（生命周期与缓存见 main/mcp/lifecycle.ts）；Mastra 系依赖 ESM-only、
 * 主进程产物是 CJS，所以运行期对象一律动态 import()，静态 import 只拿类型。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../shared/zod'
import { classifyToolCall, type ToolClass } from '../main/permission/classify'
import { approvalSessionOf, type ToolClassifier } from './tools/guard'
import type { McpServerConfig } from '../shared/settings'
import {
  isHttpUrl,
  mcpMetaToolName,
  MCP_TOOL_PREFIX,
  mcpToolName,
  parseMcpToolName,
  URL_PROBLEM,
  type McpFailureKind,
  type McpTestResult,
  type McpToolInfo
} from '../shared/mcp'
import type { MastraMCPServerDefinition } from '@mastra/mcp'
import type { NeedsApprovalContext } from '@mastra/core/tools'

/** 工具名的拼装/解析实现在 shared/mcp.ts（round 14 搬过去给渲染端复用）；这里 re-export 保持既有调用方 */
export { MCP_TOOL_PREFIX, mcpToolName, mcpMetaToolName, parseMcpToolName }

/** 运行期请求超时（stdio 的**连接握手与每次请求共用一个旋钮**——见 serverDefinition；
 *  库没有给 stdio 单独的 connectTimeout（类型里是 never），所以这一档同时是慢调用上限） */
export const MCP_TIMEOUT_MS = 30_000

/**
 * "测试连接"的超时（round 11：15s → 60s）：首次冷启动实测 ~26s（npx 现下载包 + 建缓存），
 * 15s 会在缓存冷的时候误报「连接超时」（用户实拍：App 里失败、脚本直连同一命令成功）。
 * 60s 覆盖冷启动；成功一次后缓存就热了，之后的连接都在 10s 内。
 */
export const MCP_TEST_TIMEOUT_MS = 60_000

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

/**
 * 配置 → @mastra/mcp 的 server 定义（transport 自动按 command/url 识别）。
 * `timeoutMs` 进 server 配置的 `timeout`：stdio 与 HTTP 都**约束连接握手**；
 * 运行期每次请求（listTools / callTool）也复用它。stdio 没有独立的 connectTimeout
 * （`StdioServerDefinition.connectTimeout` 是 never），所以 stdio 的连接容忍与调用上限
 * 只能同增同减 —— 运行期保持 30s 的理由见 `MCP_TIMEOUT_MS` 的注释。
 */
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

/** 工具调用的审批判定入口（agent 装配把它接到 guard.needsApproval 上）。
 *  `session` = 审批回调里取到的线程 id（round 46，见 guard.approvalSessionOf）；缺省 = 回调里
 *  拿不到会话，按老口径（整份授权列表）判——与内置工具同一条规则。 */
export type McpToolGate = (tool: string, input: unknown, session?: string) => boolean

/** MCP 结果的尺寸护栏上限（字符；round 62 效率复盘，见 capMcpText 的成因注释） */
export const MCP_RESULT_MAX_CHARS = 120_000
/** 截断时保留的尾部字符数（结尾常带结论/错误码） */
const MCP_RESULT_TAIL_CHARS = 15_000

/**
 * 单条 MCP 结果的尺寸护栏（round 62 效率复盘）：实测爬网页/知识库类工具单条可回 6 万字符级文本，
 * 多步回合里这些结果层层累积，出现 40–70 万 token 的巨轮（langfuse 数据）。超过上限时保留
 * **首尾**、中段截去并留一句给模型看的说明——与 bash 的首尾截断同一套取舍。
 *
 * 保守边界：只动可识别的文本形态（string / `{ content: [{ type:'text', text }] }`），
 * 其它形状（图片块、结构化对象）原样放行——护栏不重写语义。
 */
export function capMcpText(text: string): string {
  if (text.length <= MCP_RESULT_MAX_CHARS) return text
  const head = text.slice(0, MCP_RESULT_MAX_CHARS - MCP_RESULT_TAIL_CHARS)
  const tail = text.slice(-MCP_RESULT_TAIL_CHARS)
  return `${head}\n\n…（结果过长：中间 ${text.length - head.length - tail.length} 字符已截去；需要完整内容请分段获取）\n\n${tail}`
}

export function capMcpResult(result: unknown): unknown {
  if (typeof result === 'string') return capMcpText(result)
  if (typeof result !== 'object' || result === null) return result
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return result
  let changed = false
  const next = content.map((item) => {
    if (typeof item !== 'object' || item === null) return item
    const entry = item as { type?: unknown; text?: unknown }
    if (entry.type !== 'text' || typeof entry.text !== 'string') return item
    const capped = capMcpText(entry.text)
    if (capped === entry.text) return item
    changed = true
    return { ...entry, text: capped }
  })
  return changed ? { ...(result as object), content: next } : result
}

/**
 * listToolsets 的结果 → agent 的工具表：只取**启用中**的 server；命名 `mcp__<server>__<tool>`；
 * 每个工具挂上同一个权限 gate（requireApproval，走 guard.needsApproval —— 和内置工具一条路）。
 *
 * `enabled: false` 的 server 在这里被滤掉 = **工具定义不进模型请求**（它同时也不进连接配置，
 * 见 main/mcp/lifecycle.ts 的 `enabled()`；round 71 实测：停用的 stdio server 连子进程都没起）。
 * 两道闸门是刻意的：这里是纯函数，调用方可能直接递整份设置，不能指望每处都记得先滤。
 * 这一档省的是真的钱：实测一台 11 个工具的 MCP server，工具定义 ≈5.2k 字符 ≈2k token/轮，
 * 与任务无关时 100% 白给——所以"停用"必须真的停用，不是只标个状态。
 *
 * 直接改 @mastra/mcp 造出来的 Tool 实例（和该库自己挂 `needsApprovalFn` 的手法一致）：
 * id 改成 `__` 命名（Tool Search 之类的按 id 索引的地方也一致），审批判定换成我们的 gate。
 *
 * **顺序是确定的（round 70）**：MCP 协议不保证 `tools/list` 的顺序，而工具表的顺序就是模型请求
 * 的**前缀**——前缀一变，prompt cache 整体失效。所以这里一律按名字（= `mcp__<serverId>__<tool>`，
 * server id 里不含 `__`，故字典序即"先 server 后工具"）排序后再交出去；agent 装配那一层还会
 * 再排一次（`mcpTools` 是可注入的，顺序不该依赖给它的那份实现）。
 */
export function collectMcpTools(options: {
  toolsets: Record<string, Record<string, Tool>>
  servers: readonly McpServerConfig[]
  gate: McpToolGate
}): Record<string, Tool> {
  const collected: Array<[string, Tool]> = []

  for (const server of options.servers) {
    if (!server.enabled) continue
    const tools = options.toolsets[server.id]
    if (tools === undefined) continue

    for (const [toolName, tool] of Object.entries(tools)) {
      const name = mcpToolName(server.id, toolName)
      tool.id = name
      tool.requireApproval = true
      // round 46：core 把审批上下文摊平后作为第二参交给 needsApprovalFn（`{ args, requestContext,
      // workspace }`，见 guard.approvalSessionOf 头注），线程 id 在 requestContext 里 —— 取出来
      // 透传给 gate，让"没有显式目标"的 MCP 工具也能按会话根判 full（老口径：拿不到就整份列表）
      tool.needsApprovalFn = (args: unknown, approval?: NeedsApprovalContext) =>
        options.gate(name, args, approvalSessionOf(approval))
      // round 62：结果尺寸护栏——原 execute 的结果过一遍 capMcpResult（只在超限时动文本形态）
      const originalExecute = tool.execute
      if (typeof originalExecute === 'function') {
        tool.execute = (async (...args: Parameters<typeof originalExecute>) =>
          capMcpResult(await originalExecute(...args))) as typeof tool.execute
      }
      collected.push([name, tool])
    }
  }

  // 名字唯一（带 serverId），排序不会撞名；默认 sort 即码元字典序
  collected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(collected)
}

// ---------------------------------------------------------------------------
// 渐进披露（round 75）：大 server 换成"每 server 一个元工具"
// ---------------------------------------------------------------------------

/**
 * 逐件注入的上限：一个启用中的 server 暴露的工具**不超过**这个数就直接注入，超过就换成元工具。
 *
 * 依据（实测，见 `_r75-mcp-pd/_r75-summary.json`）：kybase 11 件 ≈5.2k 字符 ≈2k token/轮；
 * 一件 MCP 工具的定义平均 ≈470 字符（≈170 token），而元工具自身（描述 + schema）≈700 字符。
 * 所以"省下的前缀"在 n ≈ 1.5 件时就追平元工具本身的开销，真正的代价是**用时多一次往返**
 * （`list` 那一步 + 它自己那一轮模型调用）。小 server 逐件注入 = 用几百字符换掉一次往返，
 * 更快也更不容易让模型找不着工具；大 server 才值得换。阈值可调（McpLifecycle 的 inlineToolThreshold）。
 */
export const MCP_INLINE_TOOL_THRESHOLD = 3

/** 元工具描述里最多列几个工具名（超了只列前 N 个；清单本身用 action:"list" 拿） */
const MCP_META_DESCRIPTION_MAX_NAMES = 24

/** 一个 server 的工具多到这个数，list 只给"名字 + 参数"（每行的说明省掉，防巨型服务把一次性开销做成巨卡） */
const MCP_META_LIST_PLAIN_MAX_TOOLS = 80

/** list 里每件工具那行说明保留多少字符（一行，够模型判断要不要用） */
const MCP_META_LINE_DESCRIPTION_CHARS = 60

/**
 * 元工具的入参（**形状固定**，与 server 有几件工具无关 —— 前缀稳定才谈得上省）：
 *   - `action:"list"`：拿这个 server 的工具清单（名字 + 一行 + 参数名与类型 + 审批档）；
 *   - `action:"call"` + `tool` + `args`：调用其中一件，入参交给**真实 schema** 校验。
 * `args` 宽松收（`unknown`）：模型把它写成字符串 / 缺省 / null 时，我们归一后回一句人话，
 * 而不是让框架的 schema 校验把整轮打成工具错误。
 */
export const mcpMetaInputSchema = z.object({
  action: z
    .enum(['list', 'call'])
    .describe(
      "list: this MCP server's tools (names, parameters, approval class). call: run one of them."
    ),
  tool: z
    .string()
    .optional()
    .describe('with action="call": the exact tool name shown by action="list"'),
  args: z
    .unknown()
    .optional()
    .describe(
      'with action="call": the arguments object for that tool, keyed by the names action="list" shows'
    )
})

export type McpMetaInput = z.infer<typeof mcpMetaInputSchema>

/** 工具名 → 参数表：`query: string, kb_id?: string`（`?` = 选填；认不出的类型写 any） */
export function parametersText(schema: unknown): string {
  const root = asRecord(schema)
  const properties = asRecord(root?.properties) ?? {}
  const required = new Set(
    Array.isArray(root?.required) ? root.required.filter((item) => typeof item === 'string') : []
  )
  return Object.entries(properties)
    .map(([name, value]) => `${name}${required.has(name) ? '' : '?'}: ${typeText(value)}`)
    .join(', ')
}

function typeText(schema: unknown): string {
  const record = asRecord(schema)
  if (record === null) return 'any'
  if (Array.isArray(record.enum)) return record.enum.map((value) => JSON.stringify(value)).join('|')
  const type = record.type
  if (typeof type === 'string') return type === 'array' ? `${typeText(record.items)}[]` : type
  if (Array.isArray(type)) return type.filter((item) => typeof item === 'string').join('|')
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = record[key]
    if (Array.isArray(branches) && branches.length > 0) {
      return [...new Set(branches.map((branch) => typeText(branch)))].join('|')
    }
  }
  return 'any'
}

/**
 * 一件工具的入参 JSON Schema。真件是 @mastra/mcp 造的 `JsonSchemaWrapper`
 * （`~standard.jsonSchema.input()` 给回 JSON Schema，`~standard.validate` 用 Ajv 校验）；
 * 认不出形状（测试桩、别的实现）回 null —— 调用方不猜，退回"交给服务端校验"。
 */
function inputSchemaOf(tool: unknown): Record<string, unknown> | null {
  const schema = asRecord(asRecord(tool)?.inputSchema)
  if (schema === null) return null
  const standard = asRecord(schema['~standard'])
  const jsonSchema = asRecord(standard?.jsonSchema)
  if (typeof jsonSchema?.input === 'function') {
    try {
      const produced = (jsonSchema.input as (options: unknown) => unknown)({
        target: 'draft-2020-12'
      })
      const record = asRecord(produced)
      if (record !== null) return record
    } catch {
      // 落回下面的 getSchema
    }
  }
  if (typeof schema.getSchema === 'function') {
    try {
      const record = asRecord((schema.getSchema as () => unknown)())
      if (record !== null) return record
    } catch {
      // 认不出就不猜
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 工具自己的描述（@mastra/mcp 给的是 server 里那份 description；缺省空串） */
function descriptionOf(tool: unknown): string {
  const description = asRecord(tool)?.description
  return typeof description === 'string' ? description : ''
}

/** 单行化 + 截断（list 里每行只占一行，模型扫得快） */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 审批档的中文标记（与真实工具名走同一把尺：只读标记 / 危险档优先，见 classifyMcpToolCall） */
function classLabel(toolClass: ToolClass): string {
  if (toolClass === 'read') return '只读'
  return toolClass === 'dangerous' ? '危险' : '需批准'
}

/** 每件工具一行：`- search(query: string, kb_id?: string) [只读] — 在知识库中检索原文` */
function listLine(fullName: string, tool: Tool, toolClass: ToolClass): string {
  const name = parseMcpToolName(fullName)?.tool ?? fullName
  const description = oneLine(descriptionOf(tool), MCP_META_LINE_DESCRIPTION_CHARS)
  const tail = description === '' ? '' : ` — ${description}`
  return `- ${name}(${parametersText(inputSchemaOf(tool))}) [${classLabel(toolClass)}]${tail}`
}

/** 元工具的描述：**这台机器装了哪些 MCP server、要用就先 list**（不许让模型以为没有 MCP 工具） */
function metaDescription(server: McpServerConfig, names: readonly string[]): string {
  const shown = names.slice(0, MCP_META_DESCRIPTION_MAX_NAMES)
  const more = names.length > shown.length ? ` …(+${names.length - shown.length} more)` : ''
  const count = `${names.length} tool${names.length === 1 ? '' : 's'}`
  const transport = server.transport === 'stdio' ? 'stdio' : 'HTTP'
  return (
    `Entry to the MCP server "${server.name}" (${transport}, ${count}, none of them in your tool list): ` +
    `${shown.join(', ')}${more}. Use this entry whenever a task needs this server: ` +
    `{action:"list"} returns every tool with its parameters and approval class, ` +
    `{action:"call", tool:"<exact name from list>", args:{…}} runs one (arguments are validated against ` +
    `the server's schema, a bad argument comes back as a fixable error instead of running). ` +
    `Every MCP server on this machine is exposed through an entry shaped like this one.`
  )
}

/** 元工具的清单正文（构建时算一次，调用时原样回） */
function metaListText(
  server: McpServerConfig,
  entries: ReadonlyArray<{ name: string; tool: Tool; toolClass: ToolClass }>
): string {
  const plain = entries.length > MCP_META_LIST_PLAIN_MAX_TOOLS
  const lines = entries.map((entry) =>
    plain
      ? `- ${entry.name}(${parametersText(inputSchemaOf(entry.tool))}) [${classLabel(entry.toolClass)}]`
      : listLine(mcpToolName(server.id, entry.name), entry.tool, entry.toolClass)
  )
  return capMcpText(
    `${server.name}（MCP 服务 · ${server.transport === 'stdio' ? 'stdio' : 'HTTP'}）：${entries.length} 个工具。` +
      `标记 [只读] 的调用前不弹审批，[需批准] 的先弹卡，[危险] 的每次都问。\n` +
      `${lines.join('\n')}\n` +
      `调用：{"action":"call","tool":"<上面的名字>","args":{…}}` +
      (plain
        ? `\n（工具太多，这里只给名字与参数；要更长的说明就直接 call 一次，参数不对会回错误）`
        : '')
  )
}

/**
 * 入参校验（用**真实 schema**，与逐件注入时框架走的是同一份）：
 * 认不出 schema / 校验器坏了 → null（不拦，交给服务端）；不合法 → 结构化的错误条目。
 */
async function validateArgs(
  tool: Tool,
  args: unknown
): Promise<Array<{ path: string; message: string }> | null> {
  const schema = asRecord(asRecord(tool)?.inputSchema)
  const standard = asRecord(schema?.['~standard'])
  const validate = standard?.validate
  if (typeof validate !== 'function') return null

  try {
    const outcome = asRecord(await (validate as (value: unknown) => unknown).call(standard, args))
    if (outcome === null || outcome.issues === undefined) return null
    const issues = Array.isArray(outcome.issues) ? outcome.issues : []
    return issues.map((issue) => {
      const record = asRecord(issue)
      const path = Array.isArray(record?.path)
        ? record.path.map((part) => String(part)).join('/')
        : ''
      return {
        path: path === '' ? '/' : `/${path}`,
        message: typeof record?.message === 'string' ? record.message : '参数不合法'
      }
    })
  } catch (error) {
    // 校验器自己炸了（schema 复杂度过高、Ajv 编译失败…）：不当"参数错"，交给服务端判
    return [
      {
        path: '/',
        message: `校验器不可用：${error instanceof Error ? error.message : String(error)}`
      }
    ]
  }
}

/**
 * 真工具结果的模型可见形态：@mastra/mcp 给带 outputSchema 的工具挂了 `toModelOutput`
 * （把 MCP 的 content 取成纯文本），core 在提交结果时调它。元工具替模型"转一手"时要照做，
 * 否则这类工具的结果会从"纯文本"退回成一坨 CallToolResult 信封（kybase 的 search 就是这种）。
 * 认不出的映射形状 / 映射抛错 → 原样交出去（不猜）。
 */
async function modelFacingOutput(tool: Tool, output: unknown): Promise<unknown> {
  const map = asRecord(tool)?.toModelOutput
  if (typeof map !== 'function' || output === null || output === undefined) return output
  try {
    const mapped = asRecord(await (map as (value: unknown) => unknown).call(tool, output))
    if (
      mapped !== null &&
      (mapped.type === 'text' || mapped.type === 'json') &&
      'value' in mapped
    ) {
      return mapped.value
    }
  } catch {
    // 映射坏了不影响结果本身
  }
  return output
}

/** 归一 `args`：对象原样、字符串试 JSON、null/缺省当空对象（模型三种写法都见过） */
function normalizeArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return {}
    try {
      const parsed = JSON.parse(trimmed)
      return parsed
    } catch {
      return raw
    }
  }
  return raw
}

export interface McpToolTableOptions {
  /** 逐件真工具（collectMcpTools 的产物：已命名、已挂 gate 与结果护栏、通常也已挂崩溃监督） */
  collected: Record<string, Tool>
  /** 现读的 server 列表（用 name / readOnlyTools / enabled；enabled 的才出工具） */
  servers: readonly McpServerConfig[]
  /** 审批判定入口（cp = guard.needsApproval）：元工具按**真实工具名 + 真实入参**过它 */
  gate: McpToolGate
  /** 逐件注入的上限（缺省 MCP_INLINE_TOOL_THRESHOLD）；0 = 一律用元工具，Infinity = 一律逐件 */
  threshold?: number
}

/**
 * 逐件工具表 → **注入 agent 的工具表**（渐进披露）：一个 server 的工具多于 `threshold` 时，
 * 那些逐件定义不进工具表，换成一个元工具 `mcp__<serverId>__meta`。
 *
 * 语义不变的部分（都是刻意的）：
 *   - **审批**：元工具的 `call` 走 `gate(mcp__<server>__<真实工具>, 真实入参, 会话)` ——
 *     与逐件注入时**逐字同一条路**（读/写/危险三档、工作区 full 免审、"永久允许"规则、
 *     危险命令红线全在原处判）；`list` 零副作用，按只读免问；
 *   - **结果**：真工具那层 execute 已经带 `capMcpResult` 护栏与生命周期崩溃监督，元工具只是
 *     转调用它（`tool.execute` 现取，拿到的是包装后的那一层），护栏与"暂停使用"照旧；
 *   - **名字**：真工具名仍是 `mcp__<server>__<tool>`（审批规则、渲染端展示都用它）。
 *
 * 不走元工具的两种情况：工具数 ≤ threshold（小 server，省一次往返）；该 server 真有个叫
 * `meta` 的工具（不夺名，退回逐件）。
 */
export async function buildMcpToolTable(
  options: McpToolTableOptions
): Promise<Record<string, Tool>> {
  const threshold = Math.max(0, options.threshold ?? MCP_INLINE_TOOL_THRESHOLD)
  const byServer = new Map<string, Array<[string, Tool]>>()
  const unowned: Array<[string, Tool]> = []

  for (const [name, tool] of Object.entries(options.collected)) {
    const parsed = parseMcpToolName(name)
    const server =
      parsed === null ? undefined : options.servers.find((entry) => entry.id === parsed.serverId)
    if (parsed === null || server === undefined) {
      unowned.push([name, tool])
      continue
    }
    const list = byServer.get(server.id) ?? []
    list.push([name, tool])
    byServer.set(server.id, list)
  }

  const table: Record<string, Tool> = {}
  const enabled = options.servers
    .filter((server) => server.enabled)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const server of enabled) {
    // collectMcpTools 已按整名排过序，这里再做一次：本函数是导出的纯函数，不依赖调用方那份实现
    const entries = (byServer.get(server.id) ?? []).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (entries.length === 0) continue

    const metaName = mcpMetaToolName(server.id)
    const collides = entries.some(([name]) => name === metaName)
    if (entries.length <= threshold || collides) {
      for (const [name, tool] of entries) table[name] = tool
      continue
    }
    table[metaName] = await createMcpMetaTool(server, entries, options)
  }

  for (const [name, tool] of unowned) table[name] = tool
  return table
}

/** 造一个 server 的元工具（`mcp__<serverId>__meta`） */
async function createMcpMetaTool(
  server: McpServerConfig,
  entries: ReadonlyArray<[string, Tool]>,
  options: McpToolTableOptions
): Promise<Tool> {
  const { createTool } = await import('@mastra/core/tools')

  const tools = new Map<string, Tool>()
  const described: Array<{ name: string; tool: Tool; toolClass: ToolClass }> = []
  for (const [fullName, tool] of entries) {
    const name = parseMcpToolName(fullName)?.tool ?? fullName
    tools.set(name, tool)
    described.push({ name, tool, toolClass: classifyMcpToolCall(fullName, {}, options.servers) })
  }
  const names = described.map((entry) => entry.name)
  const listText = metaListText(server, described)

  const tool = createTool({
    id: mcpMetaToolName(server.id),
    description: metaDescription(server, names),
    inputSchema: mcpMetaInputSchema,
    // 与逐件注入同口径：兜底"要问"，真正的档由下面的 needsApprovalFn 按真实工具名判
    requireApproval: true,
    execute: async (input: unknown, context: unknown) => {
      const record = asRecord(input)
      if (record === null)
        return `用法：{"action":"list"} 或 {"action":"call","tool":"…","args":{…}}`
      if (record.action !== 'call') return listText

      const name = typeof record.tool === 'string' ? record.tool.trim() : ''
      const target = tools.get(name)
      if (target === undefined) {
        return (
          `「${server.name}」没有叫「${name === '' ? '(空)' : name}」的工具。现有：${names.join('、')}\n` +
          `用 {"action":"list"} 看它们的参数。`
        )
      }

      const args = normalizeArgs(record.args)
      const problems = await validateArgs(target, args)
      if (problems !== null) {
        const shown = problems
          .slice(0, 12)
          .map((problem) => `- ${problem.path}：${problem.message}`)
          .join('\n')
        return (
          `参数没通过校验，**工具没有被调用**：${name}\n${shown}\n` +
          `参数表：${parametersText(inputSchemaOf(target)) || '(无)'}\n` +
          `改好 args 后重试（也可以先 {"action":"list"} 看每个参数的含义）。`
        )
      }

      const execute = asRecord(target)?.execute
      if (typeof execute !== 'function') {
        return `「${server.name}」的 ${name} 现在不能调用（这条定义没有 execute）。`
      }
      // 执行错误照旧抛（工具卡显示"出错"、生命周期的崩溃监督照旧记一次重启）——只有校验错误回文本
      const output = await (execute as (input: unknown, context: unknown) => Promise<unknown>).call(
        target,
        args,
        context
      )
      return await modelFacingOutput(target, output)
    }
  })

  // `createTool` 的入参类型里没有 needsApprovalFn（和 @mastra/mcp 一样，造完再挂）——
  // core 的审批判定在调用时现读这个字段（getNeedsApprovalFn），所以这一手与逐件注入等价
  ;(tool as unknown as { needsApprovalFn?: unknown }).needsApprovalFn = (
    input: unknown,
    approval?: NeedsApprovalContext
  ): boolean => {
    const record = asRecord(input)
    if (record === null) return true
    // list 只是读清单，零副作用：不问（否则"先看看有什么工具"每轮都要弹一张卡）
    if (record.action === 'list') return false
    const name = typeof record.tool === 'string' ? record.tool.trim() : ''
    // 名字不存在：execute 只回一句"没有这个工具"，没有任何副作用 —— 不为它弹卡
    if (tools.get(name) === undefined) return false
    // 按**真实工具名 + 真实入参**判档：读/写/危险三档、工作区 full 免审、"永久允许"规则、
    // 危险命令红线 —— 与逐件注入时 gate 收到的东西逐字一致
    return options.gate(
      mcpToolName(server.id, name),
      normalizeArgs(record.args),
      approvalSessionOf(approval)
    )
  }

  return tool as unknown as Tool
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

/** 命令的下一步提示（`withName` = 句子里还没出现过命令名时带上「」） */
function pathAdvice(command: string, withName: boolean): string {
  const target = withName ? `「${command}」` : '它'
  return command.includes('/') || command.includes('\\')
    ? `确认${target}存在且能运行`
    : `确认${target}已安装并在 PATH 里，或改用完整路径`
}

/**
 * 连接/列工具失败 → 分类 + 一句人话。`detail` 可以是 @mastra/mcp 的 errorDetails
 * （带机器可读的 code），也可以是任意 Error。
 *
 * `context.command` 是 stdio 的启动命令（调用方从配置带来）：缺命令时库会把 Node 的
 * `spawn xxx ENOENT` 折成通用的 `SdkError: Connection closed`（实测两条路都一样，ENOENT
 * 到不了这里）——那类「连不上」的错误也裹上"确认命令在 PATH 里 / 用完整路径"的下一步。
 */
export function classifyMcpFailure(
  detail: unknown,
  fallbackMessage?: string,
  context?: { command?: string }
): {
  kind: McpFailureKind
  message: string
} {
  const code = errorCode(detail) ?? errorCode(asErrorShape(detail)?.cause)
  const raw = firstLine(errorMessage(detail), 300) || fallbackMessage || '未知原因'
  const configured = context?.command?.trim() ?? ''

  // 命令找不到（Node spawn / cross-spawn 的 ENOENT）：直接给人话 + 怎么办
  if (code === 'ENOENT' || /\bENOENT\b/.test(raw)) {
    const command = /spawn\s+(\S+?)\s+ENOENT/i.exec(raw)?.[1] ?? configured
    return {
      kind: 'spawn',
      message:
        command === ''
          ? '没找到启动命令——确认它已安装并在 PATH 里，或改用完整路径'
          : `没找到启动命令「${command}」——${pathAdvice(command, false)}`
    }
  }

  const kind = code === undefined ? kindOfMessage(raw) : kindOfCode(code)

  if (kind === 'handshake-timeout') return { kind, message: `连接超时：${raw}` }
  if (kind === 'spawn') {
    return {
      kind,
      message:
        configured === ''
          ? `服务没能启动或立刻退出：${raw}`
          : `服务没能启动或立刻退出——${pathAdvice(configured, true)}（原始信息：${raw}）`
    }
  }
  return { kind, message: `服务没有正常响应：${raw}` }
}

function asErrorShape(value: unknown): ErrorShape | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as ErrorShape
}

/**
 * "测试连接"：连上 + 列一次工具，返回延迟与工具清单（UI 用它填"单工具只读"开关）。
 * 每次都是**独立的一次连接**（一次性 client），测完就断——不和 agent 运行期那条连接共用。
 *
 * 停用的 server 照样能测（这正是用户点「启用」前的那一步；round 71 复核的口径）：这一条
 * 与"未启用就不连接/不注入"不冲突——测试是用户显式发起的一次性动作，agent 那条连接不受影响。
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
      return { ok: false, ...classifyMcpFailure(detail, undefined, { command: config.command }) }
    }

    const tools: McpToolInfo[] = Object.entries(toolsets[config.id] ?? {}).map(([name, tool]) => ({
      name,
      description: tool.description ?? ''
    }))
    return { ok: true, latencyMs: Date.now() - startedAt, tools }
  } catch (error) {
    return { ok: false, ...classifyMcpFailure(error, undefined, { command: config.command }) }
  } finally {
    await client?.disconnect().catch(() => {})
  }
}
