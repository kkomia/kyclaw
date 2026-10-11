import { vi, type Mock } from 'vitest'
import type {
  ConnectionTestResult,
  KyclawAgentApi,
  KyclawApi,
  KyclawWindowApi,
  LangfuseState,
  UpdateState
} from '@shared/ipc'
import {
  defaultSettings,
  type AppSettings,
  type AppSettingsPatch,
  type WorkspaceMode
} from '@shared/settings'
import type { PluginsOverview } from '@shared/plugins'
import type { ProviderConfig, ProviderKeyState } from '@shared/providers'

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
  providerKeyStates: Mock<() => Promise<Record<string, ProviderKeyState>>>
  testProvider: Mock<(id: string) => Promise<ConnectionTestResult>>
  /** round 22：模型元数据探测（默认回当前设置；用例喂 probedModels） */
  probeModels: Mock<(id: string) => Promise<AppSettings>>
  removeProvider: Mock<(id: string) => Promise<AppSettings>>
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
  const keyed = new Set<string>()

  return {
    get: vi.fn(async () => state.current),
    update: vi.fn(async (patch: AppSettingsPatch) => {
      state.current = { ...state.current, ...patch }
      return state.current
    }),
    setProviderKey: vi.fn(async (id: string) => {
      keyed.add(id)
      return { hasKey: true as const }
    }),
    providerKeyStates: vi.fn(async () => {
      const states: Record<string, ProviderKeyState> = {}
      for (const provider of state.current.providers) {
        states[provider.id] = { hasKey: keyed.has(provider.id), needsReentry: false }
      }
      return states
    }),
    testProvider: vi.fn(async () => ({ ok: true as const, latencyMs: 128 })),
    // round 22：模型元数据探测（默认空操作回当前设置；用例用 mockResolvedValue 喂 probedModels）
    probeModels: vi.fn(async () => state.current),
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
  initial: UpdateState = { currentVersion: '1.0.0', configured: false, status: { phase: 'idle' } }
): UpdatesApiStub {
  const listeners = new Set<(state: UpdateState) => void>()
  let current = initial
  return {
    state: vi.fn(async () => current),
    check: vi.fn(async () => current),
    install: vi.fn(async () => {}),
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
}

export function pluginsApiStub(
  initial: PluginsOverview = { marketplaces: [], installed: [], installedSkills: [] }
): PluginsApiStub {
  return {
    overview: vi.fn(async () => initial),
    addMarketplace: vi.fn(async () => initial),
    refreshMarketplace: vi.fn(async () => initial),
    removeMarketplace: vi.fn(async () => initial),
    install: vi.fn(async () => initial),
    uninstall: vi.fn(async () => initial),
    icon: vi.fn(async () => ({ dataUrl: null }))
  }
}

/** installKyclawBridge 的返回值：settings 面的方法（原样）+ 其余各面的桩 */
export interface KyclawBridgeStubs extends SettingsApiStub {
  workspace: WorkspaceApiStub
  projects: ProjectsApiStub
  updates: UpdatesApiStub
  telemetry: TelemetryApiStub
  plugins: PluginsApiStub
}

/** 装桥并返回各面的 spy（settings / workspace / projects / telemetry 共享同一份设置副本） */
export function installKyclawBridge(initial: AppSettings = defaultSettings()): KyclawBridgeStubs {
  const state: BridgeState = { current: initial }
  const settings = settingsApi(state)
  const workspace = workspaceApi(state)
  const projects = projectsApi(state)
  const updates = updatesApiStub()
  const telemetry = telemetryApiStub(() => state.current.langfuse.endpoint)
  const plugins = pluginsApiStub()
  const api: KyclawApi = {
    window: windowApiStub(),
    settings,
    workspace,
    projects,
    agent: agentApiStub(),
    updates,
    telemetry,
    plugins
  }

  Object.defineProperty(window, 'kyclaw', { value: api, configurable: true })
  return { ...settings, workspace, projects, updates, telemetry, plugins }
}

export function clearKyclawBridge(): void {
  Reflect.deleteProperty(window, 'kyclaw')
}
