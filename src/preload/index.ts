/**
 * preload：类型化 IPC 桥（spec §2.1「preload 暴露的类型化 IPC（白名单）」）。
 * 只暴露 kyclaw 这一族方法——模板的通用 `electron` 桥（直接把 ipcRenderer 递给渲染端）
 * 在这里退役：渲染端拿不到任意通道，通道名与 payload 形状都收敛在 shared/ipc.ts。
 *
 * 渲染端是"不可信输入"侧，所以主进程侧还要再校验一遍入参（main/ipc/window.ts）；
 * 反方向（主进程推送）在这里用同一份 schema 解析，结构不对就不交给上层。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  agentEndpointSchema,
  connectionTestResultSchema,
  IPC_CHANNELS,
  langfuseStateSchema,
  projectBaseSchema,
  projectFolderSchema,
  projectOpenInExplorerResultSchema,
  providerKeyStatesSchema,
  setLangfuseKeysResultSchema,
  setProviderKeyResultSchema,
  updateStateSchema,
  windowStateSchema,
  workspaceListFilesResultSchema,
  workspaceOpenInExplorerResultSchema,
  type KyclawAgentApi,
  type KyclawApi,
  type KyclawAttachmentsApi,
  type KyclawLocalModelsApi,
  type KyclawMemoryApi,
  type KyclawPluginsApi,
  type KyclawProjectsApi,
  type KyclawSettingsApi,
  type KyclawTelemetryApi,
  type KyclawTranslateApi,
  type KyclawUpdatesApi,
  type KyclawWindowApi,
  type KyclawWorkbenchApi,
  type KyclawTerminalApi,
  type KyclawWorkspaceApi,
  type UpdateState
} from '../shared/ipc'
import { pdfExtractResultSchema } from '../shared/attachments'
import { translateResultSchema } from '../shared/translate'
import { localModelsOverviewSchema, type LocalModelsOverview } from '../shared/local-models'
import { appSettingsSchema, defaultSettings, type AppSettings } from '../shared/settings'
import { providerKeyStateSchema } from '../shared/providers'
import {
  pluginsOverviewSchema,
  pluginIconResponseSchema,
  type PluginsOverview
} from '../shared/plugins'
import {
  fileBytesResultSchema,
  filePreviewSchema,
  gitCommitDetailSchema,
  gitLogResultSchema,
  gitOverviewSchema,
  listDirResultSchema,
  revealResultSchema,
  terminalDataSchema,
  terminalExitSchema,
  terminalSessionSchema,
  type FileBytesResult,
  type FilePreview,
  type GitCommit,
  type GitCommitDetail,
  type GitOverview,
  type ListDirResult,
  type TerminalExit,
  type TerminalSession
} from '../shared/workbench'

const windowApi: KyclawWindowApi = {
  minimize: () => {
    void ipcRenderer.invoke(IPC_CHANNELS.window.minimize)
  },
  maximize: () => {
    void ipcRenderer.invoke(IPC_CHANNELS.window.maximize)
  },
  close: () => {
    void ipcRenderer.invoke(IPC_CHANNELS.window.close)
  },
  isMaximized: async () => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.window.isMaximized)
    return typeof result === 'boolean' ? result : false
  },
  onStateChanged: (listener) => {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = windowStateSchema.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(IPC_CHANNELS.window.stateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.window.stateChanged, handler)
    }
  }
}

/** 主进程回的设置：结构不对就当没读到（回默认值），不让半截对象进渲染端。
    这里留一条 warn：静默回退过一次就够难受了（T5 实测过 zod 在 CSP 下抛 EvalError 的那种静默），
    下次出问题时至少控制台里有话说。 */
function parseSettings(payload: unknown): AppSettings {
  const parsed = appSettingsSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  console.warn('[kyclaw] 设置响应结构不合法，回退默认值', payload)
  return defaultSettings()
}

const settingsApi: KyclawSettingsApi = {
  get: async () => parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.settings.get)),
  update: async (patch) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.settings.update, patch)),
  // 密钥写方向：回包只该是 {hasKey:true}；多一个字段都不交给上层（防"顺手回显明文"）
  setProviderKey: async (id, key) => {
    const parsed = setProviderKeyResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.settings.setProviderKey, id, key)
    )
    if (!parsed.success) throw new Error('[kyclaw] 密钥保存响应结构不合法')
    return parsed.data
  },
  providerKeyStates: async () => {
    const parsed = providerKeyStatesSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.settings.providerKeyStates)
    )
    if (!parsed.success) throw new Error('[kyclaw] 密钥状态响应结构不合法')
    return parsed.data
  },
  testProvider: async (id) => {
    const parsed = connectionTestResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.settings.testProvider, id)
    )
    if (!parsed.success) throw new Error('[kyclaw] 连接测试响应结构不合法')
    return parsed.data
  },
  removeProvider: async (id) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.settings.removeProvider, id)),
  // round 22：模型元数据探测（静默失败，回合并后的设置——半截不用防，parseSettings 兜底）
  probeModels: async (id) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.settings.probeModels, id))
}

/**
 * 工作区面：授权目录的增删与访问模式。回包与设置同一份 schema（就是落盘后的完整设置），
 * 结构不对就当没读到（回默认值）——不给渲染端半截对象。
 * 路径合法性不由这里管：主进程会在写授权列表之前校验（存在、是目录、非 UNC）；
 * `add` 一律 ask、`setMode` 只认已授权路径（T13：full 只能显式切换）。
 */
const workspaceApi: KyclawWorkspaceApi = {
  pick: async () => parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.pick)),
  add: async (path) => parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.add, path)),
  setMode: async (path, mode) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.setMode, path, mode)),
  remove: async (path) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.remove, path)),
  pickDefault: async () =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.pickDefault)),
  // round 15：@ 文件列表（相对会话根；结构不对就抛——半截清单没法显示）
  listFiles: async (threadId) => {
    const parsed = workspaceListFilesResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workspace.listFiles, threadId)
    )
    if (!parsed.success) throw new Error('[kyclaw] 文件列表响应结构不合法')
    return parsed.data
  },
  // round 20：在文件资源管理器里打开会话根（结构不对就抛——路径是打开动作的凭据）
  openInExplorer: async (threadId) => {
    const parsed = workspaceOpenInExplorerResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workspace.openInExplorer, threadId)
    )
    if (!parsed.success) throw new Error('[kyclaw] 打开文件夹响应结构不合法')
    return parsed.data
  }
}

/**
 * 项目面（T18）：创建对话框要的两块料 + 建/删。
 * 回包与设置同一份 schema（建/删回吐完整设置）；`base` / `pickFolder` 各自的形状也过 schema，
 * 结构不对就抛（半截路径没法用）。
 */
const projectsApi: KyclawProjectsApi = {
  base: async () => {
    const parsed = projectBaseSchema.safeParse(await ipcRenderer.invoke(IPC_CHANNELS.projects.base))
    if (!parsed.success) throw new Error('[kyclaw] 项目基底响应结构不合法')
    return parsed.data
  },
  pickFolder: async () => {
    const parsed = projectFolderSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.projects.pickFolder)
    )
    if (!parsed.success) throw new Error('[kyclaw] 项目文件夹响应结构不合法')
    return parsed.data
  },
  create: async (name, path) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.projects.create, { name, path })),
  remove: async (id) => parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.projects.remove, id)),
  // round 25：重命名 / 在文件资源管理器里打开（路径解析在主进程）
  rename: async (id, name) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.projects.rename, { id, name })),
  openInExplorer: async (id) => {
    const parsed = projectOpenInExplorerResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.projects.openInExplorer, id)
    )
    if (!parsed.success) throw new Error('[kyclaw] 打开项目文件夹响应结构不合法')
    return parsed.data
  }
}

/** 主进程回的端点：结构不对就抛（半截端点没法用，宁可让上层看到失败） */
const agentApi: KyclawAgentApi = {
  endpoint: async () => {
    const parsed = agentEndpointSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.agent.endpoint)
    )
    if (!parsed.success) throw new Error('[kyclaw] agent 端点响应结构不合法')
    return parsed.data
  }
}

/**
 * 附件面（模块 2）：PDF 文字层抽取在主进程跑。
 * `ok:false` 是产品语言的一等结果（扫描件/加密/坏文件），不当异常；只有**结构不合法**才抛。
 */
const attachmentsApi: KyclawAttachmentsApi = {
  extractPdf: async (bytes) => {
    const parsed = pdfExtractResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.attachments.extractPdf, bytes)
    )
    if (!parsed.success) throw new Error('[kyclaw] PDF 抽取响应结构不合法')
    return parsed.data
  }
}

/**
 * 更新面（T17）：状态读取/手动检查/重启安装 + 订阅推送。
 * 与窗口状态推送同一套纪律：payload 过同一份 schema，结构不对就不交给上层。
 * 结构不对一律抛（不做"回退默认值"）：更新状态是给用户看的判断依据，编一个"未配置"比报错更糟。
 */
const updatesApi: KyclawUpdatesApi = {
  state: async () => parseUpdateState(await ipcRenderer.invoke(IPC_CHANNELS.updates.state)),
  check: async () => parseUpdateState(await ipcRenderer.invoke(IPC_CHANNELS.updates.check)),
  install: async () => {
    await ipcRenderer.invoke(IPC_CHANNELS.updates.install)
  },
  onStateChanged: (listener) => {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = updateStateSchema.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(IPC_CHANNELS.updates.stateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.updates.stateChanged, handler)
    }
  }
}

function parseUpdateState(payload: unknown): UpdateState {
  const parsed = updateStateSchema.safeParse(payload)
  if (!parsed.success) throw new Error('[kyclaw] 更新状态响应结构不合法')
  return parsed.data
}

/**
 * 可观测面（T17）：Langfuse 的配置状态 + 写/清密钥。
 * 密钥回包只有 {hasKeys:true}（多一个字段都不交给上层，防"顺手回显明文"）；
 * 状态回包结构不对就抛（半截状态没法显示）。
 */
const telemetryApi: KyclawTelemetryApi = {
  langfuseState: async () => {
    const parsed = langfuseStateSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.telemetry.langfuseState)
    )
    if (!parsed.success) throw new Error('[kyclaw] Langfuse 状态响应结构不合法')
    return parsed.data
  },
  setLangfuseKeys: async (publicKey, secretKey) => {
    const parsed = setLangfuseKeysResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.telemetry.setLangfuseKeys, publicKey, secretKey)
    )
    if (!parsed.success) throw new Error('[kyclaw] Langfuse 密钥保存响应结构不合法')
    return parsed.data
  },
  clearLangfuseKeys: async () => {
    const parsed = langfuseStateSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.telemetry.clearLangfuseKeys)
    )
    if (!parsed.success) throw new Error('[kyclaw] Langfuse 状态响应结构不合法')
    return parsed.data
  }
}

/**
 * 记忆面（round 28）：语义召回的远程嵌入密钥——与 provider / Langfuse 同一套纪律
 * （写方向见一次明文，读方向只有"有没有 / 要不要重录"）。
 */
const memoryApi: KyclawMemoryApi = {
  embeddingKeyState: async () => {
    const parsed = providerKeyStateSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.memory.embeddingKeyState)
    )
    if (!parsed.success) throw new Error('[kyclaw] 嵌入密钥状态响应结构不合法')
    return parsed.data
  },
  setEmbeddingKey: async (key) => {
    const parsed = setProviderKeyResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.memory.setEmbeddingKey, key)
    )
    if (!parsed.success) throw new Error('[kyclaw] 嵌入密钥保存响应结构不合法')
    return parsed.data
  },
  clearEmbeddingKey: async () => {
    const parsed = providerKeyStateSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.memory.clearEmbeddingKey)
    )
    if (!parsed.success) throw new Error('[kyclaw] 嵌入密钥状态响应结构不合法')
    return parsed.data
  }
}

/**
 * 思考翻译面（round 32）：翻译一段文本 + 可选密钥的写/清/状态。
 * `run` 的失败是产品语言的一等结果（`{ok:false, message}` 原样交给上层，不抛）；
 * 密钥与 provider / 嵌入密钥同一套纪律：回包只有"有没有"，多一个字段都不交给上层。
 */
const translateApi: KyclawTranslateApi = {
  run: async (input) => {
    const parsed = translateResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.translate.run, input)
    )
    if (!parsed.success) throw new Error('[kyclaw] 翻译响应结构不合法')
    return parsed.data
  },
  keyState: async () => {
    const parsed = providerKeyStateSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.translate.keyState)
    )
    if (!parsed.success) throw new Error('[kyclaw] 翻译密钥状态响应结构不合法')
    return parsed.data
  },
  setKey: async (key) => {
    const parsed = setProviderKeyResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.translate.setKey, key)
    )
    if (!parsed.success) throw new Error('[kyclaw] 翻译密钥保存响应结构不合法')
    return parsed.data
  },
  clearKey: async () => {
    const parsed = providerKeyStateSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.translate.clearKey)
    )
    if (!parsed.success) throw new Error('[kyclaw] 翻译密钥状态响应结构不合法')
    return parsed.data
  }
}

/**
 * 「本地模型」面（模块 3B）：动作都回**新的总览**（结构不对就抛——半截总览没法显示），
 * 进度推送用同一份 schema 解析（结构不对就不交给上层，同更新通道的做法）。
 */
const localModelsApi: KyclawLocalModelsApi = {
  overview: async () =>
    parseLocalModels(await ipcRenderer.invoke(IPC_CHANNELS.localModels.overview)),
  download: async (id) =>
    parseLocalModels(await ipcRenderer.invoke(IPC_CHANNELS.localModels.download, id)),
  cancel: async () => parseLocalModels(await ipcRenderer.invoke(IPC_CHANNELS.localModels.cancel)),
  select: async (id) =>
    parseLocalModels(await ipcRenderer.invoke(IPC_CHANNELS.localModels.select, id)),
  pickCustom: async () =>
    parseLocalModels(await ipcRenderer.invoke(IPC_CHANNELS.localModels.pickCustom)),
  remove: async (id) =>
    parseLocalModels(await ipcRenderer.invoke(IPC_CHANNELS.localModels.remove, id)),
  onChanged: (listener) => {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = localModelsOverviewSchema.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(IPC_CHANNELS.localModels.progressChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.localModels.progressChanged, handler)
    }
  }
}

function parseLocalModels(payload: unknown): LocalModelsOverview {
  const parsed = localModelsOverviewSchema.safeParse(payload)
  if (!parsed.success) throw new Error('[kyclaw] 本地模型响应结构不合法')
  return parsed.data
}

/**
 * 插件面（round 10）：市场与插件的动作都回**新的总览**；结构不对就抛（半截总览没法显示）。
 */
const pluginsApi: KyclawPluginsApi = {
  overview: async () => parseOverview(await ipcRenderer.invoke(IPC_CHANNELS.plugins.overview)),
  addMarketplace: async (input) =>
    parseOverview(await ipcRenderer.invoke(IPC_CHANNELS.plugins.addMarketplace, input)),
  refreshMarketplace: async (id) =>
    parseOverview(await ipcRenderer.invoke(IPC_CHANNELS.plugins.refreshMarketplace, id)),
  removeMarketplace: async (id) =>
    parseOverview(await ipcRenderer.invoke(IPC_CHANNELS.plugins.removeMarketplace, id)),
  install: async (marketplaceId, name) =>
    parseOverview(await ipcRenderer.invoke(IPC_CHANNELS.plugins.install, { marketplaceId, name })),
  uninstall: async (id) =>
    parseOverview(await ipcRenderer.invoke(IPC_CHANNELS.plugins.uninstall, id)),
  // round 23：插件图标（data URL；没有可用图标 = null）
  icon: async (marketplaceId, name) => {
    const parsed = pluginIconResponseSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.plugins.icon, marketplaceId, name)
    )
    if (!parsed.success) return { dataUrl: null }
    return parsed.data
  }
}

function parseOverview(payload: unknown): PluginsOverview {
  const parsed = pluginsOverviewSchema.safeParse(payload)
  if (!parsed.success) throw new Error('[kyclaw] 插件总览响应结构不合法')
  return parsed.data
}

/**
 * 工作台面（右侧边栏的文件 / Git 两项）：逐条动作都过 schema，结构不对就抛 ——
 * 半截目录树 / 半截提交没法显示（与 workspace.listFiles 同一口径）。
 */
const workbenchApi: KyclawWorkbenchApi = {
  listDir: async (threadId, relative) => {
    const parsed = listDirResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workbench.listDir, threadId, relative)
    )
    if (!parsed.success) throw new Error('[kyclaw] 目录内容响应结构不合法')
    return parsed.data satisfies ListDirResult
  },
  readFile: async (threadId, relative) => {
    const parsed = filePreviewSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workbench.readFile, threadId, relative)
    )
    if (!parsed.success) throw new Error('[kyclaw] 文件预览响应结构不合法')
    return parsed.data satisfies FilePreview
  },
  readBytes: async (threadId, relative) => {
    const parsed = fileBytesResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workbench.readBytes, threadId, relative)
    )
    if (!parsed.success) throw new Error('[kyclaw] 文件字节响应结构不合法')
    return parsed.data satisfies FileBytesResult
  },
  reveal: async (threadId, relative) => {
    const parsed = revealResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workbench.reveal, threadId, relative)
    )
    if (!parsed.success) throw new Error('[kyclaw] 打开路径响应结构不合法')
    return parsed.data
  },
  gitOverview: async (threadId) => {
    const parsed = gitOverviewSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workbench.gitOverview, threadId)
    )
    if (!parsed.success) throw new Error('[kyclaw] 仓库总览响应结构不合法')
    return parsed.data satisfies GitOverview
  },
  gitLog: async (threadId, limit) => {
    const parsed = gitLogResultSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workbench.gitLog, threadId, limit)
    )
    if (!parsed.success) throw new Error('[kyclaw] 提交历史响应结构不合法')
    return parsed.data satisfies { commits: GitCommit[] }
  },
  gitShow: async (threadId, sha) => {
    const parsed = gitCommitDetailSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.workbench.gitShow, threadId, sha)
    )
    if (!parsed.success) throw new Error('[kyclaw] 提交详情响应结构不合法')
    return parsed.data satisfies GitCommitDetail
  }
}

/**
 * 终端面（右侧边栏的「终端」）：一个 id 对一条 PTY。写/改尺寸/关闭都是 fire-and-forget
 * （界面不等回包）；两条推送（输出/退出）在这里过同一份 schema。
 */
const terminalApi: KyclawTerminalApi = {
  start: async (threadId, cols, rows) => {
    const parsed = terminalSessionSchema.safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.terminal.start, threadId, cols, rows)
    )
    if (!parsed.success) throw new Error('[kyclaw] 终端会话响应结构不合法')
    return parsed.data satisfies TerminalSession
  },
  write: async (id, data) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminal.write, id, data)
  },
  resize: async (id, cols, rows) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminal.resize, id, cols, rows)
  },
  dispose: async (id) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminal.dispose, id)
  },
  onData: (listener) => {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = terminalDataSchema.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(IPC_CHANNELS.terminal.data, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.terminal.data, handler)
    }
  },
  onExit: (listener) => {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = terminalExitSchema.safeParse(payload)
      if (parsed.success) listener(parsed.data satisfies TerminalExit)
    }
    ipcRenderer.on(IPC_CHANNELS.terminal.exit, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.terminal.exit, handler)
    }
  }
}

export const kyclawApi: KyclawApi = {
  window: windowApi,
  settings: settingsApi,
  workspace: workspaceApi,
  workbench: workbenchApi,
  terminal: terminalApi,
  projects: projectsApi,
  agent: agentApi,
  attachments: attachmentsApi,
  updates: updatesApi,
  telemetry: telemetryApi,
  plugins: pluginsApi,
  memory: memoryApi,
  localModels: localModelsApi,
  translate: translateApi
}

// contextIsolation 默认开（窗口配置没有关它）；关掉时退回直接挂到 window。
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('kyclaw', kyclawApi)
} else {
  // contextIsolation 被关掉时才走这里（窗口配置没有关它）；声明在 index.d.ts（渲染端读的那份）
  const host = window as unknown as Record<string, unknown>
  host.kyclaw = kyclawApi
}
