import { vi, type Mock } from 'vitest'
import type { ConnectionTestResult, KyclawAgentApi, KyclawApi, KyclawWindowApi } from '@shared/ipc'
import {
  defaultSettings,
  type AppSettings,
  type AppSettingsPatch,
  type WorkspaceMode
} from '@shared/settings'
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
  removeProvider: Mock<(id: string) => Promise<AppSettings>>
}

export interface WorkspaceApiStub {
  pick: Mock<() => Promise<AppSettings>>
  add: Mock<(path: string) => Promise<AppSettings>>
  setMode: Mock<(path: string, mode: WorkspaceMode) => Promise<AppSettings>>
  remove: Mock<(path: string) => Promise<AppSettings>>
  pickDefault: Mock<() => Promise<AppSettings>>
}

export interface ProjectsApiStub {
  base: Mock<() => Promise<{ base: string }>>
  pickFolder: Mock<() => Promise<{ path: string | null }>>
  create: Mock<(name: string, path: string) => Promise<AppSettings>>
  remove: Mock<(id: string) => Promise<AppSettings>>
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
    })
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
    })
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

/** installKyclawBridge 的返回值：settings 面的方法（原样）+ workspace / projects 面的方法 */
export interface KyclawBridgeStubs extends SettingsApiStub {
  workspace: WorkspaceApiStub
  projects: ProjectsApiStub
}

/** 装桥并返回各面的 spy（settings / workspace / projects 共享同一份设置副本） */
export function installKyclawBridge(initial: AppSettings = defaultSettings()): KyclawBridgeStubs {
  const state: BridgeState = { current: initial }
  const settings = settingsApi(state)
  const workspace = workspaceApi(state)
  const projects = projectsApi(state)
  const api: KyclawApi = {
    window: windowApiStub(),
    settings,
    workspace,
    projects,
    agent: agentApiStub()
  }

  Object.defineProperty(window, 'kyclaw', { value: api, configurable: true })
  return { ...settings, workspace, projects }
}

export function clearKyclawBridge(): void {
  Reflect.deleteProperty(window, 'kyclaw')
}
