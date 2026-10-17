import { vi, type Mock } from 'vitest'
import {
  CONNECTION_TEST_SCOPE_NOTE,
  type BundledReleaseNotes,
  type ConnectionTestResult,
  type KyclawAgentApi,
  type KyclawApi,
  type KyclawSettingsApi,
  type KyclawWindowApi,
  type LangfuseState,
  type ProviderKeyRevealResult,
  type ProviderModelDiscoveryResult,
  type ProviderModelOption,
  type SearchKeyStates,
  type UpdateState
} from '@shared/ipc'
import {
  defaultSettings,
  type AppSettings,
  type AppSettingsPatch,
  type WorkspaceMode
} from '@shared/settings'
import type { PluginSkillImport, PluginsOverview } from '@shared/plugins'
import { emptyOverview, type LocalModelsOverview } from '@shared/local-models'
import type { TranslateResult } from '@shared/translate'
import type { SearchKeyTarget } from '@shared/search'
import type { PdfExtractResult } from '@shared/attachments'
import type { ProviderConfig, ProviderKeyState } from '@shared/providers'
import type {
  FileBytesResult,
  FilePreview,
  GitCommit,
  GitCommitDetail,
  GitOverview,
  ListDirResult,
  TableBytesResult,
  TerminalExit,
  TerminalSession,
  WorkbenchSearchMode,
  WorkbenchSearchResult
} from '@shared/workbench'
import type { OfficePreviewPriority, OfficePreviewResult } from '@shared/office-preview'
import {
  OFFICE_EDITOR_MAX_BYTES,
  OFFICE_MAX_OPEN_DOCUMENTS,
  OFFICE_SURFACE_ORIGIN,
  OFFICE_SURFACE_URL,
  type OfficeConfig,
  type OfficeDocumentInfo,
  type OfficeOpenResult,
  type OfficeReadResult
} from '@shared/office-editor'
import type { TextPageCursor, TextPageResult, TextVersionResult } from '@shared/workbench-text'

/**
 * jsdom 里没有真的 preload，`window.kyclaw` 默认不存在。
 * 这些桩给单测用的是一份最小可用的桥：settings 面可断言（含"有状态"的密钥/删除语义），
 * window 面是空动作。
 *
 * workspace 面与 settings 面共享同一份设置副本（装桥时由 installKyclawBridge 统一持有）：
 * 主进程的 workspace:add/remove/pick 回吐的就是落盘后的完整设置，渲染端看到的应该也是这份。
 */
export interface SettingsApiStub {
  get: Mock<() => Promise<AppSettings>>
  update: Mock<(patch: AppSettingsPatch) => Promise<AppSettings>>
  setProviderKey: Mock<(id: string, key: string) => Promise<{ hasKey: true }>>
  /** 用户显式点眼睛：默认按本桥记住的 key 回真实值；用例可覆盖成功/失败 */
  revealProviderKey: Mock<(id: string) => Promise<ProviderKeyRevealResult>>
  providerKeyStates: Mock<() => Promise<Record<string, ProviderKeyState>>>
  testProvider: Mock<(id: string) => Promise<ConnectionTestResult>>
  /** round 22：模型元数据探测（默认回当前设置；用例喂 probedModels） */
  probeModels: Mock<(id: string) => Promise<AppSettings>>
  /** 用户反馈 007：列端点上的可选模型（只读；默认空表，用例喂清单） */
  listProviderModels: Mock<(id: string) => Promise<ProviderModelOption[]>>
  /** 用户反馈 007：拿刚填的地址与密钥发现模型（默认"读不到"，用例喂清单/失败原因） */
  discoverProviderModels: Mock<KyclawSettingsApi['discoverProviderModels']>
  /** 主进程解析后的明暗（默认按设置里的显式档；system 回 light） */
  effectiveTheme: Mock<() => Promise<'light' | 'dark'>>
  onThemeChanged: Mock<(listener: (theme: 'light' | 'dark') => void) => () => void>
  removeProvider: Mock<(id: string) => Promise<AppSettings>>
}

/** 造一份「测试连接」结果（005 的新形状）；用例按需改某一步或整体 ok */
export interface ConnectionTestPatch {
  ok?: boolean
  latencyMs?: number
  message?: string
  steps?: ConnectionTestResult['steps']
}

/**
 * 「测试连接」三步全绿的结果。暴露成工厂是为了让"没验出来 / 某一步失败"这些用例
 * 只写它关心的那一步。
 */
export function passingConnectionTest(patch: ConnectionTestPatch = {}): ConnectionTestResult {
  return {
    ok: patch.ok ?? true,
    latencyMs: patch.latencyMs ?? 128,
    steps: patch.steps ?? [
      { id: 'connectivity', status: 'passed', latencyMs: 40, detail: '端点返回了一条可解析的响应' },
      { id: 'streaming', status: 'passed', latencyMs: 60, detail: '流式拿到 4 个字符的正文' },
      { id: 'tools', status: 'passed', latencyMs: 28, detail: '模型也真调了 kyclaw_probe' }
    ],
    ...(patch.message === undefined ? {} : { message: patch.message }),
    scopeNote: CONNECTION_TEST_SCOPE_NOTE
  }
}

export interface WorkspaceApiStub {
  pick: Mock<() => Promise<AppSettings>>
  add: Mock<(path: string) => Promise<AppSettings>>
  setMode: Mock<(path: string, mode: WorkspaceMode) => Promise<AppSettings>>
  remove: Mock<(path: string) => Promise<AppSettings>>
  pickDefault: Mock<() => Promise<AppSettings>>
  /** round 15：@ 文件列表（默认空表；用例用 mockResolvedValue 喂文件） */
  listFiles: Mock<(threadId: string) => Promise<{ files: string[] }>>
  /** round 20：在文件资源管理器里打开会话根（默认回固定路径） */
  openInExplorer: Mock<(threadId: string) => Promise<{ path: string }>>
}

export interface ProjectsApiStub {
  rulesStatus: Mock<() => Promise<import('@shared/rules-ipc').RulesStatus>>
  readRules: Mock<(projectId: string) => Promise<import('@shared/rules-ipc').ProjectRulesView>>
  saveRules: Mock<
    (
      projectId: string,
      text: string
    ) => Promise<import('@shared/rules-ipc').ProjectRulesSaveResponse>
  >
  base: Mock<() => Promise<{ base: string }>>
  pickFolder: Mock<() => Promise<{ path: string | null }>>
  create: Mock<(name: string, path: string) => Promise<AppSettings>>
  remove: Mock<(id: string) => Promise<AppSettings>>
  /** round 25：重命名（只改显示名） */
  rename: Mock<(id: string, name: string) => Promise<AppSettings>>
  /** round 25：在文件资源管理器里打开项目目录（默认回固定路径） */
  openInExplorer: Mock<(id: string) => Promise<{ path: string }>>
}

/** 更新面（T17）：`push` 是测试用的"模拟主进程推送"，其余都是真实 API 的形状 */
export interface UpdatesApiStub {
  state: Mock<() => Promise<UpdateState>>
  check: Mock<() => Promise<UpdateState>>
  install: Mock<() => Promise<void>>
  onStateChanged: Mock<(listener: (state: UpdateState) => void) => () => void>
  /** 本版本随包发行说明（本轮）：默认"这一版没随说明"，用例按需喂 ok / unreadable */
  releaseNotes: Mock<() => Promise<BundledReleaseNotes>>
  push: (state: UpdateState) => void
}

/**
 * 可观测面（T17）：密钥"有状态"（写/清之后状态跟着变），地址直接读共享设置副本
 * —— 与主进程口径一致（地址在 settings.json，密钥在另一处）。
 * `active` 是本次运行有没有真挂上导出，测试直接改这个值。
 */
export interface TelemetryApiStub {
  langfuseState: Mock<() => Promise<LangfuseState>>
  setLangfuseKeys: Mock<(publicKey: string, secretKey: string) => Promise<{ hasKeys: true }>>
  clearLangfuseKeys: Mock<() => Promise<LangfuseState>>
  active: boolean
}

/** 桥里面的共享状态：settings 面与 workspace / projects 面读写同一份设置 */
interface BridgeState {
  current: AppSettings
}

/** 原生选择器在测试里"选中"的那条路径（固定值，断言直接引用它） */
export const PICKED_WORKSPACE = 'D:\\picked\\示例工作区'

/** 项目面里"挑中"的文件夹（测试替换 pickFolder 的返回值时用得到） */
export const PICKED_FOLDER = 'D:\\picked\\现有文件夹'

/** 空白项目的默认基底（projects.base 的桩） */
export const PROJECT_BASE = 'D:\\picked\\Workspaces'

function settingsApi(state: BridgeState): SettingsApiStub {
  /** 测试桥的"密钥账本"：只记内存里的明文，用来模拟主进程的显式回显 */
  const keyed = new Map<string, string>()

  return {
    get: vi.fn(async () => state.current),
    update: vi.fn(async (patch: AppSettingsPatch) => {
      state.current = { ...state.current, ...patch }
      return state.current
    }),
    setProviderKey: vi.fn(async (id: string, key: string) => {
      keyed.set(id, key)
      return { hasKey: true as const }
    }),
    revealProviderKey: vi.fn(async (id: string): Promise<ProviderKeyRevealResult> => {
      const key = keyed.get(id)
      if (key === undefined) {
        return { ok: false, reason: 'not-configured', message: '还没有保存 API Key' }
      }
      return { ok: true, key }
    }),
    providerKeyStates: vi.fn(async () => {
      const states: Record<string, ProviderKeyState> = {}
      for (const provider of state.current.providers) {
        states[provider.id] = { hasKey: keyed.has(provider.id), needsReentry: false }
      }
      return states
    }),
    testProvider: vi.fn(async () => passingConnectionTest()),
    // round 22：模型元数据探测（默认空操作回当前设置；用例用 mockResolvedValue 喂 probedModels）
    probeModels: vi.fn(async () => state.current),
    // 用户反馈 007：列端点上的模型（默认空表 = 读不到；用例用 mockResolvedValue 喂清单）
    listProviderModels: vi.fn(async () => [] as ProviderModelOption[]),
    // 用户反馈 007：拿刚填的地址/密钥发现模型（默认"读不到"——不假装成功）
    discoverProviderModels: vi.fn(async (): Promise<ProviderModelDiscoveryResult> => ({
      ok: false,
      message: '读不到这条端点的模型清单'
    })),
    effectiveTheme: vi.fn(async () => (state.current.theme === 'dark' ? 'dark' : 'light')),
    onThemeChanged: vi.fn(() => () => {}),
    removeProvider: vi.fn(async (id: string) => {
      state.current = {
        ...state.current,
        providers: state.current.providers.filter((provider: ProviderConfig) => provider.id !== id)
      }
      keyed.delete(id)
      return state.current
    })
  }
}

function workspaceApi(state: BridgeState): WorkspaceApiStub {
  /** 与 main/workspace.ts 同口径的最简实现：按路径去重（Windows 大小写不敏感就够测试用） */
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

  return {
    pick: vi.fn(async () => {
      state.current = {
        ...state.current,
        workspaces: [...state.current.workspaces, { path: PICKED_WORKSPACE, mode: 'ask' }]
      }
      return state.current
    }),
    // 与主进程同口径：add 一律 ask；已在列表里保持原模式
    add: vi.fn(async (path: string) => {
      const exists = state.current.workspaces.some((workspace) => same(workspace.path, path))
      state.current = {
        ...state.current,
        workspaces: exists
          ? state.current.workspaces.map((workspace) =>
              same(workspace.path, path) ? { path, mode: workspace.mode } : workspace
            )
          : [...state.current.workspaces, { path, mode: 'ask' as const }]
      }
      return state.current
    }),
    // 与主进程同口径：只认已授权路径，不在列表里就拒绝
    setMode: vi.fn(async (path: string, mode: WorkspaceMode) => {
      const exists = state.current.workspaces.some((workspace) => same(workspace.path, path))
      if (!exists) throw new Error('这个文件夹不在授权列表里：请先添加它，再切换访问模式')
      state.current = {
        ...state.current,
        workspaces: state.current.workspaces.map((workspace) =>
          same(workspace.path, path) ? { path, mode } : workspace
        )
      }
      return state.current
    }),
    remove: vi.fn(async (path: string) => {
      state.current = {
        ...state.current,
        workspaces: state.current.workspaces.filter((workspace) => !same(workspace.path, path))
      }
      return state.current
    }),
    // 与主进程同口径：选中目录以 ask 并进授权列表，再记成默认工作区
    pickDefault: vi.fn(async () => {
      const exists = state.current.workspaces.some((workspace) =>
        same(workspace.path, PICKED_WORKSPACE)
      )
      state.current = {
        ...state.current,
        workspaces: exists
          ? state.current.workspaces
          : [...state.current.workspaces, { path: PICKED_WORKSPACE, mode: 'ask' as const }],
        defaultWorkspace: PICKED_WORKSPACE
      }
      return state.current
    }),
    // @ 文件列表：默认空表（用例自己 mockResolvedValue 喂文件；不模拟主进程的会话根解析）
    listFiles: vi.fn(async () => ({ files: [] })),
    // round 20：在文件资源管理器里打开（默认回一个固定路径；用例自己 mockRejectedValue 造失败）
    openInExplorer: vi.fn(async () => ({ path: PICKED_WORKSPACE }))
  }
}

function projectsApi(state: BridgeState): ProjectsApiStub {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

  return {
    base: vi.fn(async () => ({ base: PROJECT_BASE })),
    pickFolder: vi.fn(async () => ({ path: PICKED_FOLDER })),
    // 与主进程同口径：路径缺失就"建"（测试里只记名字）、去重、以 ask 进授权列表
    create: vi.fn(async (name: string, path: string) => {
      const existing = state.current.projects.find((project) => same(project.path, path))
      if (existing) throw new Error(`这个文件夹已经是一个项目：${existing.name}`)
      const project = {
        id: `project-${state.current.projects.length + 1}`,
        name: name.trim(),
        path,
        createdAt: '2026-10-11T00:00:00.000Z'
      }
      const inList = state.current.workspaces.some((workspace) => same(workspace.path, path))
      state.current = {
        ...state.current,
        projects: [...state.current.projects, project],
        workspaces: inList
          ? state.current.workspaces
          : [...state.current.workspaces, { path, mode: 'ask' as const }]
      }
      return state.current
    }),
    remove: vi.fn(async (id: string) => {
      state.current = {
        ...state.current,
        projects: state.current.projects.filter((project) => project.id !== id)
      }
      return state.current
    }),
    // round 25：重命名（与主进程同口径：只改显示名、trim）
    rename: vi.fn(async (id: string, name: string) => {
      state.current = {
        ...state.current,
        projects: state.current.projects.map((project) =>
          project.id === id ? { ...project, name: name.trim() } : project
        )
      }
      return state.current
    }),
    rulesStatus: vi.fn(async () => ({ processorRegistered: false })),
    readRules: vi.fn(async (projectId: string) => ({
      projectId,
      source: '.kyclaw/rules.md',
      text: '',
      diagnostics: [],
      processorRegistered: false,
      projectIncluded: true
    })),
    saveRules: vi.fn(async (projectId: string, text: string) => ({
      ok: true as const,
      view: {
        projectId,
        source: '.kyclaw/rules.md',
        text,
        diagnostics: [],
        processorRegistered: false,
        projectIncluded: true
      }
    })),
    // round 25：在文件资源管理器里打开（默认回一个固定路径；用例自己 mockRejectedValue 造失败）
    openInExplorer: vi.fn(async () => ({ path: PICKED_WORKSPACE }))
  }
}

export function settingsApiStub(initial: AppSettings = defaultSettings()): SettingsApiStub {
  return settingsApi({ current: initial })
}

export function workspaceApiStub(initial: AppSettings = defaultSettings()): WorkspaceApiStub {
  return workspaceApi({ current: initial })
}

export function projectsApiStub(initial: AppSettings = defaultSettings()): ProjectsApiStub {
  return projectsApi({ current: initial })
}

/** window 面：默认全是空动作（T4 的窗控测试自己替换单个方法） */
export function windowApiStub(): KyclawWindowApi {
  return {
    minimize: () => {},
    maximize: () => {},
    close: () => {},
    isMaximized: async () => false,
    onStateChanged: () => () => {}
  }
}

/** agent 面：默认回一个"不会真去连"的端点（T7 的聊天测试自己替换） */
export function agentApiStub(): KyclawAgentApi {
  return {
    endpoint: async () => ({ baseUrl: 'http://127.0.0.1:1', token: 'stub-token' })
  }
}

/** 更新面：未配源的默认状态（挂载时拉一次、之后测试想推就 push） */
export function updatesApiStub(
  initial: UpdateState = {
    currentVersion: '1.0.0',
    configured: false,
    builtinUrl: null,
    status: { phase: 'idle' }
  },
  notes: BundledReleaseNotes = { state: 'missing' }
): UpdatesApiStub {
  const listeners = new Set<(state: UpdateState) => void>()
  let current = initial
  return {
    state: vi.fn(async () => current),
    check: vi.fn(async () => current),
    install: vi.fn(async () => {}),
    releaseNotes: vi.fn(async () => notes),
    onStateChanged: vi.fn((listener: (state: UpdateState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    push: (state: UpdateState) => {
      current = state
      for (const listener of listeners) listener(state)
    }
  }
}

/** 可观测面：地址由 `endpointOf` 现读（装桥时给共享设置副本），密钥"有状态" */
export function telemetryApiStub(endpointOf: () => string = () => ''): TelemetryApiStub {
  const keys = { publicKey: false, secretKey: false }
  const stub: TelemetryApiStub = {
    active: false,
    langfuseState: vi.fn(async () => ({
      endpoint: endpointOf(),
      publicKey: { hasKey: keys.publicKey, needsReentry: false },
      secretKey: { hasKey: keys.secretKey, needsReentry: false },
      active: stub.active
    })),
    setLangfuseKeys: vi.fn(async () => {
      keys.publicKey = true
      keys.secretKey = true
      return { hasKeys: true as const }
    }),
    clearLangfuseKeys: vi.fn(async () => {
      keys.publicKey = false
      keys.secretKey = false
      return stub.langfuseState()
    })
  }
  return stub
}

/**
 * 工作台面（右侧边栏的文件 / Git 两项）：默认给"不是仓库 + 空目录"的安全桩，
 * 用例自己用 `mockResolvedValue` 喂每个动作的返回值。
 */
export interface WorkbenchApiStub {
  listDir: Mock<(threadId: string, relative: string) => Promise<ListDirResult>>
  readFile: Mock<(threadId: string, relative: string) => Promise<FilePreview>>
  /**
   * 文本分页（`workbench:read-text-page`）：**默认实现把 `readFile` 的桩转成一页** ——
   * 老用例那些 `readFile.mockResolvedValue({ kind: 'text', … })` 的夹具因此不用重写
   * （分页真行为由 `dsh-media/__tests__/paged-text.spec.tsx` 直接喂取数口覆盖）。
   * 要测分页本身（游标 / 续读 / changed）就自己 `mockResolvedValueOnce` 覆盖这一条。
   */
  readTextPage: Mock<
    (threadId: string, relative: string, cursor: TextPageCursor | null) => Promise<TextPageResult>
  >
  /** 文本版本探询（轮询用）：默认稳定不变（版本 'test:0'），老用例不会被"文件已更新"打扰 */
  textVersion: Mock<(threadId: string, relative: string) => Promise<TextVersionResult>>
  /** round 40：字节通道（图片 / PDF 的按格式预览）；默认回"不支持" */
  readBytes: Mock<(threadId: string, relative: string) => Promise<FileBytesResult>>
  /** 表格原始字节通道（xls / xlsx / csv / tsv）；默认回"认不出" */
  tableBytes: Mock<(threadId: string, relative: string) => Promise<TableBytesResult>>
  /** 办公档页式预览（主进程转 PDF）；默认回"这台机器没有引擎"，用例自己喂成功回包 */
  officePdf: Mock<
    (
      threadId: string,
      relative: string,
      priority: OfficePreviewPriority,
      requestId: string
    ) => Promise<OfficePreviewResult>
  >
  /** 取消一次办公档转换（幂等、无回包） */
  cancelOfficePdf: Mock<(requestId: string) => Promise<void>>
  /** round 44：搜索（默认空结果；用例自己 mockResolvedValue 喂命中） */
  search: Mock<
    (threadId: string, query: string, mode: WorkbenchSearchMode) => Promise<WorkbenchSearchResult>
  >
  reveal: Mock<(threadId: string, relative: string) => Promise<{ path: string }>>
  /** 用系统默认应用打开文件（默认回固定路径；用例自己 mockRejectedValue 造失败） */
  open: Mock<(threadId: string, relative: string) => Promise<{ path: string }>>
  gitOverview: Mock<(threadId: string) => Promise<GitOverview>>
  gitLog: Mock<(threadId: string, limit: number) => Promise<{ commits: GitCommit[] }>>
  gitShow: Mock<(threadId: string, sha: string) => Promise<GitCommitDetail>>
}

export function workbenchApiStub(): WorkbenchApiStub {
  const stub: WorkbenchApiStub = {
    listDir: vi.fn(async () => ({ entries: [], truncated: false })),
    readFile: vi.fn(async () => ({ kind: 'text' as const, text: '', size: 0, truncated: false })),
    readTextPage: vi.fn(async () => ({ kind: 'missing' as const })),
    textVersion: vi.fn(async () => ({ kind: 'version' as const, version: 'test:0', size: 0 })),
    readBytes: vi.fn(async () => ({ kind: 'unsupported' as const, size: 0 })),
    tableBytes: vi.fn(async () => ({ kind: 'unsupported' as const, size: 0 })),
    officePdf: vi.fn(async (_threadId: string, relative: string): Promise<OfficePreviewResult> => ({
      kind: 'failed',
      path: relative,
      code: 'unavailable',
      message: '测试桩：没有可用的转换引擎'
    })),
    cancelOfficePdf: vi.fn(async () => undefined),
    search: vi.fn(async () => ({ results: [], truncated: false, scanned: 0 })),
    reveal: vi.fn(async () => ({ path: '' })),
    open: vi.fn(async () => ({ path: '' })),
    gitOverview: vi.fn(async () => ({ isRepo: false, empty: false, branch: null, changes: [] })),
    gitLog: vi.fn(async () => ({ commits: [] })),
    gitShow: vi.fn(async (_threadId: string, sha: string) => ({
      sha,
      short: sha.slice(0, 7),
      author: '',
      email: '',
      date: '',
      message: '',
      files: []
    }))
  }

  /**
   * 文本分页的默认实现：**把 `readFile` 的桩转成一页**（老用例的文本夹具因此照旧管用）。
   * `truncated: true` 的桩对应 `eof: false`（界面出现"加载更多"），其它原样带过来；
   * 二进制 / 过大照旧直通（分页通道与旧文本通道在这两种结果上同形）。
   */
  stub.readTextPage.mockImplementation(async (threadId, relative) => {
    const preview = await stub.readFile(threadId, relative)
    if (preview.kind === 'binary') return { kind: 'binary', size: preview.size }
    if (preview.kind === 'too-large') {
      return { kind: 'too-large', size: preview.size, limit: preview.size }
    }
    return {
      kind: 'page',
      text: preview.text,
      offset: 0,
      nextOffset: preview.truncated ? preview.text.length : preview.size,
      size: preview.size,
      version: 'test:0',
      eof: !preview.truncated,
      overlongLine: false
    }
  })
  return stub
}

/** 终端面：默认起一个固定 id 的会话；`push` / `exit` 模拟主进程的两条推送 */
export interface TerminalApiStub {
  start: Mock<(threadId: string, cols: number, rows: number) => Promise<TerminalSession>>
  write: Mock<(id: string, data: string) => Promise<void>>
  resize: Mock<(id: string, cols: number, rows: number) => Promise<void>>
  dispose: Mock<(id: string) => Promise<void>>
  onData: Mock<(listener: (payload: { id: string; data: string }) => void) => () => void>
  onExit: Mock<(listener: (payload: TerminalExit) => void) => () => void>
  /** 模拟主进程推一段输出 */
  push: (id: string, data: string) => void
  /** 模拟终端进程结束 */
  exit: (id: string, exitCode: number | null) => void
}

export function terminalApiStub(
  session: TerminalSession = { id: 'term-1', shell: 'D:\\Git\\bin\\bash.exe', cwd: 'D:\\工作区' }
): TerminalApiStub {
  const dataListeners = new Set<(payload: { id: string; data: string }) => void>()
  const exitListeners = new Set<(payload: TerminalExit) => void>()
  return {
    start: vi.fn(async () => session),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    onData: vi.fn((listener: (payload: { id: string; data: string }) => void) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    }),
    onExit: vi.fn((listener: (payload: TerminalExit) => void) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    }),
    push: (id, data) => {
      for (const listener of dataListeners) listener({ id, data })
    },
    exit: (id, exitCode) => {
      for (const listener of exitListeners) listener({ id, exitCode })
    }
  }
}

/** 插件面：默认回一个空总览（用例自己替换单个方法/改 mock 值） */
export interface PluginsApiStub {
  overview: Mock<() => Promise<PluginsOverview>>
  addMarketplace: Mock<
    (input: { source: string; ref?: string; sparsePaths?: string[] }) => Promise<PluginsOverview>
  >
  refreshMarketplace: Mock<(id: string) => Promise<PluginsOverview>>
  removeMarketplace: Mock<(id: string) => Promise<PluginsOverview>>
  install: Mock<(marketplaceId: string, name: string) => Promise<PluginsOverview>>
  uninstall: Mock<(id: string) => Promise<PluginsOverview>>
  /** round 23：插件图标（data URL；默认 null = 字母头像） */
  icon: Mock<(marketplaceId: string, name: string) => Promise<{ dataUrl: string | null }>>
  /** round 94：技能的三个导入入口（默认"导入成功且什么都没新增"——用例按需喂 returned） */
  addSkillFromUrl: Mock<(url: string) => Promise<PluginSkillImport>>
  importSkillFromFile: Mock<() => Promise<PluginSkillImport>>
  importSkillFromFolder: Mock<() => Promise<PluginSkillImport>>
}

export function pluginsApiStub(
  initial: PluginsOverview = { marketplaces: [], installed: [], installedSkills: [] },
  /** round 94：导入成功时回的总览与技能（用例喂"导入了 xx"的那一份） */
  imported?: { overview: PluginsOverview; added: { name: string; dir: string } | null }
): PluginsApiStub {
  const outcome: PluginSkillImport = {
    blocked: null,
    ...(imported ?? { overview: initial, added: null })
  }
  return {
    overview: vi.fn(async () => initial),
    addMarketplace: vi.fn(async () => initial),
    refreshMarketplace: vi.fn(async () => initial),
    removeMarketplace: vi.fn(async () => initial),
    install: vi.fn(async () => initial),
    uninstall: vi.fn(async () => initial),
    icon: vi.fn(async () => ({ dataUrl: null })),
    addSkillFromUrl: vi.fn(async () => outcome),
    importSkillFromFile: vi.fn(async () => outcome),
    importSkillFromFolder: vi.fn(async () => outcome)
  }
}

/**
 * Office 文档面（M3-S2）：默认"取消打开 + 读不到"——**不假装打开成功**，
 * 没关心过 Office 的用例不会被一条假文档带偏。用例自己 `mockResolvedValue` 喂
 * `officeDocumentFixture()` 与字节。
 */
export interface OfficeApiStub {
  config: Mock<() => Promise<OfficeConfig>>
  openDialog: Mock<() => Promise<OfficeOpenResult>>
  openFromSession: Mock<
    (threadId: string, relative: string, readOnly?: boolean) => Promise<OfficeOpenResult>
  >
  read: Mock<(documentId: string) => Promise<OfficeReadResult>>
  release: Mock<(documentId: string) => Promise<void>>
}

/** 造一份 `OfficeDocumentInfo`（用例只改关心的字段） */
export function officeDocumentFixture(patch: Partial<OfficeDocumentInfo> = {}): OfficeDocumentInfo {
  return {
    documentId: 'doc-1',
    displayName: '方案.docx',
    displayPath: 'D:\\工作\\方案.docx',
    absolutePath: 'D:\\工作\\方案.docx',
    size: 12,
    mtimeMs: 1_700_000_000_000,
    sha256: 'a'.repeat(64),
    readOnly: false,
    ...patch
  }
}

export function officeApiStub(): OfficeApiStub {
  return {
    config: vi.fn(async (): Promise<OfficeConfig> => ({
      surfaceUrl: OFFICE_SURFACE_URL,
      surfaceOrigin: OFFICE_SURFACE_ORIGIN,
      maxBytes: OFFICE_EDITOR_MAX_BYTES,
      maxOpenDocuments: OFFICE_MAX_OPEN_DOCUMENTS
    })),
    openDialog: vi.fn(async (): Promise<OfficeOpenResult> => ({
      ok: false,
      code: 'cancelled',
      message: '已取消'
    })),
    openFromSession: vi.fn(async (): Promise<OfficeOpenResult> => ({
      ok: false,
      code: 'cancelled',
      message: '已取消'
    })),
    read: vi.fn(async (): Promise<OfficeReadResult> => ({
      ok: false,
      code: 'forbidden',
      message: '这个文档没有打开或已关闭'
    })),
    release: vi.fn(async () => undefined)
  }
}

/** 记忆面（round 28）：只有远程嵌入密钥的状态（默认没配过） */
export interface MemoryApiStub {
  embeddingKeyState: Mock<() => Promise<ProviderKeyState>>
  setEmbeddingKey: Mock<(key: string) => Promise<{ hasKey: true }>>
  clearEmbeddingKey: Mock<() => Promise<ProviderKeyState>>
}

export function memoryApiStub(): MemoryApiStub {
  let hasKey = false
  const stub: MemoryApiStub = {
    embeddingKeyState: vi.fn(async () => ({ hasKey, needsReentry: false })),
    setEmbeddingKey: vi.fn(async () => {
      hasKey = true
      return { hasKey: true as const }
    }),
    clearEmbeddingKey: vi.fn(async () => {
      hasKey = false
      return { hasKey: false, needsReentry: false }
    })
  }
  return stub
}

/**
 * 思考翻译面（round 32）：默认回"服务没开"（`{ok:false}`）——**不假装翻成功**，
 * 于是没关心过翻译的用例不会因为思考块多出一段假译文。用例自己
 * `mockResolvedValue({ok:true, text:'…'})` 喂译文、`mockRejectedValue` 造通道失败。
 */
export interface TranslateApiStub {
  run: Mock<(input: { text: string; targetLanguage?: string }) => Promise<TranslateResult>>
  keyState: Mock<() => Promise<ProviderKeyState>>
  setKey: Mock<(key: string) => Promise<{ hasKey: true }>>
  clearKey: Mock<() => Promise<ProviderKeyState>>
}

export function translateApiStub(): TranslateApiStub {
  let hasKey = false
  return {
    run: vi.fn(async () => ({ ok: false as const, message: '翻译服务没有开' })),
    keyState: vi.fn(async () => ({ hasKey, needsReentry: false })),
    setKey: vi.fn(async () => {
      hasKey = true
      return { hasKey: true as const }
    }),
    clearKey: vi.fn(async () => {
      hasKey = false
      return { hasKey: false, needsReentry: false }
    })
  }
}

/**
 * 附件面（模块 2）：默认回"抽不出文字"（`{ok:false}`）——**不假装抽成功**，
 * 于是没关心过 PDF 的用例不会被一条假附件带偏。用例自己 `mockResolvedValue({ok:true,...})` 喂结果。
 */
export interface AttachmentsApiStub {
  extractPdf: Mock<(bytes: Uint8Array) => Promise<PdfExtractResult>>
}
export function attachmentsApiStub(): AttachmentsApiStub {
  return {
    extractPdf: vi.fn(async () => ({ ok: false as const, message: '这个 PDF 没有文字层' }))
  }
}

/**
 * 本地文件小桥（round 53）：File → 磁盘绝对路径。
 * 默认回 `''`（jsdom 里没有真的 Electron —— 与"桥给不出路径"同一档，正好让用例走无路径兜底）；
 * 需要路径引用的用例用 `mockImplementation` 注入"这个 File → 路径"的映射
 * （按 `file.name` 或 `File` 身份都行）。
 */
export interface FilesApiStub {
  pathForFile: Mock<(file: File) => string>
}

export function filesApiStub(): FilesApiStub {
  return { pathForFile: vi.fn(() => '') }
}

/**
 * 联网搜索面（round 45）：三档 Key 的写/清/状态，桩里"有状态"（写/清之后状态跟着变）
 * —— 与主进程口径一致（明文只在写方向出现一次，读方向只有"有没有"）。
 */
export interface SearchApiStub {
  keyStates: Mock<() => Promise<SearchKeyStates>>
  setKey: Mock<(target: SearchKeyTarget, key: string) => Promise<{ hasKey: true }>>
  clearKey: Mock<(target: SearchKeyTarget) => Promise<SearchKeyStates>>
}

export function searchApiStub(): SearchApiStub {
  const keys: Record<SearchKeyTarget, boolean> = { exa: false, tavily: false, jina: false }
  const states = (): SearchKeyStates => ({
    exa: { hasKey: keys.exa, needsReentry: false },
    tavily: { hasKey: keys.tavily, needsReentry: false },
    jina: { hasKey: keys.jina, needsReentry: false }
  })
  return {
    keyStates: vi.fn(async () => states()),
    setKey: vi.fn(async (target: SearchKeyTarget) => {
      keys[target] = true
      return { hasKey: true as const }
    }),
    clearKey: vi.fn(async (target: SearchKeyTarget) => {
      keys[target] = false
      return states()
    })
  }
}

/**
 * 「本地模型」面（模块 3B）：总览是"当前值 + 订阅"的形状（主进程会推下载进度），
 * 所以桩里也放一份 current，并给个 `push` 让用例模拟主进程的推送。
 */
export interface LocalModelsApiStub {
  overview: Mock<() => Promise<LocalModelsOverview>>
  download: Mock<(id: string) => Promise<LocalModelsOverview>>
  cancel: Mock<() => Promise<LocalModelsOverview>>
  select: Mock<(id: string) => Promise<LocalModelsOverview>>
  pickCustom: Mock<() => Promise<LocalModelsOverview>>
  remove: Mock<(id: string) => Promise<LocalModelsOverview>>
  onChanged: Mock<(listener: (overview: LocalModelsOverview) => void) => () => void>
  /** 模拟主进程推送一份新总览（下载进度、引擎相位） */
  push: (overview: LocalModelsOverview) => void
}

export function localModelsApiStub(
  initial: LocalModelsOverview = emptyOverview('D:\\models')
): LocalModelsApiStub {
  const listeners = new Set<(overview: LocalModelsOverview) => void>()
  let current = initial
  return {
    overview: vi.fn(async () => current),
    download: vi.fn(async () => current),
    cancel: vi.fn(async () => current),
    select: vi.fn(async () => current),
    pickCustom: vi.fn(async () => current),
    remove: vi.fn(async () => current),
    onChanged: vi.fn((listener: (overview: LocalModelsOverview) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    push: (overview: LocalModelsOverview) => {
      current = overview
      for (const listener of listeners) listener(overview)
    }
  }
}

/** installKyclawBridge 的返回值：settings 面的方法（原样）+ 其余各面的桩 */
export interface KyclawBridgeStubs extends SettingsApiStub {
  workspace: WorkspaceApiStub
  workbench: WorkbenchApiStub
  terminal: TerminalApiStub
  office: OfficeApiStub
  projects: ProjectsApiStub
  updates: UpdatesApiStub
  telemetry: TelemetryApiStub
  plugins: PluginsApiStub
  memory: MemoryApiStub
  localModels: LocalModelsApiStub
  translate: TranslateApiStub
  search: SearchApiStub
  attachments: AttachmentsApiStub
  files: FilesApiStub
}

/** 装桥并返回各面的 spy（settings / workspace / projects / telemetry 共享同一份设置副本） */
export function installKyclawBridge(initial: AppSettings = defaultSettings()): KyclawBridgeStubs {
  const state: BridgeState = { current: initial }
  const settings = settingsApi(state)
  const workspace = workspaceApi(state)
  const workbench = workbenchApiStub()
  const terminal = terminalApiStub()
  const office = officeApiStub()
  const projects = projectsApi(state)
  const updates = updatesApiStub()
  const telemetry = telemetryApiStub(() => state.current.langfuse.endpoint)
  const plugins = pluginsApiStub()
  const memory = memoryApiStub()
  const localModels = localModelsApiStub()
  const translate = translateApiStub()
  const search = searchApiStub()
  const attachments = attachmentsApiStub()
  const files = filesApiStub()
  const api: KyclawApi = {
    window: windowApiStub(),
    settings,
    workspace,
    workbench,
    terminal,
    office,
    projects,
    agent: agentApiStub(),
    attachments,
    files,
    updates,
    telemetry,
    plugins,
    memory,
    localModels,
    translate,
    search
  }

  Object.defineProperty(window, 'kyclaw', { value: api, configurable: true })
  return {
    ...settings,
    workspace,
    workbench,
    terminal,
    office,
    projects,
    updates,
    telemetry,
    plugins,
    memory,
    localModels,
    translate,
    search,
    attachments,
    files
  }
}

export function clearKyclawBridge(): void {
  Reflect.deleteProperty(window, 'kyclaw')
}
