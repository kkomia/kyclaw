import { vi, type Mock } from 'vitest'
import type { KyclawApi, KyclawWindowApi } from '@shared/ipc'
import { defaultSettings, type AppSettings, type AppSettingsPatch } from '@shared/settings'

/**
 * jsdom 里没有真的 preload，`window.kyclaw` 默认不存在。
 * 这些桩给单测用的是一份最小可用的桥：settings 面可断言、window 面是空动作。
 */
export interface SettingsApiStub {
  get: Mock<() => Promise<AppSettings>>
  update: Mock<(patch: AppSettingsPatch) => Promise<AppSettings>>
}

export function settingsApiStub(initial: AppSettings = defaultSettings()): SettingsApiStub {
  return {
    get: vi.fn(async () => initial),
    update: vi.fn(async (patch: AppSettingsPatch) => ({ ...initial, ...patch }))
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

/** 装桥并返回 settings 面的两个 spy（本任务关心的就是它） */
export function installKyclawBridge(initial: AppSettings = defaultSettings()): SettingsApiStub {
  const settings = settingsApiStub(initial)
  const api: KyclawApi = { window: windowApiStub(), settings }

  Object.defineProperty(window, 'kyclaw', { value: api, configurable: true })
  return settings
}

export function clearKyclawBridge(): void {
  Reflect.deleteProperty(window, 'kyclaw')
}
