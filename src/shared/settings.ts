/**
 * 应用设置（spec §2.1「类型化 IPC（zod + 共享类型）」）：主进程落盘、IPC 入参、渲染端消费共用一份 schema。
 *
 * 落盘在主进程的 userData/settings.json（main/settings.ts），与窗口状态的 window-state.json 分开——
 * 窗口几何是"壳自己的事"，设置是"用户的事"，坏一个不该带走另一个。
 * providers（T8）已落地：元素 schema 在 shared/providers.ts；workspaces（T10）就地定义在下面，
 * 元素的取值只有 path + mode 两个字段；permissions.rules（T13）是审批记忆的"永久允许"；
 * mcpServers（T12）的取值在下面（元素形状 + 缺省），业务校验与路由在 shared/mcp.ts 与
 * mastra/routes/mcp.ts；projects（T18）的元素 schema 在 shared/projects.ts，defaultWorkspace 是
 * 「未指定项目的会话」用的那个默认工作区（地位 = Kimi「其他 → 通用 → 存储位置」）；
 * langfuse（T17）只有服务地址一项——公私钥走 secrets.json（safeStorage）。
 * 追加字段时记得同步 main/settings.ts 的读盘迁移（旧文件补空值）。
 */
import { z } from './zod'
import { providerConfigSchema } from './providers'
import { projectSchema } from './projects'

/** 落盘文件名（userData 下） */
export const SETTINGS_FILE = 'settings.json'

/** 主题模式：跟随系统 / 显式亮色 / 显式暗色（对应 html[data-theme] 的解析结果，见 lib/theme.ts） */
export const themeModeSchema = z.enum(['system', 'light', 'dark'])

/** 字号用户档：整组换值，不做乘法缩放（spec §6.3） */
export const fontTierSchema = z.enum(['small', 'default', 'large'])

/**
 * 授权工作区的访问模式（spec §5.2）：ask = 写类默认询问；full = 这个工作区放行（Full access）。
 * 移动/删除（dangerous）不受 full 影响，永远默认问。
 */
export const workspaceModeSchema = z.enum(['ask', 'full'])

/**
 * 一条授权工作区。path 由主进程经**原生选择器**写入并校验（存在、是目录、非 UNC），见 main/workspace.ts；
 * 渲染端只能在 workspace:* 通道上增删与切模式 —— 补丁 schema 里没有这个字段，防止绕过校验直接写授权列表。
 */
export const workspaceSchema = z.strictObject({
  path: z.string().min(1),
  mode: workspaceModeSchema
})

/**
 * 审批记忆的"永久允许"规则（T13）：某工具（归一后的名字）在某工作区里不再逐次询问。
 * `mode` 目前只有 `allow` 一档（"拒绝"不落盘，那是一次性动作）；危险类工具不受规则影响。
 * 渲染端经 settings:update 整表替换，主进程落盘前会再校验一遍。
 */
export const permissionRuleSchema = z.strictObject({
  tool: z.string().min(1),
  workspace: z.string().min(1),
  mode: z.literal('allow')
})

export const permissionsSchema = z.strictObject({
  rules: z.array(permissionRuleSchema)
})

/**
 * Langfuse 追踪的**非密钥**部分（T17）：只放服务地址。
 * 公私钥与 provider 密钥同待遇——safeStorage 密文落 secrets.json（main/secrets.ts），
 * 所以这里没有它们。三项齐 = 开启导出（缺一不导出、也不报错，见 mastra/telemetry.ts）。
 * 空串 = 没配（默认关），也就是"内容不出机器"的默认姿态（R18 的遥测禁用不受影响）。
 */
export const langfuseSettingsSchema = z.strictObject({
  endpoint: z.string()
})

/**
 * 模型级偏好（round 18）：按 `${providerId}/${model}` 存「思考挡位」与「对话长度百分比」。
 * 缺省 = 默认挡 + 100%；挡位 id 只有注册表（shared/models.ts）里列出的才有意义
 * （无效值在读取侧回落默认，不在这里抛——用户改了模型名，旧偏好不该让整份设置读不出来）。
 */
export const modelPrefsSchema = z.strictObject({
  /** 思考挡位 id（`default` / `low` / `high` / `max`…，见 shared/models.ts） */
  thinkingEffort: z.string().optional(),
  /** 对话长度 = 官方上下文长度 × pct/100（10–100；缺省 100） */
  contextPct: z.number().min(10).max(100).optional()
})

export type ModelPrefs = z.infer<typeof modelPrefsSchema>

/**
 * 探测到的模型元数据（round 22）：`GET {baseUrl}/models` 的实测值，键 = `<providerId>:<modelId>`
 * （provider 的模型名原文，不归一——探测和消费两边同一个键函数 `probedKeyOf`）。
 * 取值优先级 = probed → 注册表 → 默认（见 shared/models.ts）；`fetchedAt` 用于 >24h 过期重抓。
 */
export const probedModelSchema = z.strictObject({
  /** 实测上下文长度（正整数） */
  contextWindow: z.number().int().positive(),
  /** 实测最大输出（存档；暂未参与 UI） */
  maxOutputTokens: z.number().int().positive().optional(),
  /** 实测思考挡位（原样值；空/没有 = 回落注册表） */
  efforts: z.array(z.string().min(1)).optional(),
  /** 实测默认挡位（如 'high'；无效/没有 = `default`） */
  defaultEffort: z.string().min(1).optional(),
  /** ISO 时间串（抓取时刻） */
  fetchedAt: z.string()
})

export type ProbedModel = z.infer<typeof probedModelSchema>

/**
 * 归档项目快照（round 25）：归档 = 侧栏隐藏该项目**及其名下会话**（会话映射照旧，
 * 取消归档项目回来时会话跟着回来）；不删项目、不删磁盘。
 */
export const archivedProjectSchema = z.strictObject({
  projectId: z.string().min(1),
  /** 归档时的显示名（快照） */
  name: z.string().min(1),
  /** 归档时的项目路径（快照；展示用） */
  path: z.string().min(1),
  /** ISO 时间串（归档时刻） */
  archivedAt: z.string()
})

export type ArchivedProject = z.infer<typeof archivedProjectSchema>

/**
 * MCP server 的传输（T12）：stdio 起子进程走 stdio 上的 JSON-RPC；http 连 Streamable HTTP 端点。
 */
export const mcpTransportSchema = z.enum(['stdio', 'http'])

/**
 * 一条 MCP server 配置（T12）。取值刻意放宽到"任何字符串都能存"：停用中的服务允许存半截草稿
 * （命令还没填、地址还没写），**启用**的服务必须完整 —— 那条业务校验在 shared/mcp.ts 的
 * mcpServerProblems（渲染端行内提示 + 路由落盘前拦同一份），schema 只管形状。
 * `readOnlyTools` 是用户对单个工具勾的"只读"标记：勾了才不弹审批，没勾一律按写类询问。
 */
export const mcpServerSchema = z.strictObject({
  /** 稳定标识：进工具名 `mcp__<id>__<tool>`（合法形状见 shared/mcp.ts） */
  id: z.string(),
  /** 界面显示名 */
  name: z.string(),
  transport: mcpTransportSchema,
  /** stdio：启动命令与参数 */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** http：Streamable HTTP 端点地址 */
  url: z.string().optional(),
  /**
   * http：自定义请求头（如 `Authorization`）——透传给 @mastra/mcp 的 `requestInit.headers`
   * （round 9：用户要"定义了 url 之后可以自定义 headers"）。键/值的换行与空名在
   * shared/mcp.ts 的 mcpServerProblems 里拦（HTTP 头注入防线），schema 只管形状。
   */
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * stdio：追加给子进程的环境变量——透传给 @mastra/mcp 的 `StdioServerDefinition.env`
   * （round 9，库已支持）。同样是纯加法字段，老配置文件不受影响。
   */
  env: z.record(z.string(), z.string()).optional(),
  /** 启用中的 server 会随 agent 使用建立连接；停用即断开 */
  enabled: z.boolean(),
  /** 被标记为只读的工具名（server 自己的工具名，不带 mcp__ 前缀） */
  readOnlyTools: z.array(z.string())
})

/**
 * 插件市场（round 10）：一条 = 一个市场来源（git 仓库或本机目录）。
 * 写入只有 `plugins:*` IPC 一条路（与 workspaces 同理：路径/克隆都要过主进程校验，patch schema 里没有）。
 * `path` 是**生效目录**（git = 克隆目录；local = 用户给的目录，原样不动）；`source` 保留用户填的原文（界面显示）。
 */
export const pluginMarketplaceSchema = z.strictObject({
  /** slug（进目录名与插件记录 id；主进程生成） */
  id: z.string().min(1),
  /** 市场显示名（marketplace.json 的 name，读回后落盘） */
  name: z.string().min(1),
  /** 用户填的来源原文（owner/repo、git URL 或本地文件夹） */
  source: z.string().min(1),
  /** git 分支或标签（可选；local 模式无意义） */
  ref: z.string().optional(),
  /** 稀疏路径（每行一条；git 模式生效） */
  sparsePaths: z.array(z.string()).optional(),
  kind: z.enum(['git', 'local']),
  /** 生效目录（绝对路径） */
  path: z.string().min(1),
  addedAt: z.string()
})

/**
 * 已安装插件（round 10）的一条记录：安装时落盘，卸载按它清理。
 * `installDir` 只有"远端 source 克隆到本机"时才有值（卸载要删）；相对 source 的插件住在市场目录里，为 null。
 */
export const installedPluginSchema = z.strictObject({
  /** `<marketplaceId>-<插件slug>`（同一市场内唯一；mcp id / 技能目录名都带它） */
  id: z.string().min(1),
  marketplaceId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  installedAt: z.string(),
  /** 安装时写进 settings.mcpServers 的 id 列表（卸载按它删条目） */
  mcpServerIds: z.array(z.string()),
  /** 复制到 `<userData>/skills/` 下的目录名（卸载按它删目录） */
  skillDirs: z.array(z.string()),
  installDir: z.string().nullable()
})

export type PluginMarketplace = z.infer<typeof pluginMarketplaceSchema>
export type InstalledPlugin = z.infer<typeof installedPluginSchema>

/**
 * 归档记录（round 20）：归档 = 从侧栏移除 + 在这里留一份快照（**不删会话数据**）。
 * 快照里的 title / projectId 是**归档那一刻**的值——会话后来改了标题或挪了项目，
 * 归档列表仍按快照显示（"归档时它是什么样"）；取消归档只是把这条从列表里去掉，
 * 会话本体（服务端线程 + 消息 + 项目映射）原样回侧栏。
 */
export const archivedThreadSchema = z.strictObject({
  threadId: z.string().min(1),
  /** 归档时的标题（还没生成标题时是 null，展示侧回落"新会话"） */
  title: z.string().nullable(),
  /** 归档时所属项目（没有 = null）；展示侧按 id 现查项目名，项目删了就只剩标题 */
  projectId: z.string().nullable(),
  /** ISO 时间串（归档时刻；列表按它倒序） */
  archivedAt: z.string()
})

export type ArchivedThread = z.infer<typeof archivedThreadSchema>

export const appSettingsSchema = z.strictObject({
  theme: themeModeSchema,
  fontTier: fontTierSchema,
  /** T8 的 provider 列表（模型与密钥页；密钥不在里面，见 main/secrets.ts） */
  providers: z.array(providerConfigSchema),
  /** T10 的授权工作区列表（添加/移除/切模式走 workspace:* 通道） */
  workspaces: z.array(workspaceSchema),
  /**
   * T18 的默认工作区：**未指定项目的会话**用它当文件工具的根（见 main/projects.ts 的 sessionRoots）。
   * 存的是 `checkWorkspacePath` 归一后的路径，且一定同时是 workspaces 里的一条（指认时就并进去，
   * 模式 ask —— full 仍然只能由用户在设置页显式切换）；null = 没指认，那种情况下会话的根回退到
   * 整份授权列表（T10 既有口径）。写入只有 workspace:pick-default 一条路（原生选择器）。
   */
  defaultWorkspace: z.string().min(1).nullable(),
  /** T18 的项目列表（增删走 projects:* 通道：路径要先过 checkWorkspacePath） */
  projects: z.array(projectSchema),
  /** T13 的审批记忆规则（审批卡的"永久允许"写这里）；旧落盘文件由 main/settings.ts 补空表 */
  permissions: permissionsSchema,
  /** T12 的 MCP server 列表（增删改走 PUT /api/mcp/servers，见 mastra/routes/mcp.ts） */
  mcpServers: z.array(mcpServerSchema),
  /** round 10 的插件市场列表（增删刷新走 plugins:* 通道） */
  pluginMarketplaces: z.array(pluginMarketplaceSchema),
  /** round 10 的已安装插件记录（安装/卸载走 plugins:* 通道） */
  installedPlugins: z.array(installedPluginSchema),
  /** round 18 的模型级偏好（`${providerId}/${model}` → 思考挡位 / 对话长度百分比；走 settings:update 补丁） */
  modelPrefs: z.record(z.string(), modelPrefsSchema),
  /** round 22 的模型元数据实测缓存（`${providerId}:${model}` → 上下文/挡位；主进程探测，见 main/model-probe.ts） */
  probedModels: z.record(z.string(), probedModelSchema),
  /** round 20 的置顶会话 id 列表（顺序无关；侧栏把置顶的排在时间分组之前，带小图钉标识） */
  pinnedThreads: z.array(z.string().min(1)),
  /** round 25 的置顶项目 id 列表（侧栏项目区里置顶的排前；带小图钉标识） */
  pinnedProjects: z.array(z.string().min(1)),
  /** round 20 的归档快照列表（从侧栏移出、数据不删；设置页「归档」栏查看/搜索/取消归档） */
  archivedThreads: z.array(archivedThreadSchema),
  /** round 25 的归档项目快照（侧栏隐藏该项目及其会话；取消归档一并恢复） */
  archivedProjects: z.array(archivedProjectSchema),
  /** T17 的 Langfuse 追踪（默认关；端点在设置页「追踪」栏填，密钥走 secrets.json） */
  langfuse: langfuseSettingsSchema
})

/**
 * settings:update 的入参形状：只给要改的字段（缺省字段保持原值）。
 * **不含 workspaces**：授权目录的写入必须在主进程过路径校验，不能从渲染端直接改。
 * **不含 defaultWorkspace / projects**：同理 —— 两者的路径都要过 `checkWorkspacePath`（否则
 * 渲染端能塞一个没校验过的根进授权边界），各走自己的通道（workspace:pick-default、projects:*）。
 * **不含 mcpServers**：MCP 配置的写入只有 PUT /api/mcp/servers 一条路（同一条带上
 * "启用必须配置完整"的校验），不另开一条不过校验的口子。
 * **不含 pluginMarketplaces / installedPlugins**：两者都带路径（`path` / `installDir`），
 * 写入只有 `plugins:*` 一条路 —— 直接从渲染端改等于给「移除市场 / 卸载插件」的递归删除递任意目录。
 */
export const appSettingsPatchSchema = appSettingsSchema.partial().omit({
  workspaces: true,
  defaultWorkspace: true,
  projects: true,
  mcpServers: true,
  pluginMarketplaces: true,
  installedPlugins: true
})

export type ThemeMode = z.infer<typeof themeModeSchema>
export type FontTier = z.infer<typeof fontTierSchema>
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type PermissionRule = z.infer<typeof permissionRuleSchema>
export type Permissions = z.infer<typeof permissionsSchema>
export type McpTransport = z.infer<typeof mcpTransportSchema>
export type McpServerConfig = z.infer<typeof mcpServerSchema>
export type LangfuseSettings = z.infer<typeof langfuseSettingsSchema>
export type AppSettings = z.infer<typeof appSettingsSchema>
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  fontTier: 'default',
  providers: [],
  workspaces: [],
  defaultWorkspace: null,
  projects: [],
  permissions: { rules: [] },
  mcpServers: [],
  pluginMarketplaces: [],
  installedPlugins: [],
  modelPrefs: {},
  probedModels: {},
  pinnedThreads: [],
  pinnedProjects: [],
  archivedThreads: [],
  archivedProjects: [],
  langfuse: { endpoint: '' }
}

/** 默认值的新副本（含新数组/新对象）：调用方拿到的对象随便改，不污染模块级默认 */
export function defaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    providers: [],
    workspaces: [],
    projects: [],
    permissions: { rules: [] },
    mcpServers: [],
    pluginMarketplaces: [],
    installedPlugins: [],
    modelPrefs: {},
    probedModels: {},
    pinnedThreads: [],
    pinnedProjects: [],
    archivedThreads: [],
    archivedProjects: [],
    langfuse: { endpoint: '' }
  }
}
