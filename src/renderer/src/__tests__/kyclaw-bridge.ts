import { vi, type Mock } from 'vitest'
import type { ConnectionTestResult, KyclawAgentApi, KyclawApi, KyclawWindowApi } from '@shared/ipc'
import { defaultSettings, type AppSettings, type AppSettingsPatch } from '@shared/settings'
import type { ProviderConfig, ProviderKeyState } from '@shared/providers'

/**
 * jsdom 里没有真的 preload，`window.kyclaw` 默认不存在。
 * 这些桩给单测用的是一份最小可用的桥：settings 面可断言（含"有状态"的密钥/删除语义），
 * window 面是空动作。
 */
export interface SettingsApiStub {
  get: Mock<() => Promise<AppSettings>>
  update: Mock<(patch: AppSettingsPatch) => Promise<AppSettings>>
  setProviderKey: Mock<(id: string, key: string) => Promise<{ hasKey: true }>>
  providerKeyStates: Mock<() => Promise<Record<string, ProviderKeyState>>>
  testProvider: Mock<(id: string) => Promise<ConnectionTestResult>>
  removeProvider: Mock<(id: string) => Promise<AppSettings>>
}

export function settingsApiStub(initial: AppSettings = defaultSettings()): SettingsApiStub {
  let current = initial
  const keyed = new Set<string>()

  return {
    get: vi.fn(async () => current),
    update: vi.fn(async (patch: AppSettingsPatch) => {
      current = { ...current, ...patch }
      return current
    }),
    setProviderKey: vi.fn(async (id: string) => {
      keyed.add(id)
      return { hasKey: true as const }
    }),
    providerKeyStates: vi.fn(async () => {
      const states: Record<string, ProviderKeyState> = {}
      for (const provider of current.providers) {
        states[provider.id] = { hasKey: keyed.has(provider.id), needsReentry: false }
      }
      return states
    }),
    testProvider: vi.fn(async () => ({ ok: true as const, latencyMs: 128 })),
    removeProvider: vi.fn(async (id: string) => {
      current = {
        ...current,
        providers: current.providers.filter((provider: ProviderConfig) => provider.id !== id)
      }
      keyed.delete(id)
      return current
    })
  }
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

/** 装桥并返回 settings 面的两个 spy（本任务关心的就是它） */
export function installKyclawBridge(initial: AppSettings = defaultSettings()): SettingsApiStub {
  const settings = settingsApiStub(initial)
  const api: KyclawApi = { window: windowApiStub(), settings, agent: agentApiStub() }

  Object.defineProperty(window, 'kyclaw', { value: api, configurable: true })
  return settings
}

export function clearKyclawBridge(): void {
  Reflect.deleteProperty(window, 'kyclaw')
}
