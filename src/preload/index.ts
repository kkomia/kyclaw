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
  IPC_CHANNELS,
  windowStateSchema,
  type KyclawApi,
  type KyclawWindowApi
} from '../shared/ipc'

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

export const kyclawApi: KyclawApi = { window: windowApi }

// contextIsolation 默认开（窗口配置没有关它）；关掉时退回直接挂到 window。
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('kyclaw', kyclawApi)
} else {
  // contextIsolation 被关掉时才走这里（窗口配置没有关它）；声明在 index.d.ts（渲染端读的那份）
  const host = window as unknown as Record<string, unknown>
  host.kyclaw = kyclawApi
}
