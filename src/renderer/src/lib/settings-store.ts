import { create } from 'zustand'
import { defaultSettings, type AppSettings, type AppSettingsPatch } from '@shared/settings'
import { setFontTier, setTheme } from './theme'

/**
 * 设置的渲染端副本 + 外观副作用。落盘在主进程（settings:* 通道），这里只管两件事：
 *   1. 启动时把落盘的外观应用到 html（主题 / 字号），让壳第一帧就对；
 *   2. 用户改动：先应用（立刻见效）再落盘，落盘失败只记日志不回滚
 *      —— 写失败不该让 UI 跟用户的选择打架，也还没有放错误条的层（spec §7.3 的状态条后置）。
 * `window.kyclaw` 缺失（浏览器里看渲染端 / 单测）时全体走默认值，不抛。
 */
function applyAppearance(settings: AppSettings): void {
  setTheme(settings.theme)
  setFontTier(settings.fontTier)
}

export interface SettingsState {
  settings: AppSettings
  /** 首次读盘完成没有（读完前 UI 显示默认值） */
  loaded: boolean
  load: () => Promise<void>
  update: (patch: AppSettingsPatch) => Promise<void>
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: defaultSettings(),
  loaded: false,

  load: async () => {
    let settings = defaultSettings()
    try {
      settings = (await window.kyclaw?.settings?.get()) ?? settings
    } catch (error) {
      // 读不到就先用默认值起（读盘/通道坏了不该拦住启动）
      console.error('读取设置失败，暂用默认值', error)
    }
    applyAppearance(settings)
    set({ settings, loaded: true })
  },

  update: async (patch) => {
    // 乐观应用：设置页的选中态和 html 属性都跟着立刻变
    const next = { ...get().settings, ...patch }
    applyAppearance(next)
    set({ settings: next })

    try {
      const persisted = await window.kyclaw?.settings?.update(patch)
      if (persisted) {
        // 主进程回吐的是落盘后的真相（合并结果以它为准）
        applyAppearance(persisted)
        set({ settings: persisted })
      }
    } catch (error) {
      console.error('设置落盘失败（本次改动只在本进程生效）', error)
    }
  }
}))
