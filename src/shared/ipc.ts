/**
 * IPC 契约（主进程 / preload / 渲染端共用一处，spec §2.1「类型化 IPC（zod + 共享类型）」）：
 * 通道名常量 + 入参/出参 zod schema + 入参闸门。
 *
 * 两个校验边界：
 *   1. 主进程 handler 的入参 —— 渲染端是"不可信输入"侧，走 `parseIpcArgs`（非法即抛，不静默吞）；
 *   2. 渲染端收到的推送 payload —— preload 用同一份 schema 解析，结构不对就不交给上层。
 * 窗口几何（宽高/位置）只落盘在主进程（main/store.ts），不过桥：渲染端用不到，越小越稳。
 */
import { z } from './zod'
import { providerKeyStateSchema, type ProviderKeyState } from './providers'
import type { PluginIconResponse, PluginsOverview } from './plugins'
import {
  appSettingsPatchSchema,
  workspaceModeSchema,
  type AppSettings,
  type AppSettingsPatch,
  type WorkspaceMode
} from './settings'

export const IPC_CHANNELS = {
  window: {
    /** 最小化窗口 */
    minimize: 'window:minimize',
    /** 最大化 ⇄ 还原（按当前状态切换） */
    maximize: 'window:maximize',
    /** 关闭窗口 */
    close: 'window:close',
    /** 查询是否最大化（返回 boolean） */
    isMaximized: 'window:is-maximized',
    /** 主进程 → 渲染端：窗口状态变化推送 */
    stateChanged: 'window:state-changed'
  },
  settings: {
    /** 读当前设置（返回 AppSettings） */
    get: 'settings:get',
    /** 打补丁改设置（入参 AppSettingsPatch，返回合并后的 AppSettings） */
    update: 'settings:update',
    /** 写一条 provider 的密钥（入参 [id, key]，返回 {hasKey:true}——永远不回明文） */
    setProviderKey: 'settings:set-provider-key',
    /** 各 provider 的密钥状态（无入参，返回 { [id]: {hasKey, needsReentry} }） */
    providerKeyStates: 'settings:provider-key-states',
    /** 测试连接（入参 [id]，主进程发一条最小请求，返回延迟或错误文案） */
    testProvider: 'settings:test-provider',
    /** 删除一条 provider 配置（连同它的密钥；入参 [id]，返回合并后的 AppSettings） */
    removeProvider: 'settings:remove-provider',
    /**
     * round 22：探测一个 provider 的模型元数据（GET /models，入参 [id]，返回合并后的 AppSettings）。
     * 尽力而为：源不可达/端点不支持时静默回当前设置（模型菜单打开、连接测试成功、过期重抓都走它）。
     */
    probeModels: 'settings:probe-models'
  },
  workspace: {
    /** 打开原生选择器添加一个授权目录（无入参，取消=不改动；返回合并后的 AppSettings） */
    pick: 'workspace:pick',
    /** 添加工作区（入参 [path]；**一律以 ask 落盘**，返回合并后的 AppSettings） */
    add: 'workspace:add',
    /** 切换一个**已授权**工作区的访问模式（入参 [path, mode]，返回合并后的 AppSettings） */
    setMode: 'workspace:set-mode',
    /** 移除一个工作区（入参 [path]，返回合并后的 AppSettings） */
    remove: 'workspace:remove',
    /**
     * T18：打开原生选择器指认**默认工作区**（无入参，取消=不改动；返回合并后的 AppSettings）。
     * 选中目录会以 ask 并进授权列表，再写 settings.defaultWorkspace —— 未指定项目的会话用它当根。
     */
    pickDefault: 'workspace:pick-default',
    /**
     * round 15：列会话根下的文件（入参 [threadId]，返回 { files: 相对路径[] }）——
     * 输入框 `@` 引用工作区文件用。只读不写；会话根的解析与文件工具同口径（sessionRoots）。
     */
    listFiles: 'workspace:list-files',
    /**
     * round 20：在系统文件资源管理器里打开**会话根**（入参 [threadId]，返回 { path }）——
     * 会话行 ⋯ 菜单用。路径解析与 list-files 同口径（sessionRoots 在主进程算，渲染端传不了任意路径）；
     * 判不出唯一根（没有工作区 / 多条并列）时回人话错误。
     */
    openInExplorer: 'workspace:open-in-explorer'
  },
  projects: {
    /** T18：空白项目的默认基底目录（无入参，返回 { base }；创建对话框的默认路径用） */
    base: 'projects:base',
    /** T18：打开原生选择器挑一个**已存在**的文件夹（无入参，返回 { path | null }；不落盘、不授权） */
    pickFolder: 'projects:pick-folder',
    /** T18：创建项目（入参 [{ name, path }]，路径缺失就建目录；返回合并后的 AppSettings） */
    create: 'projects:create',
    /** T18：删除项目（入参 [id]；只摘清单，不动磁盘、不动授权列表） */
    remove: 'projects:remove',
    /** round 25：重命名项目（入参 [{ id, name }]；只改显示名，路径/磁盘不动） */
    rename: 'projects:rename',
    /**
     * round 25：在文件资源管理器里打开**项目目录**（入参 [id]，返回 { path }）——
     * 路径解析主进程做（按项目 id 查 settings.projects），渲染端传不了任意路径。
     */
    openInExplorer: 'projects:open-in-explorer'
  },
  agent: {
    /** 读本地 agent 服务端点（返回 AgentEndpoint：baseUrl + token） */
    endpoint: 'agent:endpoint'
  },
  updates: {
    /** 读当前更新状态（返回 UpdateState） */
    state: 'updates:state',
    /** 手动检查更新（无入参，返回检查结束时的 UpdateState） */
    check: 'updates:check',
    /** 重启并安装（只在"已下载"阶段有意义；无入参） */
    install: 'updates:install',
    /** 主进程 → 渲染端：更新状态变化推送 */
    stateChanged: 'updates:state-changed'
  },
  telemetry: {
    /** Langfuse 配置状态（无入参，返回 LangfuseState） */
    langfuseState: 'telemetry:langfuse-state',
    /** 写 Langfuse 公私钥（入参 [publicKey, secretKey]，返回 {hasKeys:true}——永远不回明文） */
    setLangfuseKeys: 'telemetry:set-langfuse-keys',
    /** 清除 Langfuse 公私钥（无入参，返回清除后的 LangfuseState） */
    clearLangfuseKeys: 'telemetry:clear-langfuse-keys'
  },
  memory: {
    /**
     * round 28：语义召回（长期记忆）里"远程嵌入"的 API Key 状态（无入参，返回 ProviderKeyState——
     * 与 provider 密钥同形状：只有"有没有 / 要不要重录"，没有明文）。
     */
    embeddingKeyState: 'memory:embedding-key-state',
    /** 写远程嵌入的 API Key（入参 [key]，返回 {hasKey:true}——永远不回明文） */
    setEmbeddingKey: 'memory:set-embedding-key',
    /** 清除远程嵌入的 API Key（无入参，返回清除后的状态） */
    clearEmbeddingKey: 'memory:clear-embedding-key'
  },
  plugins: {
    /** 插件总览（无入参：市场 + 插件清单 + 安装记录 + 已装技能） */
    overview: 'plugins:overview',
    /** 添加市场（入参 [{ source, ref?, sparsePaths? }]，返回新的总览） */
    addMarketplace: 'plugins:add-marketplace',
    /** 刷新市场（入参 [id]：git pull / 重读清单；返回新的总览） */
    refreshMarketplace: 'plugins:refresh-marketplace',
    /** 移除市场（入参 [id]：删克隆目录 + 连带卸载该市场的插件；返回新的总览） */
    removeMarketplace: 'plugins:remove-marketplace',
    /** 安装插件（入参 [{ marketplaceId, name }]；返回新的总览） */
    install: 'plugins:install',
    /** 卸载插件（入参 [id]；返回新的总览） */
    uninstall: 'plugins:uninstall',
    /**
     * round 23：读一个插件的本地图标（入参 [marketplaceId, pluginName]，返回 { dataUrl | null }）——
     * 插件目录在主进程解析（渲染端传不了任意路径）；没有可用图标 = null，渲染端画字母头像。
     */
    icon: 'plugins:icon'
  }
} as const

/** 窗口状态推送 payload（目前只有最大化标记） */
export const windowStateSchema = z.strictObject({ maximized: z.boolean() })
export type WindowState = z.infer<typeof windowStateSchema>

/**
 * 本地 agent 服务的端点：渲染端拿它直连主进程内嵌的 chat 服务。
 * token 是每次启动新生成的 Bearer 串——它只经这条 IPC 交给本应用的渲染端，不进设置、不落盘。
 */
export const agentEndpointSchema = z.strictObject({
  baseUrl: z.string(),
  token: z.string()
})
export type AgentEndpoint = z.infer<typeof agentEndpointSchema>

/** settings:update 的入参：单元素元组（payload 形状在 shared/settings.ts） */
export const settingsUpdateArgsSchema = z.tuple([appSettingsPatchSchema])

/** settings:set-provider-key 的入参：[id, key]（都非空；key 只在主进程内存里短暂存在） */
export const providerKeyArgsSchema = z.tuple([z.string().min(1), z.string().min(1)])

/** settings:test-provider / settings:remove-provider 的入参：[id] */
export const providerIdArgsSchema = z.tuple([z.string().min(1)])

/**
 * workspace:add 的入参：[path]（path 是不是真目录由主进程校验，这里只保证形状）。
 * **没有 mode**：新加的工作区一律以 ask 落盘 —— 渲染端不能"顺手"把 full 塞进授权列表。
 */
export const workspaceAddArgsSchema = z.tuple([z.string().min(1)])

/** workspace:set-mode 的入参：[path, mode]（切模式只对已在授权列表里的路径生效） */
export const workspaceSetModeArgsSchema = z.tuple([z.string().min(1), workspaceModeSchema])

/** workspace:remove 的入参：[path] */
export const workspaceRemoveArgsSchema = z.tuple([z.string().min(1)])

/**
 * workspace:list-files 的入参：[threadId] —— 主进程按会话根（sessionRoots 同口径）解析出根目录，
 * 渲染端**看不到、也传不了**任意路径；回包是相对该根的路径（正斜杠）。
 */
export const workspaceListFilesArgsSchema = z.tuple([z.string().min(1)])

/** workspace:list-files 的回包：{ files: 相对路径[] }（有界列表，见 main/workspace-files.ts） */
export const workspaceListFilesResultSchema = z.strictObject({ files: z.array(z.string()) })

/** workspace:open-in-explorer 的入参：[threadId]（会话根同样在主进程解析，同 list-files 口径） */
export const workspaceOpenInExplorerArgsSchema = z.tuple([z.string().min(1)])

/** workspace:open-in-explorer 的回包：实际打开的目录（绝对路径；测试与排障都看得到） */
export const workspaceOpenInExplorerResultSchema = z.strictObject({ path: z.string().min(1) })

/**
 * projects:create 的入参：单元素对象 { name, path }。
 * name 非空（业务侧的字符校验在 main/ipc/projects.ts，闸门只管形状）；path 由对话框给
 * （空白项目 = 默认基底 + 名称；现有文件夹 = 原生选择器挑的），主进程校验/建目录。
 */
export const projectCreateArgsSchema = z.tuple([
  z.strictObject({
    name: z.string().min(1),
    path: z.string().min(1)
  })
])

/** projects:remove 的入参：[id] */
export const projectRemoveArgsSchema = z.tuple([z.string().min(1)])

/** projects:rename 的入参：[{ id, name }]（名字的业务校验在主进程 projectNameProblem） */
export const projectRenameArgsSchema = z.tuple([
  z.strictObject({ id: z.string().min(1), name: z.string().min(1) })
])

/** projects:open-in-explorer 的入参：[id]（项目路径按 id 在主进程解析） */
export const projectOpenInExplorerArgsSchema = z.tuple([z.string().min(1)])

/** projects:open-in-explorer 的回包：实际打开的目录（绝对路径） */
export const projectOpenInExplorerResultSchema = z.strictObject({ path: z.string().min(1) })

/** projects:base 的回包：创建对话框的默认基底目录 */
export const projectBaseSchema = z.strictObject({ base: z.string().min(1) })

/** projects:pick-folder 的回包：挑中的文件夹（归一后）或 null（取消） */
export const projectFolderSchema = z.strictObject({ path: z.string().min(1).nullable() })

/** 写密钥的回包：只有"有没有"，没有明文（strict：连字段名都锁死） */
export const setProviderKeyResultSchema = z.strictObject({ hasKey: z.literal(true) })

/** settings:provider-key-states 的回包：键是 provider id */
export const providerKeyStatesSchema = z.record(z.string(), providerKeyStateSchema)

/**
 * "测试连接"的结果：成功给延迟（ms），失败给一句人话（已抹掉可能被供应商回显的密钥）。
 * 判别字段是 `ok`，UI 与 preload 用同一份 schema。
 */
export const connectionTestResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), latencyMs: z.number() }),
  z.strictObject({ ok: z.literal(false), message: z.string() })
])

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>

/** 无入参通道的入参 schema：ipcRenderer.invoke 不给参数时 args 为空数组 */
export const noArgsSchema = z.tuple([])

/**
 * 更新通道（T17）的状态机取值：idle 未检查过 / checking 检查中 / up-to-date 已是最新 /
 * available 检出新版本 / downloading 下载中 / downloaded 已下载待安装 / error 出错。
 */
export const updatePhaseSchema = z.enum([
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'error'
])

/**
 * 一次更新检视的状态：按相位判别（每个相位只带自己那几个字段——`idle` 带上 percent 是形状错误，
 * 不是"多余信息"）。version 只在有新版本时给；percent 只在下载中给；message 只在 error 时给
 * （已截断、不带栈）。
 */
export const updateStatusSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('idle') }),
  z.strictObject({ phase: z.literal('checking') }),
  z.strictObject({ phase: z.literal('up-to-date') }),
  z.strictObject({ phase: z.literal('available'), version: z.string().optional() }),
  z.strictObject({
    phase: z.literal('downloading'),
    version: z.string().optional(),
    percent: z.number().optional()
  }),
  z.strictObject({ phase: z.literal('downloaded'), version: z.string().optional() }),
  z.strictObject({ phase: z.literal('error'), message: z.string().optional() })
])

/**
 * 渲染端看到的更新全貌：当前版本 + 有没有配更新源 + 状态。
 * `configured=false` 时"检查更新"只回状态（不发网络请求）——开发态/未配置的路径不报错、不骚扰。
 */
export const updateStateSchema = z.strictObject({
  currentVersion: z.string(),
  configured: z.boolean(),
  status: updateStatusSchema
})

export type UpdatePhase = z.infer<typeof updatePhaseSchema>
export type UpdateStatus = z.infer<typeof updateStatusSchema>
export type UpdateState = z.infer<typeof updateStateSchema>

/**
 * Langfuse 的配置状态（T17）：地址是落盘设置的原文，公私钥只有"有没有"。
 * `active` = 本次启动的 agent 服务真把导出挂上了（配置改动要重启应用才生效，UI 拿它说人话）。
 */
export const langfuseStateSchema = z.strictObject({
  endpoint: z.string(),
  publicKey: providerKeyStateSchema,
  secretKey: providerKeyStateSchema,
  active: z.boolean()
})

export type LangfuseState = z.infer<typeof langfuseStateSchema>

/** telemetry:set-langfuse-keys 的入参：[publicKey, secretKey]（都非空；明文只在主进程内存里短暂存在） */
export const langfuseKeysArgsSchema = z.tuple([z.string().min(1), z.string().min(1)])

/** 写 Langfuse 密钥的回包：只有"有没有"，没有明文（strict：连字段名都锁死） */
export const setLangfuseKeysResultSchema = z.strictObject({ hasKeys: z.literal(true) })

/**
 * round 28：写远程嵌入 API Key 的入参/回包。
 * 入参是单个非空字符串（明文只在主进程内存里短暂存在，落盘走 safeStorage）；回包只有"有没有"，
 * 形状与 provider 密钥完全一致（复用 providerKeyStateSchema / setProviderKeyResultSchema）。
 */
export const embeddingKeyArgsSchema = z.tuple([z.string().min(1)])

/**
 * 插件通道（round 10）的入参与回包：
 *   - 添加市场：{ source, ref?, sparsePaths? }（三态来源判定与克隆在主进程）；
 *   - 安装/卸载/刷新/移除：id / { marketplaceId, name }（市场清单是主进程读的，渲染端只给标识）。
 * 总览回包（PluginsOverview）形状见 shared/plugins.ts 的 pluginsOverviewSchema。
 */
export const pluginAddMarketplaceArgsSchema = z.tuple([
  z.strictObject({
    source: z.string().min(1),
    ref: z.string().optional(),
    sparsePaths: z.array(z.string()).optional()
  })
])

/** plugins:refresh-marketplace / plugins:remove-marketplace 的入参：[id] */
export const pluginMarketplaceIdArgsSchema = z.tuple([z.string().min(1)])

/** plugins:install 的入参：[{ marketplaceId, name }] */
export const pluginInstallArgsSchema = z.tuple([
  z.strictObject({ marketplaceId: z.string().min(1), name: z.string().min(1) })
])

/** plugins:uninstall 的入参：[id] */
export const pluginIdArgsSchema = z.tuple([z.string().min(1)])

/** plugins:icon 的入参：[marketplaceId, pluginName]（插件目录在主进程解析，同 containment 口径） */
export const pluginIconArgsSchema = z.tuple([z.string().min(1), z.string().min(1)])

/** 跨边界入参不合法（主进程侧抛这个，不静默忽略） */
export class IpcInputError extends Error {
  constructor(channel: string, detail: string) {
    super(`IPC 入参不合法（${channel}）：${detail}`)
    this.name = 'IpcInputError'
  }
}

/**
 * 主进程 handler 的统一入参闸门。
 * `channel` 只用于报错信息（handler 里手写一遍通道名，报错时能直接指到是哪条通道）。
 */
export function parseIpcArgs<S extends z.ZodType>(
  schema: S,
  args: readonly unknown[],
  channel: string
): z.infer<S> {
  const result = schema.safeParse(args)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(入参)'}: ${issue.message}`)
      .join('; ')
    throw new IpcInputError(channel, detail)
  }
  return result.data
}

/** preload 暴露给渲染端的窗口控制面（白名单方法的契约） */
export interface KyclawWindowApi {
  minimize(): void
  /** 最大化 ⇄ 还原 */
  maximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  /** 订阅窗口状态变化，返回退订函数 */
  onStateChanged(listener: (state: WindowState) => void): () => void
}

/** preload 暴露给渲染端的设置面（落盘在主进程，渲染端只经 IPC 读写） */
export interface KyclawSettingsApi {
  get(): Promise<AppSettings>
  /** 只给要改的字段，返回合并后的完整设置 */
  update(patch: AppSettingsPatch): Promise<AppSettings>
  /** 写一条 provider 的密钥：成功只回 {hasKey:true}（明文永不回渲染端） */
  setProviderKey(id: string, key: string): Promise<{ hasKey: true }>
  /** 各 provider 的密钥状态（键是 provider id；解不开的密钥体现在 needsReentry） */
  providerKeyStates(): Promise<Record<string, ProviderKeyState>>
  /** 主进程发一条最小请求验证连通性（返回延迟或错误文案） */
  testProvider(id: string): Promise<ConnectionTestResult>
  /** 删除一条 provider 配置（连同它的密钥），返回合并后的完整设置 */
  removeProvider(id: string): Promise<AppSettings>
  /**
   * round 22：探测该 provider 的模型元数据（GET /models → 真实上下文长度/思考挡位），
   * 返回合并后的完整设置；源不可达/端点不支持时**静默回当前设置**（不抛、不打扰用户）。
   */
  probeModels(id: string): Promise<AppSettings>
}

/** preload 暴露给渲染端的 agent 服务面（服务未起时 endpoint() 会 reject） */
export interface KyclawAgentApi {
  endpoint(): Promise<AgentEndpoint>
}

/**
 * preload 暴露给渲染端的更新面（T17）：当前版本 + 状态 + 手动检查/安装。
 * 状态由主进程推（`updates:state-changed`，进度边走边推），所以这里有订阅；
 * 检查本身是异步长事（下载在后台继续），check() 只等到"检查"这一步落地。
 */
export interface KyclawUpdatesApi {
  state(): Promise<UpdateState>
  /** 手动检查更新：返回检查结束时的状态；下载进度随后经 onStateChanged 推 */
  check(): Promise<UpdateState>
  /** 重启并安装（只在"已下载"阶段有意义） */
  install(): Promise<void>
  /** 订阅更新状态变化，返回退订函数 */
  onStateChanged(listener: (state: UpdateState) => void): () => void
}

/**
 * preload 暴露给渲染端的可观测面（T17）：Langfuse 的配置状态 + 写/清密钥。
 * 与 provider 密钥同一套纪律：**只在写方向上见到明文**，读回来只有"有没有"。
 */
export interface KyclawTelemetryApi {
  langfuseState(): Promise<LangfuseState>
  /** 写公私钥：成功只回 {hasKeys:true}（明文永不回渲染端） */
  setLangfuseKeys(publicKey: string, secretKey: string): Promise<{ hasKeys: true }>
  /** 清除公私钥（地址仍在设置里，用户想彻底关就在「追踪」栏把地址清空保存） */
  clearLangfuseKeys(): Promise<LangfuseState>
}

/**
 * preload 暴露给渲染端的工作区面：授权目录的增删与访问模式。
 * 为什么单独一族（不并进 settings:update）：工作区路径必须在主进程校验
 * （存在、是目录、非 UNC），补丁 schema 里没有 workspaces 这个字段。
 *
 * 加与切模式**分成两条**（T13 收紧）：`add` 一律以 ask 落盘、`setMode` 只认已在列表里的路径 ——
 * "完全访问"必须是用户在设置里对**已授权目录**的显式动作，不能随添加目录一起静默生效。
 */
export interface KyclawWorkspaceApi {
  /** 打开原生选择器添加一个工作区（取消 = 不改动；一律 ask），返回合并后的完整设置 */
  pick(): Promise<AppSettings>
  /** 添加工作区（一律 ask）；已在列表里是幂等的空操作（不动它的模式） */
  add(path: string): Promise<AppSettings>
  /** 切换一个已授权工作区的访问模式；路径不在列表里会被拒绝 */
  setMode(path: string, mode: WorkspaceMode): Promise<AppSettings>
  /** 移除一个工作区（不在列表里是空操作） */
  remove(path: string): Promise<AppSettings>
  /** 指认默认工作区（原生选择器；取消 = 不改动）——未指定项目的会话用它当根 */
  pickDefault(): Promise<AppSettings>
  /**
   * round 15：列这个会话根下的文件（相对路径、正斜杠；有界 1500 条 / 深度 8 / 常见构建目录跳过）。
   * 会话根的解析在**主进程**（sessionRoots 同口径）——渲染端传不了任意路径。
   */
  listFiles(threadId: string): Promise<{ files: string[] }>
  /**
   * round 20：在系统文件资源管理器里打开这个会话的根目录（路径同样由主进程解析）。
   * 判不出唯一根 / 目录打不开时抛人话错误；渲染端按 `sessionWorkspaceOf` 预判并禁用入口。
   */
  openInExplorer(threadId: string): Promise<{ path: string }>
}

/**
 * preload 暴露给渲染端的项目面（T18）：创建/删除项目 + 创建对话框要的两块料。
 * 项目路径与授权目录同源校验（主进程 `checkWorkspacePath`），所以不并进 settings:update
 * （补丁 schema 里也没有 projects/defaultWorkspace）。
 */
export interface KyclawProjectsApi {
  /** 空白项目的默认基底目录（创建对话框的默认路径用） */
  base(): Promise<{ base: string }>
  /** 打开原生选择器挑一个已存在的文件夹（取消 = null）；只回路径，不落盘、不授权 */
  pickFolder(): Promise<{ path: string | null }>
  /** 创建项目：路径不存在就建目录，随后经校验进项目清单 + 授权列表（ask） */
  create(name: string, path: string): Promise<AppSettings>
  /** 删除项目：只摘清单（会话映射由渲染端清理；磁盘与授权列表不动） */
  remove(id: string): Promise<AppSettings>
  /** round 25：重命名项目（只改显示名；返回合并后的完整设置） */
  rename(id: string, name: string): Promise<AppSettings>
  /** round 25：在文件资源管理器里打开项目目录（路径按 id 在主进程解析） */
  openInExplorer(id: string): Promise<{ path: string }>
}

/** `window.kyclaw` 的全部能力（后续任务按通道族追加） */
export interface KyclawApi {
  window: KyclawWindowApi
  settings: KyclawSettingsApi
  workspace: KyclawWorkspaceApi
  projects: KyclawProjectsApi
  agent: KyclawAgentApi
  updates: KyclawUpdatesApi
  telemetry: KyclawTelemetryApi
  plugins: KyclawPluginsApi
  memory: KyclawMemoryApi
}

/**
 * preload 暴露给渲染端的记忆面（round 28，只有语义召回的远程嵌入密钥）：
 * 开关与来源是普通设置（settings:update 的补丁里就有），这里只管密钥的写/清/状态——
 * 与 provider / Langfuse 同一套纪律：写方向见明文一次，读方向永远只有"有没有 / 要不要重录"。
 */
export interface KyclawMemoryApi {
  /** 远程嵌入的 API Key 状态（没有 = 没配过） */
  embeddingKeyState(): Promise<ProviderKeyState>
  /** 写密钥：成功只回 {hasKey:true}（明文永不回渲染端） */
  setEmbeddingKey(key: string): Promise<{ hasKey: true }>
  /** 清除密钥（幂等；返回清除后的状态） */
  clearEmbeddingKey(): Promise<ProviderKeyState>
}

/**
 * preload 暴露给渲染端的插件面（round 10）：市场增/刷/删 + 插件装/卸 + 总览。
 * 每个动作都回**新的总览**（与 workspace 面回完整设置同一口径：界面以主进程的真相为准）。
 * 来源判定/克隆/清单校验/containment 都在主进程——渲染端只递用户填的原文与标识。
 */
export interface KyclawPluginsApi {
  overview(): Promise<PluginsOverview>
  addMarketplace(input: {
    source: string
    ref?: string
    sparsePaths?: string[]
  }): Promise<PluginsOverview>
  refreshMarketplace(id: string): Promise<PluginsOverview>
  removeMarketplace(id: string): Promise<PluginsOverview>
  install(marketplaceId: string, name: string): Promise<PluginsOverview>
  uninstall(id: string): Promise<PluginsOverview>
  /** round 23：读插件本地图标（data URL；没有 = null，渲染端画字母头像） */
  icon(marketplaceId: string, name: string): Promise<PluginIconResponse>
}
