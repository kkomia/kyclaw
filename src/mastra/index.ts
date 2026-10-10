/**
 * Mastra 实例装配：kyclaw agent + libsql storage + agent 级 Memory + AI SDK 兼容的 chat 路由。
 *
 * - storage 落 `dataDir/kyclaw.db`（生产即 %APPDATA%/kyclaw/kyclaw.db）：thread / resource 等
 *   持久化能力从这一层进来；Memory 的存储不单独配，走 Mastra 实例上这份（mastra.ai 文档口径）。
 * - agent 级 Memory（T9）：线程/消息持久化的本体；`lastMessages` 决定每轮给模型多少历史。
 * - working memory（T14）：resource 作用域的一份长期画像——记忆页读写的、助手在对话里更新的，
 *   都是它（`GET/PUT/DELETE /api/memory`）。
 * - 用量记账（T14）：chat 路由的 `defaultOptions.onFinish` 从 run 收尾事件里取 usage，
 *   落 libsql 的 `usage_runs` 表（见 usage.ts 的头注：v7 的 UI 流 finish part 不带 usage）。
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
import type { Tool } from '@mastra/core/tools'
import type { LibSQLStore } from '@mastra/libsql'
import type { Mastra } from '@mastra/core/mastra'
import type { MastraMemory } from '@mastra/core/memory'
import type { McpServerConfig, PermissionRule, Workspace } from '../shared/settings'
import { createKyclawAgent, KYCLAW_AGENT_ID, type ModelResolver } from './agents/kyclaw'
import type { McpToolGate } from './mcp'
import { createUsageRecorder, createUsageStore, usageSqlClient, type UsageStore } from './usage'

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
 * 个人桌面场景下多留一些（约几十轮对话），免得用户觉得"它怎么不记得了"。
 * 注意它数的是**存储消息**：一张工具调用+结果算两条。
 * 可调上限（以及长会话的分页/摘要）仍没做——T14 管的是 working memory（跨会话的画像），
 * 与这一项是两个开关，别把"记不住"的锅扣到记忆页上（见 task-14-report 的遗留）。
 */
export const MEMORY_LAST_MESSAGES = 40

/**
 * working memory 的模板（Markdown，中文）：助手按它维护一份用户画像。
 * 模板的每一行都会出现在「记忆」页上——所以只放用户看得懂的字段，且保持"空字段也保留"
 * （Mastra 的更新指令要求整块回写、不许删空段）。
 */
export const KYCLAW_WORKING_MEMORY_TEMPLATE = `# 用户信息
- 姓名：
- 城市：
- 职业：
- 长期偏好：
- 长期目标：
- 正在进行的项目：
`

export interface KyclawMastra {
  mastra: Mastra
  storage: LibSQLStore
  memory: MastraMemory
  /** 用量表的读写口（/api/usage 与记账钩子共用一份） */
  usage: UsageStore
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
  /** "永久允许"规则（T13：审批记忆落盘的那份设置）；缺省 = 没有规则 */
  permissionRules?: () => readonly PermissionRule[]
  /** MCP server 设置（T12：分级用"只读"标记、agent 现读）；缺省 = 没有 MCP */
  mcpServers?: () => readonly McpServerConfig[]
  /** MCP 工具来源（T12：lifecycle.tools）；缺省 = 没有 MCP 工具 */
  mcpTools?: (gate: McpToolGate) => Promise<Record<string, Tool>>
}): Promise<KyclawMastra> {
  const { Mastra: MastraClass } = await import('@mastra/core/mastra')
  const { LibSQLStore: LibSQLStoreClass } = await import('@mastra/libsql')
  const { Memory: MemoryClass } = await import('@mastra/memory')
  const { chatRoute } = await import('@mastra/ai-sdk')

  const storage = new LibSQLStoreClass({ id: 'kyclaw-storage', url: libsqlUrl(options.dataDir) })
  // storage 直接给 Memory（而不是只挂 Mastra 实例）：线程 API 在 agent 跑起来之前就会
  // 读存储（列会话/回灌），依赖"跑过一轮才被注册上"的隐式接线会在这一步炸
  const memory = new MemoryClass({
    storage,
    options: {
      lastMessages: MEMORY_LAST_MESSAGES,
      // working memory（T14）：resource 作用域（缺省档）= 跨会话共享的一份长期画像，
      // 记忆页读写的与助手每轮系统提示里看到的是同一份（thread 档按会话隔离，不符合这个语义）
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template: KYCLAW_WORKING_MEMORY_TEMPLATE
      }
    }
  })
  // 用量表与既有 Mastra 表同库：建表在这里（服务起来就建好），记账/查询共用这一个 store
  const usage = createUsageStore(usageSqlClient(storage))
  await usage.ensureTable()
  const mastra = new MastraClass({
    agents: {
      [KYCLAW_AGENT_ID]: await createKyclawAgent(options.resolveModel, memory, {
        workspaces: options.workspaces,
        permissionRules: options.permissionRules,
        mcpServers: options.mcpServers,
        mcpTools: options.mcpTools
      })
    },
    storage,
    server: {
      apiRoutes: [
        chatRoute({
          path: CHAT_ROUTE_PATH,
          version: CHAT_PROTOCOL_VERSION,
          // 记账钩子：每个 run 收尾取 totalUsage/model，落 usage_runs（细节见 usage.ts 头注）
          defaultOptions: { onFinish: createUsageRecorder({ store: usage }) }
        })
      ]
    }
  })

  return { mastra, storage, memory, usage }
}
