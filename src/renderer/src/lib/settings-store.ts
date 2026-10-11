import { create } from 'zustand'
import {
  defaultSettings,
  type AppSettings,
  type AppSettingsPatch,
  type ModelPrefs,
  type WorkspaceMode
} from '@shared/settings'
import type { Project } from '@shared/projects'
import type { KyclawProjectsApi, KyclawWorkspaceApi } from '@shared/ipc'
import { withAllowedRule } from '@shared/permissions'
import type { ProviderConfig } from '@shared/providers'
import { setFontTier, setTheme } from './theme'

/**
 * 设置的渲染端副本 + 外观副作用。落盘在主进程（settings:* 通道），这里只管两件事：
 *   1. 启动时把落盘的外观应用到 html（主题 / 字号），让壳第一帧就对；
 *   2. 用户改动：先应用（立刻见效）再落盘，落盘失败只记日志不回滚
 *      —— 写失败不该让 UI 跟用户的选择打架，也还没有放错误条的层（spec §7.3 的状态条后置）。
 * `window.kyclaw` 缺失（浏览器里看渲染端 / 单测）时全体走默认值，不抛。
 *
 * provider 的保存（saveProviders / removeProvider）与外观不同：**不发乐观态、失败会抛**——
 * 模型/密钥配错了是要让用户看见的，UI 也不该显示一条其实没落盘的 provider。
 * 工作区（pickWorkspace / addWorkspace / setWorkspaceMode / removeWorkspace）同理：路径合法性判在主进程，
 * 失败（选了 UNC / 目录没了 / 切一个不在列表里的路径）必须把原因交回给设置页行内显示，
 * 这里的副本一律以落盘回吐为准。
 * 项目（createProject / removeProject / pickProjectFolder）与默认工作区（pickDefaultWorkspace）
 * 是同一族：项目路径与授权目录同源校验（都过 checkWorkspacePath），失败也要能回行内显示。
 * 审批卡"永久允许"落下的规则（allowToolForever）也归这一族：写没写进去要让用户看见
 * （调用方把失败露到界面上），不能静默当成"已经永远允许了"。
 */
function applyAppearance(settings: AppSettings): void {
  setTheme(settings.theme)
  setFontTier(settings.fontTier)
}

/** 工作区通道（缺失=浏览器/单测环境）：所有工作区动作共用这一个入口与同一句交代 */
function workspaceApi(): KyclawWorkspaceApi {
  const api = window.kyclaw?.workspace
  if (!api) throw new Error('工作区通道不可用（window.kyclaw 缺失），改动没有保存')
  return api
}

/** 项目通道（缺失=浏览器/单测环境）：项目动作共用这一个入口与同一句交代 */
function projectsApi(): KyclawProjectsApi {
  const api = window.kyclaw?.projects
  if (!api) throw new Error('项目通道不可用（window.kyclaw 缺失），改动没有保存')
  return api
}

/** 设置通道（缺失=浏览器/单测环境）：写设置的动作共用这一个入口与同一句交代 */
function settingsApi(): NonNullable<Window['kyclaw']>['settings'] {
  const api = window.kyclaw?.settings
  if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），改动没有保存')
  return api
}

export interface SettingsState {
  settings: AppSettings
  /** 首次读盘完成没有（读完前 UI 显示默认值） */
  loaded: boolean
  load: () => Promise<void>
  update: (patch: AppSettingsPatch) => Promise<void>
  /** 保存 provider 列表（模型设置页）：以落盘结果为准，失败抛给调用方 */
  saveProviders: (providers: ProviderConfig[]) => Promise<void>
  /** round 18：保存模型级偏好（思考挡位 / 对话长度百分比；以落盘结果为准，失败抛） */
  saveModelPrefs: (modelPrefs: Record<string, ModelPrefs>) => Promise<void>
  /** T17：保存 Langfuse 服务地址（追踪栏；密钥不在设置里，走 telemetry 通道） */
  saveLangfuseEndpoint: (endpoint: string) => Promise<void>
  /** 删除一条 provider（连带清密钥）：同样以落盘结果为准 */
  removeProvider: (id: string) => Promise<void>
  /** 审批卡"永久允许"：追加一条规则并落盘；以落盘结果为准，失败抛给调用方 */
  allowToolForever: (tool: string, workspace: string) => Promise<void>
  /** 打开原生选择器添加一个工作区（取消 = 什么都没发生） */
  pickWorkspace: () => Promise<void>
  /** 添加工作区（一律以 ask 落盘；已在列表里是幂等空操作） */
  addWorkspace: (path: string) => Promise<void>
  /** 切换一个已授权工作区的访问模式（full 属于这里：设置页里带确认的显式动作） */
  setWorkspaceMode: (path: string, mode: WorkspaceMode) => Promise<void>
  /** 移除一个工作区（不在列表里是空操作） */
  removeWorkspace: (path: string) => Promise<void>
  /** T18：指认默认工作区（原生选择器；取消 = 什么都没发生） */
  pickDefaultWorkspace: () => Promise<void>
  /** T18：空白项目的默认基底目录（创建对话框的默认路径用） */
  projectBase: () => Promise<string>
  /** T18：创建项目（路径不存在就建目录）；成功回新项目，失败抛给调用方 */
  createProject: (name: string, path: string) => Promise<Project | null>
  /** T18：删除项目（只摘清单；失败抛给调用方） */
  removeProject: (id: string) => Promise<void>
  /** T18：挑一个项目文件夹（原生选择器；取消回 null）——只回路径，不落盘、不授权 */
  pickProjectFolder: () => Promise<string | null>
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
  },

  saveProviders: async (providers) => {
    const api = window.kyclaw?.settings
    if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），provider 没有保存')
    set({ settings: await api.update({ providers }) })
  },

  /** round 18：模型级偏好（思考挡位 / 对话长度百分比）——与 provider 同族：失败抛给调用方 */
  saveModelPrefs: async (modelPrefs) => {
    set({ settings: await settingsApi().update({ modelPrefs }) })
  },

  saveLangfuseEndpoint: async (endpoint) => {
    // 与 provider 同族：失败抛给调用方，界面上要能看见"没存进去"
    set({ settings: await settingsApi().update({ langfuse: { endpoint } }) })
  },

  removeProvider: async (id) => {
    const api = window.kyclaw?.settings
    if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），provider 没有删除')
    set({ settings: await api.removeProvider(id) })
  },

  allowToolForever: async (tool, workspace) => {
    const rules = withAllowedRule(get().settings.permissions.rules, tool, workspace)
    set({ settings: await settingsApi().update({ permissions: { rules } }) })
  },

  pickWorkspace: async () => {
    set({ settings: await workspaceApi().pick() })
  },

  addWorkspace: async (path) => {
    set({ settings: await workspaceApi().add(path) })
  },

  setWorkspaceMode: async (path, mode) => {
    set({ settings: await workspaceApi().setMode(path, mode) })
  },

  removeWorkspace: async (path) => {
    set({ settings: await workspaceApi().remove(path) })
  },

  pickDefaultWorkspace: async () => {
    set({ settings: await workspaceApi().pickDefault() })
  },

  projectBase: async () => {
    const { base } = await projectsApi().base()
    return base
  },

  createProject: async (name, path) => {
    const before = new Set(get().settings.projects.map((project) => project.id))
    const settings = await projectsApi().create(name, path)
    set({ settings })
    // 新项目 = 落盘回包里多出来的那条（按 id 差集找，别用路径字符串比 —— 主进程会 realpath 归一）
    return settings.projects.find((project) => !before.has(project.id)) ?? null
  },

  removeProject: async (id) => {
    set({ settings: await projectsApi().remove(id) })
  },

  pickProjectFolder: async () => {
    const { path } = await projectsApi().pickFolder()
    return path
  }
}))
