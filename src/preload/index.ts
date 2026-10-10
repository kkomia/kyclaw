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
  providerKeyStatesSchema,
  setProviderKeyResultSchema,
  windowStateSchema,
  type KyclawAgentApi,
  type KyclawApi,
  type KyclawSettingsApi,
  type KyclawWindowApi,
  type KyclawWorkspaceApi
} from '../shared/ipc'
import { appSettingsSchema, defaultSettings, type AppSettings } from '../shared/settings'

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
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.settings.removeProvider, id))
}

/**
 * 工作区面：授权目录的增删与访问模式。回包与设置同一份 schema（就是落盘后的完整设置），
 * 结构不对就当没读到（回默认值）——不给渲染端半截对象。
 * 路径合法性不由这里管：主进程会在写授权列表之前校验（存在、是目录、非 UNC）。
 */
const workspaceApi: KyclawWorkspaceApi = {
  pick: async () => parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.pick)),
  add: async (path, mode) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.add, path, mode)),
  remove: async (path) =>
    parseSettings(await ipcRenderer.invoke(IPC_CHANNELS.workspace.remove, path))
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

export const kyclawApi: KyclawApi = {
  window: windowApi,
  settings: settingsApi,
  workspace: workspaceApi,
  agent: agentApi
}

// contextIsolation 默认开（窗口配置没有关它）；关掉时退回直接挂到 window。
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('kyclaw', kyclawApi)
} else {
  // contextIsolation 被关掉时才走这里（窗口配置没有关它）；声明在 index.d.ts（渲染端读的那份）
  const host = window as unknown as Record<string, unknown>
  host.kyclaw = kyclawApi
}
