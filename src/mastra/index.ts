/**
 * Mastra 实例装配：kyclaw agent + libsql storage + AI SDK 兼容的 chat 路由。
 *
 * - storage 落 `dataDir/kyclaw.db`（生产即 %APPDATA%/kyclaw/kyclaw.db）：thread / resource 等
 *   持久化能力从这一层进来；working memory、语义召回属于 T9/T14，本任务不配 agent memory。
 * - chat 路由用 @mastra/ai-sdk 的 `chatRoute`：`POST /chat/:agentId`，响应是 AI SDK UI 消息流
 *   （SSE）——T7 的 useChat 直接吃这口。
 *
 * 依赖全是 ESM-only（@mastra/*），主进程产物是 CJS：运行时对象一律动态 import()，
 * 本模块只对"类型"做静态 import（编译期擦除）。
 */
import { join } from 'node:path'
import type { LibSQLStore } from '@mastra/libsql'
import type { Mastra } from '@mastra/core/mastra'
import { createKyclawAgent, KYCLAW_AGENT_ID, type ModelResolver } from './agents/kyclaw'

/** libsql 库文件名（落在 dataDir 下） */
export const AGENT_DB_FILE = 'kyclaw.db'

/** chat 路由模板：实际路径是 /chat/kyclaw-agent（agent id 走动态段） */
export const CHAT_ROUTE_PATH = '/chat/:agentId'

export interface KyclawMastra {
  mastra: Mastra
  storage: LibSQLStore
}

/** libsql 的 file: URL 只认正斜杠（Windows 的反斜杠会被当转义字符） */
function libsqlUrl(dataDir: string): string {
  return `file:${join(dataDir, AGENT_DB_FILE).replace(/\\/g, '/')}`
}

export async function createKyclawMastra(options: {
  dataDir: string
  resolveModel: ModelResolver
}): Promise<KyclawMastra> {
  const { Mastra: MastraClass } = await import('@mastra/core/mastra')
  const { LibSQLStore: LibSQLStoreClass } = await import('@mastra/libsql')
  const { chatRoute } = await import('@mastra/ai-sdk')

  const storage = new LibSQLStoreClass({ id: 'kyclaw-storage', url: libsqlUrl(options.dataDir) })
  const mastra = new MastraClass({
    agents: { [KYCLAW_AGENT_ID]: await createKyclawAgent(options.resolveModel) },
    storage,
    server: { apiRoutes: [chatRoute({ path: CHAT_ROUTE_PATH })] }
  })

  return { mastra, storage }
}
