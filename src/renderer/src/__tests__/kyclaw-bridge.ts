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
  add: Mock<(path: string, mode: WorkspaceMode) => Promise<AppSettings>>
  remove: Mock<(path: string) => Promise<AppSettings>>
}

/** 桥里面的共享状态：settings 面与 workspace 面读写同一份设置 */
interface BridgeState {
  current: AppSettings
}

/** 原生选择器在测试里"选中"的那条路径（固定值，断言直接引用它） */
export const PICKED_WORKSPACE = 'D:\\picked\\示例工作区'

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
    add: vi.fn(async (path: string, mode: WorkspaceMode) => {
      const exists = state.current.workspaces.some((workspace) => same(workspace.path, path))
      state.current = {
        ...state.current,
        workspaces: exists
          ? state.current.workspaces.map((workspace) =>
              same(workspace.path, path) ? { path, mode } : workspace
            )
          : [...state.current.workspaces, { path, mode }]
      }
      return state.current
    }),
    remove: vi.fn(async (path: string) => {
      state.current = {
        ...state.current,
        workspaces: state.current.workspaces.filter((workspace) => !same(workspace.path, path))
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

/** installKyclawBridge 的返回值：settings 面的方法（原样）+ workspace 面的方法 */
export interface KyclawBridgeStubs extends SettingsApiStub {
  workspace: WorkspaceApiStub
}

/** 装桥并返回各面的 spy（settings 与 workspace 共享同一份设置副本） */
export function installKyclawBridge(initial: AppSettings = defaultSettings()): KyclawBridgeStubs {
  const state: BridgeState = { current: initial }
  const settings = settingsApi(state)
  const workspace = workspaceApi(state)
  const api: KyclawApi = {
    window: windowApiStub(),
    settings,
    workspace,
    agent: agentApiStub()
  }

  Object.defineProperty(window, 'kyclaw', { value: api, configurable: true })
  return { ...settings, workspace }
}

export function clearKyclawBridge(): void {
  Reflect.deleteProperty(window, 'kyclaw')
}
