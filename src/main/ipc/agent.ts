/**
 * agent 通道的 handler：把本地服务的端点（baseUrl + token）交给渲染端。
 * 端点从注册时传进来的取值函数拿——服务是 app ready 之后才起的，handler 注册在先。
 *
 * round 76（冷启动竞态）：服务没起来时**不再立刻抛** —— 生产 bundle 加载得快，渲染端常常比
 * 内嵌服务先问；一抛，界面当场落到错误卡，用户得手点一次重试。改成**挂起等一小会儿**：
 * 每隔 intervalMs 问一次，最多等到 timeoutMs；到点还没有才抛（渲染端照旧错误卡 + 重试）。
 * 三条口径：①**有限等**（无限等会把"服务真起不来"这条路径吞掉，用户永远停在载入态）；
 * ②**不重发**（只读 `getEndpoint` 现成的那一份，不自己去拉起服务）；③轮询而不是事件回调，
 * 是为了不牵扯主进程那侧的启动装配（`agentEndpoint` 由 index.ts 在服务就绪时赋值）。
 * 渲染端在这一段里不是白屏：输入卡第一帧就在，发送被挡住并显示「正在连接…」（见 ChatPage）。
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS, noArgsSchema, parseIpcArgs, type AgentEndpoint } from '../../shared/ipc'

/** 等端点就绪的上限：真机冷启动实测约 1s，余量留给慢机器与杀软扫描 */
export const AGENT_ENDPOINT_WAIT_MS = 8_000

/** 轮询间隔：就绪后最多再等这么久（对一次 IPC 往返来说是噪声级） */
export const AGENT_ENDPOINT_POLL_MS = 50

export interface AgentEndpointWaitPolicy {
  /** 端点就绪的最长等待（缺省 AGENT_ENDPOINT_WAIT_MS；单测注入小值） */
  timeoutMs?: number
  /** 轮询间隔（缺省 AGENT_ENDPOINT_POLL_MS） */
  intervalMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function registerAgentIpc(
  getEndpoint: () => AgentEndpoint | null,
  policy: AgentEndpointWaitPolicy = {}
): void {
  const timeoutMs = policy.timeoutMs ?? AGENT_ENDPOINT_WAIT_MS
  const intervalMs = policy.intervalMs ?? AGENT_ENDPOINT_POLL_MS
  ipcMain.handle(IPC_CHANNELS.agent.endpoint, async (_event, ...args): Promise<AgentEndpoint> => {
    // 入参闸门在最前：带入参的调用当场拒（与"等不等服务"无关）
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.agent.endpoint)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const endpoint = getEndpoint()
      if (endpoint !== null) return endpoint
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('agent 服务尚未启动')
      await delay(Math.min(intervalMs, remaining))
    }
  })
}
