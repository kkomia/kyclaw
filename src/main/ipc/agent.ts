/**
 * agent 通道的 handler：把本地服务的端点（baseUrl + token）交给渲染端。
 * 端点从注册时传进来的取值函数拿——服务是 app ready 之后才起的，handler 注册在先；
 * 服务还没起来时**抛错**（不静默回半截端点：渲染端拿不到 baseUrl 就该看到失败）。
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS, noArgsSchema, parseIpcArgs, type AgentEndpoint } from '../../shared/ipc'

export function registerAgentIpc(getEndpoint: () => AgentEndpoint | null): void {
  ipcMain.handle(IPC_CHANNELS.agent.endpoint, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.agent.endpoint)
    const endpoint = getEndpoint()
    if (!endpoint) throw new Error('agent 服务尚未启动')
    return endpoint
  })
}
