/**
 * Mastra 实例装配：kyclaw agent + libsql storage + agent 级 Memory + AI SDK 兼容的 chat 路由。
 *
 * - storage 落 `dataDir/kyclaw.db`（生产即 %APPDATA%/kyclaw/kyclaw.db）：thread / resource 等
 *   持久化能力从这一层进来；Memory 的存储不单独配，走 Mastra 实例上这份（mastra.ai 文档口径）。
 * - agent 级 Memory（T9）：线程/消息持久化的本体；`lastMessages` 决定每轮给模型多少历史。
 * - chat 路由用 @mastra/ai-sdk 的 `chatRoute`：`POST /chat/:agentId`，响应是 AI SDK UI 消息流
 *   （SSE）——T7 的 useChat 直接吃这口。
 * - 协议版本 v7（T11）：渲染端是 ai@7；**工具审批 part（`tool-approval-request`）只在 v6 及以后
 *   存在**。默认的 v5 会把审批请求降级成 Mastra 私有的 `data-tool-call-approval` 数据 part，
 *   客户端拿不到 `approval-requested` 状态（实测，见 task-11-report）。
 * - 审批挂起靠 storage 里的快照（HITL 文档：没有 storage 会 "snapshot not found"），
 *   所以这条链路依赖上面那份 LibSQLStore —— 已经在。
 *
 * 依赖全是 ESM-only（@mastra/*），主进程产物是 CJS：运行时对象一律动态 import()，
 * 本模块只对"类型"做静态 import（编译期擦除）。
 */
import { join } from 'node:path'
import type { LibSQLStore } from '@mastra/libsql'
import type { Mastra } from '@mastra/core/mastra'
import type { MastraMemory } from '@mastra/core/memory'
import type { Workspace } from '../shared/settings'
import { createKyclawAgent, KYCLAW_AGENT_ID, type ModelResolver } from './agents/kyclaw'

/** libsql 库文件名（落在 dataDir 下） */
export const AGENT_DB_FILE = 'kyclaw.db'

/** chat 路由模板：实际路径是 /chat/kyclaw-agent（agent id 走动态段） */
export const CHAT_ROUTE_PATH = '/chat/:agentId'

/**
 * chat 路由的 AI SDK UI 协议版本：v7 = 渲染端 ai@7 的原生口径。
 * 工具审批的 `tool-approval-request` part 从 v6 起才有；v5（库的缺省）拿不到审批状态。
 */
export const CHAT_PROTOCOL_VERSION = 'v7'

/**
 * 每轮喂给模型的历史消息条数上限（Mastra Memory 的 lastMessages，缺省 10）。
 * 个人桌面场景下多留一些（约几十轮对话），免得用户觉得"它怎么不记得了"；
 * 真要精细化是 T14（记忆管理）的事。注意它数的是**存储消息**：一张工具调用+结果算两条。
 */
export const MEMORY_LAST_MESSAGES = 40

export interface KyclawMastra {
  mastra: Mastra
  storage: LibSQLStore
  memory: MastraMemory
}

/** libsql 的 file: URL 只认正斜杠（Windows 的反斜杠会被当转义字符） */
function libsqlUrl(dataDir: string): string {
  return `file:${join(dataDir, AGENT_DB_FILE).replace(/\\/g, '/')}`
}

export async function createKyclawMastra(options: {
  dataDir: string
  resolveModel: ModelResolver
  /** 授权工作区（工具权限边界）；缺省 = 没有工作区 */
  workspaces?: () => readonly Workspace[]
}): Promise<KyclawMastra> {
  const { Mastra: MastraClass } = await import('@mastra/core/mastra')
  const { LibSQLStore: LibSQLStoreClass } = await import('@mastra/libsql')
  const { Memory: MemoryClass } = await import('@mastra/memory')
  const { chatRoute } = await import('@mastra/ai-sdk')

  const storage = new LibSQLStoreClass({ id: 'kyclaw-storage', url: libsqlUrl(options.dataDir) })
  // storage 直接给 Memory（而不是只挂 Mastra 实例）：线程 API 在 agent 跑起来之前就会
  // 读存储（列会话/回灌），依赖"跑过一轮才被注册上"的隐式接线会在这一步炸
  const memory = new MemoryClass({ storage, options: { lastMessages: MEMORY_LAST_MESSAGES } })
  const mastra = new MastraClass({
    agents: {
      [KYCLAW_AGENT_ID]: await createKyclawAgent(options.resolveModel, memory, {
        workspaces: options.workspaces
      })
    },
    storage,
    server: {
      apiRoutes: [chatRoute({ path: CHAT_ROUTE_PATH, version: CHAT_PROTOCOL_VERSION })]
    }
  })

  return { mastra, storage, memory }
}
