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
import type { LocalModelsOverview } from './local-models'
import {
  providerKeyStateSchema,
  providerTypeSchema,
  type ProviderKeyState,
  type ProviderType
} from './providers'
import type { PluginIconResponse, PluginsOverview } from './plugins'
import { TRANSLATE_MAX_CHARS, type TranslateResult } from './translate'
import { SEARCH_KEY_TARGETS, type SearchKeyTarget } from './search'
import type { PdfExtractResult } from './attachments'
import {
  SEARCH_QUERY_MIN,
  workbenchSearchModeSchema,
  type FileBytesResult,
  type FilePreview,
  type GitCommit,
  type GitCommitDetail,
  type GitOverview,
  type ListDirResult,
  type TableBytesResult,
  type TerminalExit,
  type TerminalSession,
  type WorkbenchSearchMode,
  type WorkbenchSearchResult
} from './workbench'
import type { TextPageCursor, TextPageResult, TextVersionResult } from './workbench-text'
import type { OfficePreviewPriority, OfficePreviewResult } from './office-preview'
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
    /** 测试连接（入参 [id]，主进程分项验证连通/流式/流式工具，返回 ConnectionTestResult） */
    testProvider: 'settings:test-provider',
    /** 删除一条 provider 配置（连同它的密钥；入参 [id]，返回合并后的 AppSettings） */
    removeProvider: 'settings:remove-provider',
    /**
     * round 22：探测一个 provider 的模型元数据（GET /models，入参 [id]，返回合并后的 AppSettings）。
     * 尽力而为：源不可达/端点不支持时静默回当前设置（模型菜单打开、连接测试成功、过期重抓都走它）。
     */
    probeModels: 'settings:probe-models',
    /**
     * 用户反馈 007：列这个 provider 端点上的可选模型（入参 [id]，返回 `{ id, contextWindow? }[]`）。
     * **只读**——不落盘、不动 probedModels，给"新增 / 给端点加模型"的弹窗挑模型用；
     * 拿不到清单（端点没有 /models、认证失败、超时…）一律回**空数组**，不是硬错。
     */
    listProviderModels: 'settings:list-provider-models',
    /**
     * 用户反馈 007（补齐）：拿**用户刚在弹窗里填的**地址与密钥列一次模型清单
     * （入参 [{ type, baseUrl?, apiKey }]，返回 ProviderModelDiscoveryResult）。
     *
     * 为什么另开一条而不是复用 `listProviderModels`：那条只认**已落盘**的 provider id，
     * 于是"新注册"这条路必须先手填一个模型名、存下去，才谈得上发现——顺序是反的。
     * 这一条的地址与密钥都是这次调用现给的：**明文只在主进程里活这一次**，不落盘、不进日志、
     * 不进回包（用户没点保存之前，这个端点在设置里根本不存在）。
     * 与那条的另一个差别：**失败要带一句人话回来**（`ok:false`），弹窗得把"读不到"和
     * "端点就是空的"分开说——那条静默回空表在这里会变成误导。
     */
    discoverProviderModels: 'settings:discover-provider-models'
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
     * 选中目录会以 ask 并进授权列表，再写 settings.defaultWorkspace —— 未指定项目的会话落在它
     * 下面的会话子目录里（round 55：`<默认工作区>/tasks/<threadId 前 8 位>`）。
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
  workbench: {
    /**
     * 列会话根下**一层**目录的内容（入参 [threadId, relative]；返回 { entries }）——
     * 「文件」工具的懒加载树。会话根在主进程按 sessionRoots 同口径解析，渲染端只给相对路径
     * （`''` = 根本身），越权/穿出的路径被拒。
     */
    listDir: 'workbench:list-dir',
    /**
     * 读一个文件做预览（入参 [threadId, relative]；返回 FilePreview 判别联合）——
     * 文本档有界读取（64KB），二进制与超大文件各自给判别结果。
     */
    readFile: 'workbench:read-file',
    /**
     * round 40：读一个文件的**原始字节**（入参 [threadId, relative]；返回 FileBytesResult）——
     * 图片 / PDF 这类要"按格式真渲染"的预览走它（文本通道 64KB 且只给字符串，承载不了）。
     * 扩展名 + 文件头双重判定；越界路径照旧拒；大小上限按格式分桶。
     */
    readBytes: 'workbench:read-bytes',
    /**
     * round 44：在会话根下搜索（入参 [threadId, query, mode]；返回 WorkbenchSearchResult）——
     * `mode='name'` 按文件名、`mode='content'` 按文件内容（都是大小写不敏感、只回相对路径）。
     * query 太短（trim 后 < SEARCH_QUERY_MIN）由闸门拒；递归与重活都在主进程，渲染端只拿结果。
     */
    search: 'workbench:search',
    /**
     * 在系统文件资源管理器里定位会话根下的某个路径（入参 [threadId, relative]；返回 { path }）——
     * 目录直接打开，文件用 showItemInFolder 选中。绝对路径只活在主进程。
     */
    reveal: 'workbench:reveal',
    /**
     * 用**系统默认应用**打开会话根下的一个文件（入参 [threadId, relative]；返回 { path }）——
     * 用户本机通常装了 Word / WPS / Excel 之一，这一条就是把产出交回他熟悉的那个应用。
     * 三道闸门与 reveal 同源或更严：containment / 存在性走 `revealTarget`、**目录一律拒**、
     * 扩展名过 `assertOpenable` 那张表（`shell.openPath` 就是 ShellExecute，不能让工作区里
     * 模型写的 .exe/.bat/.ps1/.lnk 从这里溜出去执行）。绝对路径只活在主进程。
     */
    open: 'workbench:open',
    /**
     * 办公档的**页式预览**（入参 [threadId, relative, priority, requestId]；返回 OfficePreviewResult）——
     * doc / docx / ppt / pptx 在主进程用随包 LibreOffice 转成 PDF，渲染端拿字节交给已有的 PDF 预览画。
     * 闸门与 read-bytes 同源或更严：会话根解析 + containment + **真实路径前后复检**、后缀白名单、
     * 存在性、32MB 上限；**缓存命中也要先过这几道**（授权在接线层，转引擎压根不知道"路径"这回事）。
     * 取消走下面那条通道：`requestId` 由渲染端生成，只对**发起它的那个窗口**有效。
     */
    officePdf: 'workbench:office-pdf',
    /**
     * 取消一次办公档转换（入参 [requestId]；无回包）——**只取消本窗口自己发起的那个请求**
     * （另一个窗口拿同一个 id 来取消是空操作）；幂等。取消后 `office-pdf` 那一路回
     * `kind:'failed', code:'cancelled'`，界面直接丢弃、不报错。
     */
    cancelOfficePdf: 'workbench:cancel-office-pdf',
    /**
     * 表格（xls / xlsx / csv / tsv）的**原始字节**（入参 [threadId, relative]；返回 TableBytesResult）——
     * 与 read-bytes 那条"主进程抽结构"的路**刻意分开**：那条的结构合同是既有消费者在用的
     * （表格预览 / 二进制占位），这条只回答"把这个文件的字节给我"，后缀 + 文件头双重判定，
     * 读写期间文件在变时回 `changed`（不给半截快照）。
     */
    tableBytes: 'workbench:table-bytes',
    /**
     * **文本分页**（入参 [threadId, relative, cursor|null]；返回 TextPageResult）——
     * 预览里的"加载更多"：一页一页读文本（有界字节 + 行游标 + UTF-8 边界 + 版本校验 +
     * 超长单行上限），让整份文本都看得到，而不是停在旧文本通道的 64KB。第一页传 `cursor = null`。
     * 版本不符 / 读的当口在变回 `changed`（**不交半截、不混版本**）；NUL 回 `binary`；越权路径抛。
     */
    readTextPage: 'workbench:read-text-page',
    /**
     * 只问文本文件现在的版本与大小（入参 [threadId, relative]；返回 TextVersionResult）——
     * 给渲染端**受控轮询**用（窗口可见且预览标签在前台才轮询）：版本变了就提示"文件已更新"，
     * 由用户决定何时重读（不静默把新内容拼进旧内容里）。只 stat、不读正文。
     */
    textVersion: 'workbench:text-version',
    /** git 总览（入参 [threadId]；返回分支 + 未提交变更；不是仓库/空仓库由 empty/isRepo 表达） */
    gitOverview: 'workbench:git-overview',
    /** 提交历史树（入参 [threadId, limit]；`git log --graph` 解析成结构化行） */
    gitLog: 'workbench:git-log',
    /** 单提交详情（入参 [threadId, sha]；作者/时间/完整 message + 变更文件统计） */
    gitShow: 'workbench:git-show'
  },
  terminal: {
    /** 起一个交互式终端（入参 [threadId, cols, rows]；返回 { id, shell, cwd }） */
    start: 'terminal:start',
    /** 往终端写输入（入参 [id, data]） */
    write: 'terminal:write',
    /** 终端尺寸变化（入参 [id, cols, rows]；FitAddon 算出来后同步） */
    resize: 'terminal:resize',
    /** 关掉一个终端（入参 [id]；幂等） */
    dispose: 'terminal:dispose',
    /** 主进程 → 渲染端：一段输出 */
    data: 'terminal:data',
    /** 主进程 → 渲染端：进程结束（应用退出时也会推一次，让界面收干净） */
    exit: 'terminal:exit'
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
  attachments: {
    /**
     * 模块 2：抽一份 PDF 的文字层（入参 [bytes]，返回 PdfExtractResult）。
     * 放主进程是刻意的：抽取要用 pdfjs（Node 侧能力），渲染端零新依赖；回包是**产品语言**
     * （扫描件/加密/坏文件都是 `{ok:false, message}`，不抛）。
     */
    extractPdf: 'attachments:extract-pdf'
  },
  updates: {
    /** 读当前更新状态（返回 UpdateState） */
    state: 'updates:state',
    /** 手动检查更新（无入参，返回检查结束时的 UpdateState） */
    check: 'updates:check',
    /** 重启并安装（只在"已下载"阶段有意义；无入参） */
    install: 'updates:install',
    /** 主进程 → 渲染端：更新状态变化推送 */
    stateChanged: 'updates:state-changed',
    /**
     * 本版本随包发行说明（无入参，返回 BundledReleaseNotes）：读的是 `app.getVersion()` 对应的
     * 那一份 md（**不接受任何路径/文件名**——不存在"让渲染端指定读哪个文件"的面）。
     */
    releaseNotes: 'updates:release-notes'
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
  translate: {
    /**
     * round 32：翻译一段文本（入参 [{ text, targetLanguage? }]，返回 TranslateResult）。
     * 目标语言缺省 = 按设置里的「目标语言」兜底；可选 API Key 只活在主进程内存里
     * （明文不回渲染端、不进日志），服务地址/模型/超时全在主进程侧。
     */
    run: 'translate:run',
    /** 可选 API Key 的状态（无入参，返回 ProviderKeyState——与 provider 密钥同形状） */
    keyState: 'translate:key-state',
    /** 写可选 API Key（入参 [key]，返回 {hasKey:true}——永远不回明文） */
    setKey: 'translate:set-key',
    /** 清除可选 API Key（无入参，返回清除后的状态） */
    clearKey: 'translate:clear-key'
  },
  search: {
    /**
     * round 45：联网搜索的三个可选 Key（Exa / Tavily / Jina）的状态（无入参，
     * 返回 { exa, tavily, jina } 三份 ProviderKeyState——与 provider 密钥同形状，无明文）。
     */
    keyStates: 'search:key-states',
    /** 写一个 Key（入参 [target, key]，返回 {hasKey:true}——永远不回明文） */
    setKey: 'search:set-key',
    /** 清除一个 Key（入参 [target]；返回清除后的三份状态） */
    clearKey: 'search:clear-key'
  },
  localModels: {
    /** 「本地模型」组的总览（无入参，返回 LocalModelsOverview：清单 + 已下载 + 引擎相位 + 下载进度） */
    overview: 'localModels:overview',
    /** 开始下载一个推荐档（入参 [id]；**立刻回总览**，进度走 progressChanged 推送） */
    download: 'localModels:download',
    /** 取消当前下载（无入参；半截文件留着，下次续传） */
    cancel: 'localModels:cancel',
    /** 设为生效（入参 [id]；文件与记录都在才行） */
    select: 'localModels:select',
    /** 选一个本机自备的 GGUF 并设为生效（无入参：走原生选择器；取消=不改动） */
    pickCustom: 'localModels:pick-custom',
    /** 删除一个已下载的推荐档（入参 [id]；`custom` = 只是取消选择，不删用户文件） */
    remove: 'localModels:remove',
    /** 主进程 → 渲染端：总览变化（下载进度 / 引擎相位 / 选择变化） */
    progressChanged: 'localModels:progress-changed'
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

/**
 * attachments:extract-pdf 的入参：[bytes]（PDF 原文件）。
 * 只管形状（真 Uint8Array）——大小上限在主进程侧判（超限回人话，不抛 IPC 错误）。
 * 渲染端发的是 `new Uint8Array(await file.arrayBuffer())`：Electron 的 IPC 走结构化克隆，
 * TypedArray 能原样过桥（不必转 base64，也不落临时文件）。
 */
export const pdfExtractArgsSchema = z.tuple([z.instanceof(Uint8Array)])

/** settings:set-provider-key 的入参：[id, key]（都非空；key 只在主进程内存里短暂存在） */
export const providerKeyArgsSchema = z.tuple([z.string().min(1), z.string().min(1)])

/** settings:test-provider / settings:remove-provider 的入参：[id] */
export const providerIdArgsSchema = z.tuple([z.string().min(1)])

/**
 * settings:list-provider-models 的回包条目（用户反馈 007）：模型 id + （端点给了才有）上下文长度。
 * "列得出来"与"看得清元数据"是两件事：端点不回 context_window 的条目照样列（只有 id）。
 */
export const providerModelOptionSchema = z.strictObject({
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional()
})

export type ProviderModelOption = z.infer<typeof providerModelOptionSchema>

/** settings:list-provider-models 的回包：可选项数组（读不到清单 = 空数组，不是错误） */
export const providerModelListResultSchema = z.array(providerModelOptionSchema)

/**
 * settings:discover-provider-models 的入参（用户反馈 007）：
 * `type` + 用户**刚填的** `baseUrl` + `apiKey`。
 * `apiKey` 允许空串，**不是"形状宽松"而是"业务上允许"**：本机服务（LM Studio / llama.cpp /
 * ollama）压根不要密钥，空着也要能试。空着就不发 Authorization 头，要不要认证由端点回
 * （401/403 才说"这个端点需要 API Key"）——闸门与界面都不替服务一刀切。
 * **明文只活这一次调用**——不落盘、不进日志。
 */
export const providerModelDiscoveryArgsSchema = z.tuple([
  z.strictObject({
    type: providerTypeSchema,
    baseUrl: z.string().optional(),
    apiKey: z.string()
  })
])

/**
 * settings:discover-provider-models 的回包：
 *   - `ok:true` 带清单（**空数组是合法的**：端点就是没给出模型，这是"读到了，只是空的"）；
 *   - `ok:false` 带一句人话（缺地址/密钥、认证失败、端点没有 /models、超时…）。
 * 两者必须分得开：弹窗对"读不到"要说原因，对"端点没有模型"要说"直接手填"。
 */
export const providerModelDiscoveryResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), models: z.array(providerModelOptionSchema) }),
  z.strictObject({ ok: z.literal(false), message: z.string() })
])

export type ProviderModelDiscoveryResult = z.infer<typeof providerModelDiscoveryResultSchema>

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
 * 工作台（右侧边栏四项工具）的入参。
 * 文件/git 两族的第一个入参一律是 threadId、第二个是**相对会话根**的路径 —— 绝对路径
 * 只由主进程按 sessionRoots 解析，渲染端传不进来（与 workspace:list-files 同一套纪律）。
 */
export const workbenchRelativeArgsSchema = z.tuple([z.string().min(1), z.string()])

/** 只收 [threadId] 的工作台通道（git 总览） */
export const workbenchThreadArgsSchema = z.tuple([z.string().min(1)])

/** 提交历史条数上限（与 main/workbench-git.ts 的 GIT_LOG_MAX 一致） */
export const WORKBENCH_LOG_LIMIT = 200

export const workbenchGitLogArgsSchema = z.tuple([
  z.string().min(1),
  z.number().int().min(1).max(WORKBENCH_LOG_LIMIT)
])

export const workbenchGitShowArgsSchema = z.tuple([z.string().min(1), z.string().min(1)])

/**
 * round 44：workbench:search 的入参：[threadId, query, mode]。
 * query 的**长度是业务口径**（trim 后至少 SEARCH_QUERY_MIN 个字），所以在这里就拦下来：
 * 一个字（比如 "a"）的搜索会把整个工作区翻一遍，不值得。
 */
export const workbenchSearchArgsSchema = z.tuple([
  z.string().min(1),
  z.string().refine((value) => value.trim().length >= SEARCH_QUERY_MIN, {
    message: `查询至少 ${SEARCH_QUERY_MIN} 个字符`
  }),
  workbenchSearchModeSchema
])

/** terminal:start 的入参：[threadId, cols, rows]（尺寸来自渲染端 FitAddon；主进程按 [1,1000] 收） */
export const terminalStartArgsSchema = z.tuple([
  z.string().min(1),
  z.number().int().min(1).max(1000),
  z.number().int().min(1).max(1000)
])

/** terminal:write 的入参：[id, data]（data 可以是空串——键盘事件里的修饰键单独到达） */
export const terminalWriteArgsSchema = z.tuple([z.string().min(1), z.string()])

/** terminal:resize 的入参：[id, cols, rows] */
export const terminalResizeArgsSchema = z.tuple([
  z.string().min(1),
  z.number().int().min(1).max(1000),
  z.number().int().min(1).max(1000)
])

/** terminal:dispose 的入参：[id] */
export const terminalDisposeArgsSchema = z.tuple([z.string().min(1)])

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
 * 一步诊断的 id（用户反馈 005：**分项验证**，不是"HTTP 200 就算能对话"）：
 *   - `connectivity` 连通：非流式请求能不能往返（地址 / 密钥 / 模型名对不对）；
 *   - `streaming`   流式：真消费 SSE，拿到正文且**正常收尾**才算数；
 *   - `tools`       流式工具：带一条只读探针工具再走一次**流式**调用，端点收下工具定义、
 *                   模型**合法**调用探针、探针真被执行拿到返回值才算通。
 * 为什么是这三项：本应用每一轮对话都是"流式 + 工具表"，只验其中一半就等于没验。
 */
export const connectionTestStepIdSchema = z.enum(['connectivity', 'streaming', 'tools'])

/**
 * 一步的结论。四档的区别要说清，因为它们**不是**成功/失败两分：
 *   - `passed`    这一步真跑过，且拿到了明确的正面证据；
 *   - `failed`    这一步真跑过，端点/网络/模型明确说了不行；
 *   - `unverified` 跑过了但**拿不到结论**（只有思考没有正文、被输出上限截断、模型没按提示调工具…）
 *                 —— 它既不是成功也不是失败，界面必须如实说"没验出来"，不许冒充成功；
 *   - `skipped`   前置那一步没过，这一步没跑。
 */
export const connectionTestStepStatusSchema = z.enum(['passed', 'failed', 'unverified', 'skipped'])

export const connectionTestStepSchema = z.strictObject({
  id: connectionTestStepIdSchema,
  status: connectionTestStepStatusSchema,
  /** 这一步花了多久（ms；`skipped` 没有） */
  latencyMs: z.number().optional(),
  /** 一句人话：这一步验的是什么、实际看到了什么（已抹掉密钥） */
  detail: z.string()
})

export type ConnectionTestStepId = z.infer<typeof connectionTestStepIdSchema>
export type ConnectionTestStepStatus = z.infer<typeof connectionTestStepStatusSchema>
export type ConnectionTestStep = z.infer<typeof connectionTestStepSchema>

/**
 * "测试连接"的结果（用户反馈 005 重写）。
 *
 * `ok` 的含义收窄为**"能对话"**：连通与流式两步都 `passed` 才是 true。
 * `unverified` 不算通过（没看到正文就不敢说能聊），也**不算失败**——它是一句"没验出来"，
 * 界面照它说话；注册照旧放行（验证是诊断，不是准入闸门：注册自由 > 能力门槛）。
 *
 * 失败文案与每一步的 detail 都已抹掉密钥（供应商可能回显，见 main/error-text.ts）。
 */
export const connectionTestResultSchema = z.strictObject({
  /** 能对话吗：连通 + 流式都 `passed` 才 true（工具那一步不参与这个判定，见 `steps`） */
  ok: z.boolean(),
  /** 从第一步开始到全部结束的总耗时（ms；配置不全、没跑起来时是 0） */
  latencyMs: z.number(),
  /** 逐步结论（顺序即执行顺序：连通 → 流式 → 工具；没跑到的是 `skipped`） */
  steps: z.array(connectionTestStepSchema),
  /** 有哪一步不是 `passed` 时的一句总结（已抹掉密钥）；三步全绿时没有 */
  message: z.string().optional(),
  /** 这次验证**覆盖不到**什么（005 要求"明确说明验证范围"）；界面必须显示它 */
  scopeNote: z.string()
})

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>

/**
 * 验证范围的固定话术（主进程写在结果里，渲染端原样显示）。
 * 说清两件事：这一步**具体验了什么**（三步各自的形式，包括工具那步也是流式的、探针只读不落副作用），
 * 以及它**不能**保证什么（本应用真正的工具表在生产的长上下文 / 网络 / 端点限流下是否都兼容）。
 */
export const CONNECTION_TEST_SCOPE_NOTE =
  '验证范围：非流式往返、流式返回正文、以及一次**流式**的最小工具调用（探针只回显参数，不执行任何有副作用的工具）。它不能保证本应用的全部工具、长上下文与真实网络下都兼容——注册只是放行，真实可用性以第一轮对话为准。'

/** 无入参通道的入参 schema：ipcRenderer.invoke 不给参数时 args 为空数组 */
export const noArgsSchema = z.tuple([])

/**
 * 模块 3B：「本地模型」通道的入参。
 *   - 下载/设为生效/删除：单个模型 id（形状校验在这里，id 认不认识由主进程查清单）；
 *   - 取消 / 选自定义 / 总览：无入参（noArgsSchema）。
 * 自定义模型的路径**不在入参里**：它只能由主进程的原生选择器写（同工作区/项目的纪律）。
 */
export const localModelIdArgsSchema = z.tuple([z.string().min(1)])

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
 * 新版本"给人看的那部分"（0.1.1 起：更新源 latest.yml 里的 releaseNotes / releaseName /
 * releaseDate）。三个都是可选的，缺了就不显示、不影响更新。
 *
 * `notes` 是**纯文本**：主进程已经把 electron-updater 的两种形状（string / `[{version, note}]`）
 * 归一成一个字符串（见 main/updater.ts 的 notesOf），渲染端按纯文本显示，不做 HTML/Markdown 注入。
 */
const updateReleaseShape = {
  notes: z.string().optional(),
  releaseName: z.string().optional(),
  releaseDate: z.string().optional()
}

/**
 * 一次更新检视的状态：按相位判别（每个相位只带自己那几个字段——`idle` 带上 percent 是形状错误，
 * 不是"多余信息"）。version 只在有新版本时给；percent 只在下载中给；message 只在 error 时给
 * （已截断、不带栈）；发行说明只在"有新版本"的那三个阶段给（available / downloading / downloaded
 * 都带着**同一个版本**的那一份）。
 */
export const updateStatusSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('idle') }),
  z.strictObject({ phase: z.literal('checking') }),
  z.strictObject({ phase: z.literal('up-to-date') }),
  z.strictObject({
    phase: z.literal('available'),
    version: z.string().optional(),
    ...updateReleaseShape
  }),
  z.strictObject({
    phase: z.literal('downloading'),
    version: z.string().optional(),
    percent: z.number().optional(),
    ...updateReleaseShape
  }),
  z.strictObject({
    phase: z.literal('downloaded'),
    version: z.string().optional(),
    ...updateReleaseShape
  }),
  z.strictObject({ phase: z.literal('error'), message: z.string().optional() })
])

/**
 * 渲染端看到的更新全貌：当前版本 + 有没有配更新源 + 状态。
 * `configured=false` 时"检查更新"只回状态（不发网络请求）——开发态/未配置的路径不报错、不骚扰。
 *
 * round 63：多了 `builtinUrl` —— 打包时烘焙进 app-update.yml 的源地址（没有 = null）。
 * 设置页拿它当更新源输入框的占位提示：用户一眼能看见"留空会用哪个源"。
 */
export const updateStateSchema = z.strictObject({
  currentVersion: z.string(),
  configured: z.boolean(),
  builtinUrl: z.string().nullable(),
  status: updateStatusSchema
})

export type UpdatePhase = z.infer<typeof updatePhaseSchema>
export type UpdateStatus = z.infer<typeof updateStatusSchema>
export type UpdateState = z.infer<typeof updateStateSchema>

/**
 * 「本版本发行说明」（本轮，随包）：设置页「关于」那个常驻的「更新日志」入口读它 ——
 * 断网 / 已是最新 / 没配更新源时，用户仍然能看到"我现在装的这一版改了什么"。
 *
 * 三态，**缺失与读异常分开**（界面给不同的话，不许把"读不出来"说成"没有说明"）：
 *   - `ok`：`version` 是**本机版本**（主进程给 `app.getVersion()`，渲染端拿它当标题，
 *     不自己拼版本号）；`notes` 是纯文本正文（渲染端按文本子节点显示，HTML 不执行）；
 *   - `missing`：这一版没有随发行说明（老包里没有、开发态没写日志）；
 *   - `unreadable`：有文件但用不了（超过大小上限 / 读失败）——`message` 是主进程写好的
 *     一句人话（不含路径、不含堆栈）。
 *
 * 与 `updateStatusSchema` 里那份 `notes` 是**两件事**，各标各的版本：那份是**源上新版本**的
 * 日志（只在检出更新时才有），这份是**当前已安装版本**的日志（随包，离线可得）。
 */
export const bundledReleaseNotesSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ok'), version: z.string(), notes: z.string() }),
  z.strictObject({ state: z.literal('missing') }),
  z.strictObject({ state: z.literal('unreadable'), message: z.string() })
])

export type BundledReleaseNotes = z.infer<typeof bundledReleaseNotesSchema>

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
 * round 32：思考翻译的入参。
 *   - `translate:run`：[{ text, targetLanguage? }] —— text 有界（TRANSLATE_MAX_CHARS），
 *     targetLanguage 可省（主进程按设置里的目标语言兜底）；
 *   - `translate:key-state` / `clear-key`：无入参；`set-key`：单个非空字符串（同 provider 密钥口径）。
 */
export const translateRunArgsSchema = z.tuple([
  z.strictObject({
    text: z.string().min(1).max(TRANSLATE_MAX_CHARS),
    targetLanguage: z.string().min(1).optional()
  })
])

export const translateKeyArgsSchema = z.tuple([z.string().min(1)])

/**
 * round 45：联网搜索的入参/回包。
 *   - `search:key-states` / `clear-key`：clear-key 收单个 target；key-states 不收参数；
 *   - `search:set-key`：[target, key]（target 三选一，key 非空；明文只在写方向出现一次）；
 *   - 状态回包是 target → ProviderKeyState 的记录（与 provider 密钥同形状，复用同一份 schema）。
 */
export const searchSetKeyArgsSchema = z.tuple([z.enum(SEARCH_KEY_TARGETS), z.string().min(1)])

export const searchClearKeyArgsSchema = z.tuple([z.enum(SEARCH_KEY_TARGETS)])

export const searchKeyStatesSchema = z.record(z.string(), providerKeyStateSchema)

export type SearchKeyStates = Record<SearchKeyTarget, ProviderKeyState>

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
  /**
   * 用户反馈 007：列出该 provider 端点上的可选项（GET /models，**只读不落盘**）。
   * 读不到（端点没有 /models、没有密钥、认证失败、超时…）回空数组——不是错误，弹窗按"手填"兜底。
   */
  listProviderModels(id: string): Promise<ProviderModelOption[]>
  /**
   * 用户反馈 007：拿**刚填的**地址与密钥发现模型（还没保存的新渠道也走它）。
   * `ok:false` 是带原因的一等结果（不是异常）；密钥只在这一次调用里存在，不回包、不落盘。
   */
  discoverProviderModels(input: {
    type: ProviderType
    baseUrl?: string
    apiKey: string
  }): Promise<ProviderModelDiscoveryResult>
}

/** preload 暴露给渲染端的 agent 服务面（服务未起时 endpoint() 会 reject） */
export interface KyclawAgentApi {
  endpoint(): Promise<AgentEndpoint>
}

/**
 * preload 暴露给渲染端的附件面（模块 2）：目前只有 PDF 文字层抽取。
 * 结果形状走 `pdfExtractResultSchema`（`ok:false` 是产品语言，不当异常）。
 */
export interface KyclawAttachmentsApi {
  extractPdf(bytes: Uint8Array): Promise<PdfExtractResult>
}

/**
 * preload 暴露给渲染端的**本地文件小桥**（round 53）：只有一件事 —— 把一个 `File` 换回它
 * 在磁盘上的绝对路径（Electron `webUtils.getPathForFile`）。
 *
 * 为什么必须过 preload：`File.path` 在 Electron 32 起退役，而 `webUtils` 只存在于
 * preload / 主进程侧（渲染端在 contextIsolation 下拿不到 electron 模块）。
 * 拿不到路径的来源（内存里造的 File、跨进程塞来的 blob）一律回 `''`——调用方按"拿不到"兜底，
 * 不抛（这条桥是同步的纯查询，异常只会打断附件管线）。
 */
export interface KyclawFilesApi {
  pathForFile(file: File): string
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
  /**
   * 本版本随包发行说明（本轮）：无入参（读哪个文件由主进程按 app.getVersion() 定），
   * 纯读盘、不发网络请求 —— 断网 / 已是最新时也能答。
   */
  releaseNotes(): Promise<BundledReleaseNotes>
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
  /** 指认默认工作区（原生选择器；取消 = 不改动）——未指定项目的会话在它下面的会话子目录里干活 */
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
  rulesStatus(): Promise<import('./rules-ipc').RulesStatus>
  readRules(projectId: string): Promise<import('./rules-ipc').ProjectRulesView>
  saveRules(
    projectId: string,
    text: string
  ): Promise<import('./rules-ipc').ProjectRulesSaveResponse>
}

/**
 * preload 暴露给渲染端的工作台面（右侧边栏四项工具里的文件 / Git 两项）。
 * 三个共同纪律：
 *   1. 第一个入参是 threadId —— 会话根在主进程按 sessionRoots 同口径解析（渲染端传不了绝对路径）；
 *   2. 第二个入参是**相对会话根**的路径/提交 sha，形状过闸门、containment 在主进程判；
 *   3. 回包结构不对就抛（半截目录/半截提交没法显示），不静默回退。
 */
export interface KyclawWorkbenchApi {
  /** 列会话根下一层目录（`relative = ''` 就是根本身）；越权路径与不存在的目录都抛人话 */
  listDir(threadId: string, relative: string): Promise<ListDirResult>
  /** 读一个文件做预览（文本有界 64KB；二进制/超大给判别结果，不吐乱码） */
  readFile(threadId: string, relative: string): Promise<FilePreview>
  /**
   * round 40：读一个文件的原始字节（图片 / PDF 的按格式预览）。
   * 扩展名与文件头双重判定；认不出、超上限、文件没了各自给判别结果（不抛）。
   */
  readBytes(threadId: string, relative: string): Promise<FileBytesResult>
  /**
   * round 44：在会话根下搜索。`mode='name'` 按文件名、`mode='content'` 按文件内容；
   * query trim 后不足 SEARCH_QUERY_MIN 个字符不发（发出去也会被闸门拒）。
   */
  search(threadId: string, query: string, mode: WorkbenchSearchMode): Promise<WorkbenchSearchResult>
  /** 在系统文件资源管理器里打开（目录）或定位（文件）；返回真正给的绝对路径 */
  reveal(threadId: string, relative: string): Promise<{ path: string }>
  /**
   * 用系统默认应用打开这个文件（本机装了 Word / WPS / Excel 时就是它们）。
   * 只放行**文档与媒体**（Office 三件 / PDF / 图片 / 表格 / 纯文本，见主进程那张扩展名表）：
   * 目录一律拒（打开文件夹请走 reveal），可执行/脚本/快捷方式一律拒，打不开时抛人话错误 ——
   * 不假装打开。
   */
  open(threadId: string, relative: string): Promise<{ path: string }>
  /**
   * 办公档（doc / docx / ppt / pptx）转成 PDF 给预览用：
   * **真按页看**（版式、图、表格都在），渲染端拿回的字节直接交给既有的 PDF 预览组件。
   *
   * `requestId` 由渲染端生成（每次预览一个新值），只用来取消 —— 见 `cancelOfficePdf`。
   * `priority='foreground'` 是用户正在看的这一份；`'background'` 是预热（现在没人用，
   * 但队列的准入/淘汰语义按它分档：后台只在有富余时跑，且会被前台挤掉）。
   *
   * 失败不抛而是回 `kind:'failed'`（带分类与中文人话）——**越权路径**才是抛（fail closed）。
   * 文件的**前半截**在库里查得到（会话根 + containment + 前后 stat + 有界读），
   * 这里只说渲染端看得到的：它只递"树上哪一条"，永远递不了绝对路径。
   */
  officePdf(
    threadId: string,
    relative: string,
    priority: OfficePreviewPriority,
    requestId: string
  ): Promise<OfficePreviewResult>
  /**
   * 取消一次办公档转换（幂等，无回包）。**只对本窗口发起的请求有效**：
   * 主进程按 webContents 绑归属，另一个窗口拿同一个 id 取消是空操作。
   * 取消后原来那一路回 `kind:'failed', code:'cancelled'`（不是 reject）。
   */
  cancelOfficePdf(requestId: string): Promise<void>
  /**
   * 表格（xls / xlsx / csv / tsv）的**原始字节**：给要在渲染端自己解析工作簿的预览用。
   * 与 `readBytes`（那条回主进程抽好的结构）刻意分开，互不影响；后缀 + 文件头双重判定，
   * 读的当口文件在变时回 `kind:'changed'`（不交半截快照）。
   */
  tableBytes(threadId: string, relative: string): Promise<TableBytesResult>
  /**
   * 文本分页：读一页（`cursor = null` 是第一页，之后用上一页回的 `{ offset, version }`）。
   * 页边界落在换行之后并从 UTF-8 字符边界上收 —— 各页**直接拼接**就是原文；超长单行按 32KB
   * 切开（`overlongLine` 为真时界面如实说明）。文件与 `version` 不符、或读的当口在变，回
   * `kind:'changed'`（不交半截快照）；NUL 回 `binary`；超过 64MB 回 `too-large`。
   */
  readTextPage(
    threadId: string,
    relative: string,
    cursor: TextPageCursor | null
  ): Promise<TextPageResult>
  /**
   * 只 stat：文本文件现在的版本（`size:mtimeMs`）与大小。给"文件变了没有"的**受控轮询**用
   * （渲染端只在窗口可见且预览在前台时轮询；卸载即停）。文件没了回 `kind:'missing'`。
   */
  textVersion(threadId: string, relative: string): Promise<TextVersionResult>
  /** 仓库总览：分支 + 未提交变更；不是仓库/空仓库由 isRepo / empty 表达（不抛） */
  gitOverview(threadId: string): Promise<GitOverview>
  /** 提交历史（`--graph` 解析后的结构化行，上限 200） */
  gitLog(threadId: string, limit: number): Promise<{ commits: GitCommit[] }>
  /** 单提交详情：作者/时间/完整 message + 变更文件统计 */
  gitShow(threadId: string, sha: string): Promise<GitCommitDetail>
}

/**
 * preload 暴露给渲染端的终端面（右侧边栏「终端」工具）：
 * 一个渲染端 id ↔ 一个主进程 PTY。数据与退出都走推送（`onData` / `onExit`），
 * 应用退出时主进程会杀干净并推一次 exit（界面据此收尾，不留假终端）。
 */
export interface KyclawTerminalApi {
  /** 起一个交互式终端（cwd = 会话根，shell = Git Bash）；会话根判不出时抛人话 */
  start(threadId: string, cols: number, rows: number): Promise<TerminalSession>
  /** 写输入（键盘直接透传） */
  write(id: string, data: string): Promise<void>
  /** 窗口/面板尺寸变化后同步 cols/rows */
  resize(id: string, cols: number, rows: number): Promise<void>
  /** 关掉这个终端（幂等；再写就是空操作） */
  dispose(id: string): Promise<void>
  /** 订阅输出，返回退订函数 */
  onData(listener: (payload: { id: string; data: string }) => void): () => void
  /** 订阅进程结束，返回退订函数 */
  onExit(listener: (payload: TerminalExit) => void): () => void
}

/** `window.kyclaw` 的全部能力（后续任务按通道族追加） */
export interface KyclawApi {
  window: KyclawWindowApi
  settings: KyclawSettingsApi
  workspace: KyclawWorkspaceApi
  workbench: KyclawWorkbenchApi
  terminal: KyclawTerminalApi
  projects: KyclawProjectsApi
  agent: KyclawAgentApi
  /** 模块 2：附件能力（PDF 文字层抽取；抽取在主进程） */
  attachments: KyclawAttachmentsApi
  /** round 53：本地文件小桥（File → 绝对路径；附件改走路径引用的取路径入口） */
  files: KyclawFilesApi
  updates: KyclawUpdatesApi
  telemetry: KyclawTelemetryApi
  plugins: KyclawPluginsApi
  memory: KyclawMemoryApi
  localModels: KyclawLocalModelsApi
  translate: KyclawTranslateApi
  /** round 45：联网搜索的三个可选 Key（Exa / Tavily / Jina）的写/清/状态 */
  search: KyclawSearchApi
}

/**
 * preload 暴露给渲染端的记忆面（round 28，只有语义召回的远程嵌入密钥）：
 * 开关与来源是普通设置（settings:update 的补丁里就有），这里只管密钥的写/清/状态——
 * 与 provider / Langfuse 同一套纪律：写方向见明文一次，读方向永远只有"有没有 / 要不要重录"。
 * （本机引擎这一路没有用户密钥：网关那把 key 是主进程每次启动现生成的，见 main/llama/service.ts。）
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
 * preload 暴露给渲染端的思考翻译面（round 32）：翻一段文本 + 可选 API Key 的写/清/状态。
 * 与 provider / Langfuse / 嵌入密钥同一套纪律：**明文只在写方向上出现一次**，读方向只有
 * "有没有 / 要不要重录"；请求本身由主进程发（地址/模型/超时/密钥全留在主进程内存里）。
 */
export interface KyclawTranslateApi {
  /**
   * 翻译一段文本（目标语言不写就用设置里的那个）。失败回 `{ok:false, message}`（人话），
   * 不抛 —— 译文拿不到是常态（服务没开、模型不在），界面要能原样留着并给重试。
   */
  run(input: { text: string; targetLanguage?: string }): Promise<TranslateResult>
  /** 可选 API Key 的状态（没有 = 没配过；本 LAN 服务不需要 key） */
  keyState(): Promise<ProviderKeyState>
  /** 写密钥：成功只回 {hasKey:true}（明文永不回渲染端） */
  setKey(key: string): Promise<{ hasKey: true }>
  /** 清除密钥（幂等；返回清除后的状态） */
  clearKey(): Promise<ProviderKeyState>
}

/**
 * preload 暴露给渲染端的联网搜索面（round 45）：三个可选 Key 的写/清/状态。
 * 与 provider / Langfuse / 嵌入 / 翻译密钥同一套纪律：**明文只在写方向上出现一次**，
 * 读方向只有"有没有 / 要不要重录"；后端模式/服务商/地址是普通设置（走 settings:update），
 * 搜索请求本身在 agent 进程里发（渲染端拿不到 Key，也不需要）。
 */
export interface KyclawSearchApi {
  /** Exa / Tavily / Jina 三档 Key 的状态（没有 = 没配过） */
  keyStates(): Promise<SearchKeyStates>
  /** 写一个 Key：成功只回 {hasKey:true}（明文永不回渲染端） */
  setKey(target: SearchKeyTarget, key: string): Promise<{ hasKey: true }>
  /** 清除一个 Key（幂等；返回清除后的三份状态） */
  clearKey(target: SearchKeyTarget): Promise<SearchKeyStates>
}

/**
 * preload 暴露给渲染端的「本地模型」面（模块 3B）：模型清单/下载/删除/生效 + 引擎相位。
 * 每个动作都回**新的总览**（与 workspace/plugins 同一口径：界面以主进程的真相为准）；
 * `download` 不等到下完（600MB 级要几分钟）——立刻回总览，进度经 `onChanged` 推。
 * 自定义模型的路径只由主进程的原生选择器写（`pickCustom`），渲染端传不了任意路径。
 */
export interface KyclawLocalModelsApi {
  overview(): Promise<LocalModelsOverview>
  download(id: string): Promise<LocalModelsOverview>
  cancel(): Promise<LocalModelsOverview>
  select(id: string): Promise<LocalModelsOverview>
  /** 打开原生选择器挑一个本机 GGUF 并设为生效（取消 = 不改动） */
  pickCustom(): Promise<LocalModelsOverview>
  remove(id: string): Promise<LocalModelsOverview>
  /** 订阅总览变化（下载进度、引擎相位），返回退订函数 */
  onChanged(listener: (overview: LocalModelsOverview) => void): () => void
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
