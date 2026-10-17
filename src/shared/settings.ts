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
 * langfuse（T17）是"开关 + 服务地址 + 代理"三项——公私钥走 secrets.json（safeStorage）。
 * 追加字段时记得同步 main/settings.ts 的读盘迁移（旧文件补空值）。
 *
 * round 66：**会话级的状态不放这里**。PPT 模板选择从 `pptTemplate` 挪到了
 * libsql 的 `session_ppt_templates`（见 shared/session-ppt-templates.ts）—— 放全局设置会让新会话
 * 继承别人的选择（用户实报）。同理可见 projects 的会话归属（`session_projects`）。
 */
import { z } from './zod'
import { providerConfigSchema } from './providers'
import { projectSchema } from './projects'
import { rulesTextProblem } from './rules'

export const globalRulesSchema = z.string().superRefine((text, context) => {
  const problem = rulesTextProblem(text, 'global')
  if (problem !== null) context.addIssue({ code: 'custom', message: problem.message })
})
import { DEFAULT_WEB_SEARCH, webSearchSettingsSchema } from './search'

/** 落盘文件名（userData 下） */
export const SETTINGS_FILE = 'settings.json'

/** 主题模式：跟随系统 / 显式亮色 / 显式暗色（对应 html[data-theme] 的解析结果，见 lib/theme.ts） */
export const themeModeSchema = z.enum(['system', 'light', 'dark'])

/** 字号用户档：整组换值，不做乘法缩放（spec §6.3） */
export const fontTierSchema = z.enum(['small', 'default', 'large'])

/**
 * 关闭窗口的偏好（0.1.3 托盘驻留，三档；Windows / Linux 适用）：
 *   - `ask`（默认）：每次点关闭都弹三选一（弹窗里可勾「记住我的选择」落成 tray / quit）；
 *   - `tray`：点关闭直接收进托盘（窗口留着、后台任务继续，从托盘 / 再起一次应用找回）；
 *   - `quit`：点关闭直接退出应用。
 * macOS 不看这一位（关窗沿 Dock 现状）；托盘不可用时 `tray` 也退化成正常关闭
 * （不能把窗口藏到没有找回入口的后台）。
 */
export const CLOSE_TO_TRAY_MODES = ['ask', 'tray', 'quit'] as const

export const closeToTrayModeSchema = z.enum(CLOSE_TO_TRAY_MODES)

/**
 * 访问档位（spec §5.2；round 75 起是**两个独立档位**共用的一个枚举）：
 * ask = 每次询问（默认）；full = 完全访问（**真免审**）。
 *
 * 两个档位：
 *   1. **工作区内**——每个授权工作区自己一条（`workspaceSchema.mode`）。`full` = 这个文件夹里的
 *      写 / 删 / 移 / bash 命令都不再问（`rm -rf` 也不问：这就是「完全访问」的字面意思）；
 *   2. **工作区之外**——`appSettingsSchema.outsideWorkspaceMode` 一条，**默认 ask**。目标是区外
 *      路径（或判不出落在哪）的调用按它判；用户显式设成 full 也是真免审（他设了就照办）。
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
 * Langfuse 追踪的**非密钥**部分（T17；round 67 加代理；round 86 加**显式开关**）：
 *   - `enabled`：显式开关（用户口径 010）—— `false` = 用户明确关掉，一律不导出；
 *   - `endpoint`：实例地址（默认 = 用户现用那台，见 LANGFUSE_PRESET，设置页里随手改）；
 *   - `proxyUrl`：HTTP(S) 代理（空串 = 直连；填了才起作用，也可以改用环境变量兜底）。
 * 公私钥与 provider 密钥同待遇——safeStorage 密文落 secrets.json（main/secrets.ts），
 * 所以这里没有它们。开关开着且三项齐 = 开启导出（缺一不导出、也不报错，见 mastra/telemetry.ts）；
 * 开关关着时即使三项齐全也不导出（判定入口只有 main/telemetry.ts 的 readLangfuseConfig）。
 *
 * 开关的缺省是 **true**（与 semanticRecall.enabled 同一口径）：这个字段是后加的，老落盘文件没有它，
 * 而"没显式关过"就等于开着 —— 迁移（main/settings.ts）只认 `false` 这一种显式关闭，
 * 免得升级一次就把正在上报的老用户静默关掉。真要说"内容不出机器"，靠的仍是"地址与密钥没配齐"。
 */
export const langfuseSettingsSchema = z.strictObject({
  /**
   * 显式开关（round 86）：`false` = 不导出（也不上报任何东西）；缺省与老文件迁移都取 true。
   * 与地址的区别：地址空串是"没配"，这一位是"用户不要"——两者都不导出，但状态行分得清。
   */
  enabled: z.boolean(),
  endpoint: z.string(),
  /**
   * 代理地址（round 67）：形如 `http://127.0.0.1:7890`；没写协议时补 `http://`
   * （归一在 mastra/telemetry.ts 的 normalizeProxyUrl）。空串 = 没配 → 回落
   * `LANGFUSE_PROXY_URL` / `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量。
   */
  proxyUrl: z.string()
})

/**
 * 语义召回（round 28 模块 3；round 58 起按会话隔离）：**本会话**内的向量召回——同一个会话里
 * 早先聊过、已经滑出历史窗口的内容，换个措辞问还能被找回来（Mastra Memory 的 semanticRecall，
 * thread 作用域，见 mastra/index.ts）。跨会话召回不做：开几个会话就是为了隔离上下文。
 *
 * 嵌入接口统一为 **OpenAI 兼容 `/embeddings`**：baseURL + model（+ key）。命名刻意不带 "remote"
 * —— 将来「本机引擎」（llama.cpp 子进程，模块 3B）就长这个样子，接进来时只做两件事：
 *   - 给 `SEMANTIC_RECALL_SOURCES` 加一项 `localEngine`；
 *   - 在 `mastra/embedding.ts` 的工厂里加一个分支（本文件形状不动）。
 *
 * key 与 provider 密钥同待遇：safeStorage 密文落 secrets.json，只回"有没有 / 要不要重录"。
 * 生效时机与 Langfuse 同口径：**装配在服务启动时做**，改这一栏要重启应用才生效
 * （状态行会说清"本次运行开了没有"，见 shared/memory.ts 的 RecallStatus）。
 * 半截配置（缺 baseURL / 模型名 / key）＝ 起不来这一路：照常启动，只是没有召回。
 *
 * 缺省是"开着但没配地址"：状态行会显示未就绪，对话不受影响；用户填好地址保存、重启后生效。
 */
export const SEMANTIC_RECALL_SOURCES = ['remote', 'localEngine'] as const

export const semanticRecallSettingsSchema = z.strictObject({
  /** 总开关（缺省开：会话内的语义召回是这个产品的能力之一；起不来只是没有召回，不拦对话） */
  enabled: z.boolean(),
  /**
   * 嵌入来源：`remote` = 任意 OpenAI 兼容的嵌入服务（baseURL + model + key）；
   * `localEngine` = **本机引擎**（模块 3B 的 llama.cpp 子进程 + 下载到本地的 GGUF）。
   */
  source: z.enum(SEMANTIC_RECALL_SOURCES),
  /** OpenAI 兼容 baseURL（形如 `https://api.openai.com/v1`；本机引擎这一路由主进程自己算，不看它） */
  baseUrl: z.string(),
  /** 嵌入模型名（形如 `text-embedding-3-small`；本机引擎这一路用本地模型 id） */
  model: z.string(),
  /**
   * 本机引擎的空闲回收（分钟）：这段时间没有请求就把引擎进程杀掉（内存 100% 回收），
   * 下次请求再自动拉起来。`0` = 不回收（一直占着内存）。改这个值**当场生效**（引擎现读），
   * 与"改嵌入来源要重启应用"不是一回事。
   */
  idleMinutes: z.number().int().min(0).max(240)
})

export type SemanticRecallSettings = z.infer<typeof semanticRecallSettingsSchema>

export type SemanticRecallSource = SemanticRecallSettings['source']

/**
 * 思考翻译（round 32）：模型的思维链基本是英文，用户看不懂 —— 启用后思考段的显示
 * **先调翻译模型翻一遍再回显**。两种模式：
 *   - `full`  全量翻译（**默认**）：这一段写完就自动翻，默认看到的是译文；
 *   - `button` 翻译按钮：显示原文 + 一个「翻译」，点了才翻。
 * 两者前提一样：**思考的语言与目标语言不一致**（判定见 shared/translate.ts 的 needsTranslation）。
 *
 * 服务是用户局域网里的 OpenAI 兼容端点（llama.cpp，实测 383ms）；地址/模型/目标语言是普通设置，
 * 可选 API Key 走 safeStorage 保留槽位（shared/translate.ts 的 TRANSLATE_KEY_SECRET_ID）。
 * 生效时机：**当场生效**（渲染端现读设置、每段现判语言），与"改嵌入来源要重启"不是一回事。
 */
export const REASONING_TRANSLATE_MODES = ['full', 'button'] as const

export const reasoningTranslateSettingsSchema = z.strictObject({
  /** 总开关（缺省关：翻译要打局域网服务，默认不动） */
  enabled: z.boolean(),
  /** 回显模式：全量翻译 / 翻译按钮 */
  mode: z.enum(REASONING_TRANSLATE_MODES),
  /** OpenAI 兼容 baseURL（形如 `http://192.168.31.18:8235/v1`）；空串 = 用预置 */
  baseUrl: z.string(),
  /** 翻译模型名（形如 `Index-Translate-2B`）；空串 = 用预置 */
  model: z.string(),
  /** 目标语言（进提示词，如「简体中文」）；空串 = 用预置 */
  targetLanguage: z.string()
})

export type ReasoningTranslateSettings = z.infer<typeof reasoningTranslateSettingsSchema>

export type ReasoningTranslateMode = ReasoningTranslateSettings['mode']

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
 * 探测到的模型元数据（round 22；视觉探测 round 48 起合住同一条记录）：
 * 键 = `<providerId>:<modelId>`（provider 的模型名原文，不归一——探测和消费两边同一个键函数
 * `probedKeyOf`）。两个来源各写各的字段：
 *   - `GET {baseUrl}/models`（main/model-probe.ts 的 probeProviderModels）→ contextWindow / 挡位；
 *   - **一条真发图片的最小 chat 请求**（同文件的 probeProviderVision）→ `vision`：
 *     2xx = 端点收下了图（能看图）、明确拒图 = 不能，其余（认证/限流/超时/5xx）**不写**。
 *     所以 `vision` 缺省 = **还不知道**（不是"不能"），消费侧回落注册表，见 shared/models.ts 的 visionOf。
 * 取值优先级 = probed → 注册表 → 默认；`fetchedAt` 是 `GET /models` 那一趟的抓取时刻（>24h 过期重抓），
 * 视觉判定不盖它（"这条记录新鲜"说的始终是元数据那一趟）。
 */
export const probedModelSchema = z.strictObject({
  /** 实测上下文长度（正整数；只有 `GET /models` 给得出——只探出视觉时这一项没有） */
  contextWindow: z.number().int().positive().optional(),
  /** 实测最大输出（存档；暂未参与 UI） */
  maxOutputTokens: z.number().int().positive().optional(),
  /** 实测思考挡位（原样值；空/没有 = 回落注册表） */
  efforts: z.array(z.string().min(1)).optional(),
  /** 实测默认挡位（如 'high'；无效/没有 = `default`） */
  defaultEffort: z.string().min(1).optional(),
  /** 视觉能力实测（round 48：真发图片探出来的结论；没有 = 还没探出来，按注册表回落） */
  vision: z.boolean().optional(),
  /** ISO 时间串（`GET /models` 的抓取时刻；没有 = 只有视觉判定，不当作元数据新鲜） */
  fetchedAt: z.string().optional()
})

export type ProbedModel = z.infer<typeof probedModelSchema>

/**
 * 手动覆盖（用户反馈 003/004）的一条：用户对某个模型显式声明的**上下文长度**与**显示名**。
 *
 * 为什么是独立一张表（不塞进 probedModels）：探测那一趟每次都整条重写自己那条记录
 * （`{...probed[key], ...meta, fetchedAt}`），用户的声明住在那里会被下一次探测默默压掉。
 * 键与探测同一形状 `"<providerId>:<model>"`（见 shared/models.ts 的 overrideKeyOf）。
 * `displayName` **只影响展示**（设置页那一行、composer 的模型菜单）——不进任何 key、请求或探测。
 */
export const modelOverrideSchema = z.strictObject({
  /** 手动上下文长度（tokens；正整数才生效——取值链里排在实测之前） */
  contextWindow: z.number().int().positive().optional(),
  /** 展示名（只影响展示；绝不进任何 key / 请求 / 探测） */
  displayName: z.string().optional()
})

export type ModelOverrideSetting = z.infer<typeof modelOverrideSchema>

/**
 * 出站边界的白名单（round 73）：fetch 默认**只访问公网** —— 环回 / 私网 / 链路本地地址
 * （含云元数据 169.254.169.254）与本机名一律拒绝，重定向也逐跳校验（见 mastra/tools/fetch.ts）。
 * 这里让用户显式开口子：**用户就是要读自己机器上的服务**（本机的 ollama / llama gateway /
 * 自建服务）是完全正当的用法，白名单是它的出口。
 *
 * 形态（与 fetch.ts 的 hostAllowed 同一份口径）：
 *   - `example.com` —— 该主机名的所有端口；
 *   - `127.0.0.1:8080` / `[::1]:8080` —— 只放行这个主机 + 端口；
 *   - `*.local` —— 后缀通配（`nas.local` 命中）。
 * 缺省空数组 = 一个本机/内网主机都不放行。
 *
 * 为什么是 optional 而不是必填：`appSettingsSchema` 是 strictObject，给新字段加默认值会让
 * **已落盘的旧文件**在解析时多出一个字段（`readSettings` 的"写进去什么就读出来什么"就破了）；
 * 读盘侧用 `settings.network?.allowLocalHosts ?? []` 兜底，不必改 main/settings.ts 的迁移表。
 */
export const networkSettingsSchema = z.strictObject({
  /** 允许 fetch 访问的本机 / 内网主机（见上；空 = 一律拒绝） */
  allowLocalHosts: z.array(z.string())
})

export type NetworkSettings = z.infer<typeof networkSettingsSchema>

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

/**
 * 动效设置（task-58；规格来自 `.superpowers/handover/dsh-motion-design.md` §0/§1.1，
 * 抄 DSH claude-style 的「动画效果」面板）。**9 个键的默认值 = 用户截图里的选择**：
 * mode=system、chatScroll/statusLine/preciseStatus/chatSend=true、statusPaint=sweep、
 * caret=typing、reveal=on（插件默认是 off，按用户选择取 on）、messageEnter=flight。
 *
 * `mode` 三档语义（doc §3）：system = 跟 `prefers-reduced-motion`；reduced = 一律减弱（静态）；
 * always = 忽略系统、一律动。真正生效由渲染端 `lib/motion.ts`（B 实现）解析成
 * `<html data-motion="reduced|full">`，CSS 与组件读它；本文件只负责可落盘的模型与默认值。
 */
export const motionModeSchema = z.enum(['system', 'reduced', 'always'])
export const statusPaintSchema = z.enum(['sweep', 'wash'])
export const caretMotionSchema = z.enum(['typing', 'off'])
export const revealMotionSchema = z.enum(['on', 'off'])
export const messageEnterSchema = z.enum(['grow', 'flight'])

export const motionSettingsSchema = z.strictObject({
  mode: motionModeSchema,
  /** 聊天区滚动动画（弹簧跟随 + 可读性优化） */
  chatScroll: z.boolean(),
  /** 状态行动画（等待行三点/扫光/换词） */
  statusLine: z.boolean(),
  /** 精确状态行（具体在做什么；statusLine 关时灰） */
  preciseStatus: z.boolean(),
  /** 状态行画法：扫光 / 渐变流动 */
  statusPaint: statusPaintSchema,
  /** Composer 光标动画：typing = 自绘滑行光标；off = 原生光标 */
  caret: caretMotionSchema,
  /** 流式新文字 120ms 淡入（on）/ 直接出现（off） */
  reveal: revealMotionSchema,
  /** 消息气泡出场：原地长出来 / 从输入框飞上来 */
  messageEnter: messageEnterSchema,
  /** 消息气泡动画总开关 */
  chatSend: z.boolean()
})

export type MotionMode = z.infer<typeof motionModeSchema>
export type StatusPaint = z.infer<typeof statusPaintSchema>
export type CaretMotion = z.infer<typeof caretMotionSchema>
export type RevealMotion = z.infer<typeof revealMotionSchema>
export type MessageEnter = z.infer<typeof messageEnterSchema>
export type MotionSettings = z.infer<typeof motionSettingsSchema>

/** 默认值的新副本（面板/主进程/测试都从这一份取；改动前先看 doc §0 的用户选择表） */
export function defaultMotionSettings(): MotionSettings {
  return {
    mode: 'system',
    chatScroll: true,
    statusLine: true,
    preciseStatus: true,
    statusPaint: 'sweep',
    caret: 'typing',
    reveal: 'on',
    messageEnter: 'flight',
    chatSend: true
  }
}

export const appSettingsSchema = z.strictObject({
  theme: themeModeSchema,
  fontTier: fontTierSchema,
  /** 动效（task-58）：9 键，默认值 = 用户截图选择，见上方 motionSettingsSchema */
  motion: motionSettingsSchema,
  globalRules: globalRulesSchema,
  /** T8 的 provider 列表（模型与密钥页；密钥不在里面，见 main/secrets.ts） */
  providers: z.array(providerConfigSchema),
  /** T10 的授权工作区列表（添加/移除/切模式走 workspace:* 通道） */
  workspaces: z.array(workspaceSchema),
  /**
   * round 75：**工作区之外**那一档（与每条工作区自己的 `mode` 是两个独立档位）。
   * 默认 `ask` = 区外的一切操作都逐次询问；显式设成 `full` = 区外也免审（用户设了就照办）。
   * 判定链见 `mastra/tools/guard.ts` 的 `needsApproval`；设置页「工作区」栏把它显式列成一组档位。
   *
   * 为什么是**顶层字段**、不塞进 `permissions`：`permissions` 会被整对象替换 —— 渲染端写
   * "永久允许"规则（settings-store 的 allowToolForever、设置页的「撤销」）发的补丁是
   * `{ permissions: { rules } }`，档位若住在里面会被那些补丁悄悄打回默认。顶层字段不参与
   * 那些补丁，各写各的（`settings:update` 的补丁 schema 里开着）。
   * 旧落盘文件由 main/settings.ts 的读盘迁移补 `ask`（缺了会整份设置当坏文件）。
   */
  outsideWorkspaceMode: workspaceModeSchema,
  /**
   * T18 的默认工作区：**未指定项目的会话**的文件工具根落在它**下面的会话子目录**里
   * （round 55：`<默认工作区>/tasks/<threadId 前 8 位>`，规则见 shared/session-dir.ts；
   * 解析见 main/projects.ts 的 sessionRoots）。
   * 存的是 `checkWorkspacePath` 归一后的路径，且一定同时是 workspaces 里的一条（指认时就并进去，
   * 模式 ask —— full 仍然只能由用户在设置页显式切换）；null = 没指认，那种情况下会话的根回退到
   * 整份授权列表（T10 既有口径）。写入只有 workspace:pick-default 一条路（原生选择器）。
   */
  defaultWorkspace: z.string().min(1).nullable(),
  /** 默认工作区首次初始化是否已完成；内部持久字段，不由渲染端设置。 */
  defaultWorkspaceInitialized: z.boolean(),
  /**
   * 关闭窗口偏好（0.1.3 托盘驻留的三档，见 CLOSE_TO_TRAY_MODES）。
   * **用户可以改**：设置 → 外观 走 settings:update 补丁；关闭弹窗里勾「记住我的选择」也写这里。
   * 旧字段 `closeToTrayHintShown`（首次提示标记 boolean）已废除——读盘迁移（main/settings.ts）
   * 会把它换成这一档：旧标记 true（旧行为 = 点关闭直接收进托盘）→ `tray`，其余 → `ask`。
   */
  closeToTrayMode: closeToTrayModeSchema,
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
  /**
   * round 22 的模型实测缓存（`${providerId}:${model}` → 上下文/挡位/视觉；主进程探测，见 main/model-probe.ts）。
   * round 48 起视觉能力也在这里（真发图片探出来的）——模块 2 的"用户覆盖"（旧的 modelCapabilities）
   * 已经删掉：能力只由探测说话（读盘时由 main/settings.ts 的迁移剥掉旧键）。
   */
  probedModels: z.record(z.string(), probedModelSchema),
  /**
   * 用户反馈 003/004 的手动覆盖（`<providerId>:<model>` → 上下文长度 / 显示名；走 settings:update 补丁）。
   * 与 probedModels 分开存是刻意的：探测写盘压不掉用户的声明（取值链 override → probed → 注册表 → 默认）。
   * 旧落盘文件没有这个键，读盘迁移补空表（main/settings.ts）。
   */
  modelOverrides: z.record(z.string(), modelOverrideSchema),
  /** round 20 的置顶会话 id 列表（顺序无关；侧栏把置顶的排在时间分组之前，带小图钉标识） */
  pinnedThreads: z.array(z.string().min(1)),
  /** round 25 的置顶项目 id 列表（侧栏项目区里置顶的排前；带小图钉标识） */
  pinnedProjects: z.array(z.string().min(1)),
  /** round 20 的归档快照列表（从侧栏移出、数据不删；设置页「归档」栏查看/搜索/取消归档） */
  archivedThreads: z.array(archivedThreadSchema),
  /** round 25 的归档项目快照（侧栏隐藏该项目及其会话；取消归档一并恢复） */
  archivedProjects: z.array(archivedProjectSchema),
  /** T17 的 Langfuse 追踪（显式开关 + 地址 + 代理，在设置页「追踪」栏；密钥走 secrets.json） */
  langfuse: langfuseSettingsSchema,
  /** round 28 模块 3 的语义召回（round 58 起 thread 作用域，只召回本会话；开关 + 嵌入来源，远程 key 走 secrets.json） */
  semanticRecall: semanticRecallSettingsSchema,
  /** round 32 的思考翻译（默认关；服务地址/模型/目标语言 + 可选 key 走 secrets.json） */
  reasoningTranslate: reasoningTranslateSettingsSchema,
  /**
   * round 45 的联网搜索（默认免费档，开箱即用）：后端模式 + 服务商 + 两个预置端点。
   * 三个可选 Key（Exa / Tavily / Jina）不在设置里，走 safeStorage 保留槽位（见 shared/search.ts）。
   */
  webSearch: webSearchSettingsSchema,
  /**
   * round 63 的更新源覆盖（设置 → 关于里填，只认 http(s) URL，不需要任何密钥）：
   * 空串 = 跟随打包时烘焙的内置源（resources/app-update.yml）；非空 = 检查更新时改用它
   * （主进程读设置后 setFeedURL；渠道文件按版本号自动挑 beta/latest，见 main/updater.ts）。
   */
  updateUrl: z.string(),
  /**
   * round 73 的出站边界白名单（fetch 的本机/内网主机；见 networkSettingsSchema）。
   * optional：旧落盘文件没有这个键也算合法（读侧 `settings.network?.allowLocalHosts ?? []`）。
   */
  network: networkSettingsSchema.optional()
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
 * （`closeToTrayMode` 反过来是**可以**打补丁的：设置 → 外观 就是靠它改的，三档取值没有路径风险。）
 */
export const appSettingsPatchSchema = appSettingsSchema.partial().omit({
  workspaces: true,
  defaultWorkspace: true,
  defaultWorkspaceInitialized: true,
  projects: true,
  mcpServers: true,
  pluginMarketplaces: true,
  installedPlugins: true
})

export type ThemeMode = z.infer<typeof themeModeSchema>
export type FontTier = z.infer<typeof fontTierSchema>
export type CloseToTrayMode = z.infer<typeof closeToTrayModeSchema>
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type PermissionRule = z.infer<typeof permissionRuleSchema>
export type Permissions = z.infer<typeof permissionsSchema>
export type McpTransport = z.infer<typeof mcpTransportSchema>
export type McpServerConfig = z.infer<typeof mcpServerSchema>
export type LangfuseSettings = z.infer<typeof langfuseSettingsSchema>
export type AppSettings = z.infer<typeof appSettingsSchema>
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>

/**
 * 远程嵌入档的预置（用户指定：硅基流动的免费嵌入档）：baseURL / 模型 / 拿 key 的页面。
 * 前两个直接当缺省值，用户贴一把 key 就能用（不必手填服务地址与模型）；也可以改成任意
 * OpenAI 兼容服务。`keyUrl` 只是"去哪拿 key"的入口，跟着预置走。
 *
 * 核实程度（2026-10-11 本机）：`https://api.siliconflow.cn/v1` 与 `/v1/models` 都活着
 * （无 key 回 401 "Token is invalid"）、key 页可达（307）；模型名按用户/任务书给定
 * （该值与两个地址都可在设置里随手改掉，改错只是"这次没有召回"）。
 */
export const SEMANTIC_RECALL_PRESET = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  keyUrl: 'https://cloud.siliconflow.cn/account/ak'
} as const

/** 语义召回缺省：开着、走预置的嵌入服务（用户贴 key 即用；没配 key = 这一路起不来） */
export const DEFAULT_SEMANTIC_RECALL: SemanticRecallSettings = {
  enabled: true,
  source: 'remote',
  baseUrl: SEMANTIC_RECALL_PRESET.baseUrl,
  model: SEMANTIC_RECALL_PRESET.model,
  /** 本机引擎的空闲回收缺省：5 分钟（内存 100% 回收；下次请求自动重启） */
  idleMinutes: 5
}

/** 空闲回收的可选档（分钟；0 = 不回收）——设置页的下拉框与落盘校验共用一处 */
export const LOCAL_ENGINE_IDLE_OPTIONS = [5, 15, 30, 0] as const

/**
 * Langfuse 的预置地址（round 67）：用户现在用的那台自建实例（不在原来的局域网里了，
 * 走 Tailscale 那类内网地址访问）。它只当**缺省值/表单预填**用——设置页「追踪」栏里
 * 随时可以改成别的实例（云版或另一台自建），改了以落盘值为准。
 * 代理不预置：默认直连，需要时在同一个栏里填（或靠 HTTPS_PROXY 环境变量兜底）。
 */
export const LANGFUSE_PRESET = {
  endpoint: 'http://100.66.1.1:3000'
} as const

/**
 * 思考翻译的预置（用户局域网部署的 llama.cpp，2026-10-11 实测可达）：
 * baseURL / 模型 / 目标语言三项直接当缺省值，用户打开开关就能用；也可以改成任意
 * OpenAI 兼容端点（如云端翻译接口，那就得再填一把 key）。
 */
export const REASONING_TRANSLATE_PRESET = {
  baseUrl: 'http://192.168.31.18:8235/v1',
  model: 'Index-Translate-2B',
  targetLanguage: '简体中文'
} as const

/** 思考翻译缺省：**关着**（要不要把思考发给翻译服务是用户的显式选择），模式 = 全量翻译 */
export const DEFAULT_REASONING_TRANSLATE: ReasoningTranslateSettings = {
  enabled: false,
  mode: 'full',
  baseUrl: REASONING_TRANSLATE_PRESET.baseUrl,
  model: REASONING_TRANSLATE_PRESET.model,
  targetLanguage: REASONING_TRANSLATE_PRESET.targetLanguage
}

/**
 * 生效的翻译服务配置：落盘为空串时按预置填 —— **表单与主进程用同一份兜底**，
 * 于是"设置页里看见的那三项"就是"翻译时真会用的那三项"。
 * 注意这只影响**本次使用**，不回头改落盘值（用户清空保存就是清空，同语义召回的预置口径）。
 */
export function effectiveReasoningTranslate(settings: ReasoningTranslateSettings): {
  baseUrl: string
  model: string
  targetLanguage: string
} {
  const text = (value: string, fallback: string): string =>
    value.trim() === '' ? fallback : value.trim()
  return {
    baseUrl: text(settings.baseUrl, REASONING_TRANSLATE_PRESET.baseUrl),
    model: text(settings.model, REASONING_TRANSLATE_PRESET.model),
    targetLanguage: text(settings.targetLanguage, REASONING_TRANSLATE_PRESET.targetLanguage)
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  fontTier: 'default',
  motion: defaultMotionSettings(),
  globalRules: '',
  providers: [],
  workspaces: [],
  /** round 75：工作区之外默认「每次询问」（保守缺省：区外的操作要先过用户） */
  outsideWorkspaceMode: 'ask',
  defaultWorkspace: null,
  defaultWorkspaceInitialized: false,
  /** 0.1.3 托盘驻留：关闭偏好默认「每次询问」（弹窗里可勾「记住我的选择」落成 tray / quit） */
  closeToTrayMode: 'ask',
  projects: [],
  permissions: { rules: [] },
  mcpServers: [],
  pluginMarketplaces: [],
  installedPlugins: [],
  modelPrefs: {},
  probedModels: {},
  modelOverrides: {},
  pinnedThreads: [],
  pinnedProjects: [],
  archivedThreads: [],
  archivedProjects: [],
  langfuse: { enabled: true, endpoint: LANGFUSE_PRESET.endpoint, proxyUrl: '' },
  semanticRecall: DEFAULT_SEMANTIC_RECALL,
  reasoningTranslate: DEFAULT_REASONING_TRANSLATE,
  webSearch: DEFAULT_WEB_SEARCH,
  updateUrl: '',
  network: { allowLocalHosts: [] }
}

/** 默认值的新副本（含新数组/新对象）：调用方拿到的对象随便改，不污染模块级默认 */
export function defaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    motion: defaultMotionSettings(),
    providers: [],
    workspaces: [],
    projects: [],
    permissions: { rules: [] },
    mcpServers: [],
    pluginMarketplaces: [],
    installedPlugins: [],
    modelPrefs: {},
    probedModels: {},
    modelOverrides: {},
    pinnedThreads: [],
    pinnedProjects: [],
    archivedThreads: [],
    archivedProjects: [],
    langfuse: { enabled: true, endpoint: LANGFUSE_PRESET.endpoint, proxyUrl: '' },
    semanticRecall: { ...DEFAULT_SEMANTIC_RECALL },
    reasoningTranslate: { ...DEFAULT_REASONING_TRANSLATE },
    webSearch: { ...DEFAULT_WEB_SEARCH },
    network: { allowLocalHosts: [] }
  }
}
