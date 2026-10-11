/**
 * Mastra 实例装配：kyclaw agent + libsql storage + agent 级 Memory + AI SDK 兼容的 chat 路由。
 *
 * - storage 落 `dataDir/kyclaw.db`（生产即 %APPDATA%/kyclaw/kyclaw.db）：thread / resource 等
 *   持久化能力从这一层进来；Memory 的存储不单独配，走 Mastra 实例上这份（mastra.ai 文档口径）。
 * - agent 级 Memory（T9）：线程/消息持久化的本体；`lastMessages` 决定每轮给模型多少历史。
 * - working memory（T14）：resource 作用域的一份长期画像——记忆页读写的、助手在对话里更新的，
 *   都是它（`GET/PUT/DELETE /api/memory`）。
 * - **语义召回（round 28 模块 3）**：跨会话的长期记忆（新会话能想起旧会话聊过的相关内容）。
 *   `LibSQLVector` 与 storage **同库同文件**（`kyclaw.db`，@mastra/libsql 自带 vector 能力，
 *   不必引 LanceDB），embedder 由 mastra/embedding.ts 解析（OpenAI 兼容 `/embeddings`：baseURL +
 *   model + key；将来的本机引擎按同一形状接进来）。
 *   作用域固定 **resource**（单用户单 resource = 跨会话召回，这是"长期记忆"的定义；thread 口径
 *   只在本会话里找相似消息，不是这个需求）。起不来（服务不通 / 配置半截 / 启动自检不过）＝
 *   这一路没有召回，Memory 照常装配——失败只做加法（硬口径，见 embedding.ts 头注）。
 * - 用量记账（T14）：chat 路由的 `defaultOptions.onFinish` 从 run 收尾事件里取 usage，
 *   落 libsql 的 `usage_runs` 表（见 usage.ts 的头注：v7 的 UI 流 finish part 不带 usage）。
 * - 会话↔项目映射（T18）：同一份 libsql 里的 `session_projects` 表（见 session-projects.ts），
 *   在这里建好并注入 agent（工具按会话取根：项目 → 默认工作区 → 授权列表）。
 * - 追踪（T17）：Langfuse exporter **默认关**；地址 + 公私钥配齐（选项 `langfuse` 现读）才挂上
 *   observability 入口，判定与装配在 telemetry.ts。
 * - 产出物（模块 4）：五个格式工具在 agent 侧注册（tools/report|excel|ppt|docx.ts）；PDF 那件走
 *   **注入的 printPdf 钩子** —— 本模块不 import electron，真实现（Electron printToPDF）由 main/index.ts
 *   经选项传进来；没注入时 create_pdf 报"环境不支持"，其余四件照常。
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
import type { MastraEmbeddingModel } from '@mastra/core/vector'
import type { Project } from '../shared/projects'
import {
  DEFAULT_SEMANTIC_RECALL,
  type McpServerConfig,
  type PermissionRule,
  type SemanticRecallSettings,
  type Workspace
} from '../shared/settings'
import { createKyclawAgent, KYCLAW_AGENT_ID, type ModelResolver } from './agents/kyclaw'
import {
  compactionSqlClient,
  createCompactionProcessor,
  createCompactionService,
  createCompactionStore,
  type CompactionService
} from './compaction'
import {
  resolveRecall,
  SEMANTIC_RECALL_MESSAGE_RANGE,
  SEMANTIC_RECALL_TOP_K,
  validateRecallEmbedder,
  type LocalEmbeddingEndpoint,
  type RecallRuntime
} from './embedding'
import type { McpToolGate } from './mcp'
import type { PdfPrinter } from './tools/artifacts'
import { ProviderConfigError } from './model'
import { createSessionProjectStore, type SessionProjectStore } from './session-projects'
import { langfuseObservabilityQuietly, type LangfuseExportConfig } from './telemetry'
import { createUsageRecorder, createUsageStore, usageSqlClient, type UsageStore } from './usage'

/** libsql 库文件名（落在 dataDir 下） */
export const AGENT_DB_FILE = 'kyclaw.db'

/** chat 路由模板：实际路径是 /chat/kyclaw-agent（agent id 走动态段） */
export const CHAT_ROUTE_PATH = '/chat/:agentId'

/**
 * 每轮对话的**单轮步数预算**（round 33）：一次 stream 里「模型生成 → 执行工具 → 再生成」
 * 最多跑多少步。Mastra agent 的缺省预算很小（@mastra/core 的 `model.loop`：
 * `stopWhen ?? llmStepCountIs(5)`），一遇到多步任务就会**无声收尾**：最后一步的 finishReason
 * 还是 `tool-calls`，界面看起来就是"任务没做完就断了"（用户实报，trace e3530c7f…）。
 *
 * 更关键的是**审批挂起恢复流**也吃这个缺省值：恢复时走 `agent.resumeStream(...)`，
 * 它 `deepMerge(agent.getDefaultOptions(), streamOptions)`；chatRoute 的 `defaultOptions`
 * 经 `baseOptions` 传进来（@mastra/ai-sdk 的 `handleChatStream` → `streamV6ApprovalResumes`
 * → `resumeStream`），所以**同一处设置同时覆盖初始流与恢复流**（别再分两处挂）。
 *
 * 60 是"足够宽但不失控"的口径：个人桌面上的多步任务（查资料 + 写文件 + 跑命令）几十步足够；
 * 真到 60 步还没完，界面会给一行"已达单轮步数上限，回复「继续」可接着做"（见渲染端的轮末提示）。
 */
export const KYCLAW_MAX_STEPS = 60

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
  /** 会话↔项目映射的表读写口 + 内存镜像（/api/projects/mappings 与工具取根共用一份） */
  sessionProjects: SessionProjectStore
  /** round 19：上下文压缩（记录读写 + 摘要服务；注入处理器与 /api/threads/:id/compact 共用） */
  compaction: CompactionService
  /** T17：本次装配有没有挂上 Langfuse 导出（设置页拿它说"已开启 / 重启后开启"） */
  telemetry: { langfuse: boolean }
  /** round 28：本次装配的语义召回状态（/api/memory/recall 与设置页状态行读它） */
  recall: RecallRuntime
}

/** libsql 的 file: URL 只认正斜杠（Windows 的反斜杠会被当转义字符） */
function libsqlUrl(dataDir: string): string {
  return `file:${join(dataDir, AGENT_DB_FILE).replace(/\\/g, '/')}`
}

/**
 * C-1：聊天错误的人话映射（冲设计雷点 2.2 的修正）。
 *
 * 错误卡渲染的是**响应体原文**（ai@7 的 createUIApiCallError 把 response body 设为
 * error.message），所以 onError 的响应体必须是人话——后端原文/JSON blob 不能上卡：
 *   - `ProviderConfigError`（半截配置 / 密钥缺失，用户自己能修）→ 400 + 缺什么、去哪里补；
 *   - 其余未知错误 → 500 + 通用中文文案（真实原因只进服务端日志，不给用户看）。
 */
function userFacingError(error: Error): { status: 400 | 500; message: string } {
  if (error instanceof ProviderConfigError) {
    const missing = error.problems.map((problem) => problem.replace(/^配置不完整：/, '')).join('、')
    return {
      status: 400,
      message:
        missing === ''
          ? '模型配置还不完整，请到「设置 → 模型」里补齐后再试。'
          : `模型配置不完整：${missing}，请到「设置 → 模型」里补齐后再试。`
    }
  }
  return { status: 500, message: '服务出错了，请重试；若一直这样，重启应用再试一次。' }
}

export async function createKyclawMastra(options: {
  dataDir: string
  resolveModel: ModelResolver
  /** 授权工作区（工具权限边界）；缺省 = 没有工作区 */
  workspaces?: () => readonly Workspace[]
  /** 默认工作区（T18：没项目的会话用它当根）；缺省 = 没指认 */
  defaultWorkspace?: () => string | null
  /** 项目清单（T18）；缺省 = 没有项目 */
  projects?: () => readonly Project[]
  /** "永久允许"规则（T13：审批记忆落盘的那份设置）；缺省 = 没有规则 */
  permissionRules?: () => readonly PermissionRule[]
  /** MCP server 设置（T12：分级用"只读"标记、agent 现读）；缺省 = 没有 MCP */
  mcpServers?: () => readonly McpServerConfig[]
  /** MCP 工具来源（T12：lifecycle.tools）；缺省 = 没有 MCP 工具 */
  mcpTools?: (gate: McpToolGate) => Promise<Record<string, Tool>>
  /**
   * T17：Langfuse 追踪配置（现读的取值函数，由 main/index.ts 读设置 + safeStorage 密钥后注入）。
   * 缺省 = 不导出；返回 null（没配齐）同样不导出——见 telemetry.ts 的口径。
   */
  langfuse?: () => LangfuseExportConfig | null
  /**
   * round 28：语义召回设置（现读；装配只在启动时做一次——改设置要重启生效，与 langfuse 同口径）。
   * 缺省 = shared/settings 的缺省（开着；嵌入服务地址留空 = 这一路起不来）。
   */
  semanticRecall?: () => SemanticRecallSettings
  /** round 28：嵌入服务的 API Key（safeStorage 明文，只在主进程内存里；缺省 = null） */
  embeddingKey?: () => string | null
  /**
   * round 28 模块 3B：本机引擎的端点（主进程算；设置里来源选「本机引擎」时才会被调用）。
   * 缺省 = 没接上（这一路按"不可用"处理，不拦启动）。
   */
  localEmbedding?: () => Promise<LocalEmbeddingEndpoint | null>
  /** round 28：测试用——直接给一个 embedder（跳过设置解析与探测） */
  recallEmbedder?: MastraEmbeddingModel<string>
  /**
   * 模块 4：PDF 打印钩子（HTML → PDF 字节）。生产由 main/index.ts 注入 Electron printToPDF；
   * 缺省 = 没有（create_pdf 报"环境不支持"，其余产出物照常）。
   */
  printPdf?: PdfPrinter
}): Promise<KyclawMastra> {
  const { Mastra: MastraClass } = await import('@mastra/core/mastra')
  const { LibSQLStore: LibSQLStoreClass, LibSQLVector: LibSQLVectorClass } =
    await import('@mastra/libsql')
  const { Memory: MemoryClass } = await import('@mastra/memory')
  const { chatRoute } = await import('@mastra/ai-sdk')

  const storage = new LibSQLStoreClass({ id: 'kyclaw-storage', url: libsqlUrl(options.dataDir) })
  // 语义召回（round 28）：起不来就没有 embedder（这次运行不召回），Memory 装法完全不变。
  // 密钥取值函数就地调一次（跟 langfuse 的取值函数同口径：设置与密钥都现读，装配只做一次）
  const recall = await resolveRecall({
    settings: options.semanticRecall?.() ?? DEFAULT_SEMANTIC_RECALL,
    ...(options.embeddingKey === undefined ? {} : { embeddingKey: options.embeddingKey() }),
    ...(options.localEmbedding === undefined ? {} : { localEmbedding: options.localEmbedding }),
    ...(options.recallEmbedder === undefined ? {} : { embedder: options.recallEmbedder })
  })
  // storage 直接给 Memory（而不是只挂 Mastra 实例）：线程 API 在 agent 跑起来之前就会
  // 读存储（列会话/回灌），依赖"跑过一轮才被注册上"的隐式接线会在这一步炸
  const buildMemory = (embedder: MastraEmbeddingModel<string> | undefined): MastraMemory =>
    new MemoryClass({
      storage,
      // vector 与 storage 同库同文件：记忆的向量表（memory_messages*）就落在 kyclaw.db 里。
      // 没有 embedder 时不挂 vector —— 半截的"有库没模型"只会让每轮多绕一圈
      ...(embedder === undefined
        ? {}
        : {
            vector: new LibSQLVectorClass({ id: 'kyclaw-vector', url: libsqlUrl(options.dataDir) }),
            embedder
          }),
      options: {
        lastMessages: MEMORY_LAST_MESSAGES,
        // working memory（T14）：resource 作用域（缺省档）= 跨会话共享的一份长期画像，
        // 记忆页读写的与助手每轮系统提示里看到的是同一份（thread 档按会话隔离，不符合这个语义）
        workingMemory: {
          enabled: true,
          scope: 'resource',
          template: KYCLAW_WORKING_MEMORY_TEMPLATE
        },
        // 语义召回（round 28）：**resource 作用域 = 跨会话召回**（这是"长期记忆"的定义）。
        // 实测该版本（@mastra/memory 1.36.0 + @mastra/libsql 1.25.1）resource 档受支持：
        // 查询过滤 `{ resource_id }`，索引建表时按维度命名（如 memory_messages_1024）
        ...(embedder === undefined
          ? {}
          : {
              semanticRecall: {
                topK: SEMANTIC_RECALL_TOP_K,
                messageRange: SEMANTIC_RECALL_MESSAGE_RANGE,
                scope: 'resource' as const
              }
            })
      }
    })

  let memory = buildMemory(recall.embedder)
  if (recall.embedder !== undefined) {
    // 启动自检（实测过的硬边界）：Memory 每轮装配输入处理器时会先问 embedder 要维度，
    // 那一步抛错 = 整轮对话 500 —— 所以这里先把这条路跑通（跑通后它记忆化，之后 embedder
    // 再挂也只是"没有召回"）。不通过就用一份没有语义召回的 Memory 顶上：失败只做加法。
    const problem = await validateRecallEmbedder(memory)
    if (problem !== null) {
      console.warn(`[kyclaw] 语义召回：${problem}（这次运行不挂 embedder，对话不受影响）`)
      recall.markUnavailable(problem)
      memory = buildMemory(undefined)
    }
  }
  // 用量表与既有 Mastra 表同库：建表在这里（服务起来就建好），记账/查询共用这一个 store
  const usage = createUsageStore(usageSqlClient(storage))
  await usage.ensureTable()
  // 会话↔项目映射（T18）同库同寿命：表在这里建好；内存镜像是工具同步取根的来源
  const sessionProjects = createSessionProjectStore(storage)
  // 上下文压缩（round 19）：记录表同库；摘要服务用当前模型解析器，记账并进 usage
  const compactionStore = createCompactionStore(compactionSqlClient(storage))
  await compactionStore.ensureTable()
  const compaction = createCompactionService({
    memory,
    store: compactionStore,
    resolveModel: options.resolveModel,
    usage
  })
  // 追踪（T17）：默认关——没配齐（或建不起来）就没有 observability，Mastra 自己走 no-op
  const observability = await langfuseObservabilityQuietly(options.langfuse?.() ?? null)
  const mastra = new MastraClass({
    agents: {
      [KYCLAW_AGENT_ID]: await createKyclawAgent(options.resolveModel, memory, {
        workspaces: options.workspaces,
        defaultWorkspace: options.defaultWorkspace,
        projects: options.projects,
        projectOf: (threadId) => sessionProjects.get(threadId),
        permissionRules: options.permissionRules,
        mcpServers: options.mcpServers,
        mcpTools: options.mcpTools,
        // 模块 4：产出物的 PDF 钩子（缺省没有；有 electron 的那一侧才给得出真实现）
        printPdf: options.printPdf
      })
    },
    storage,
    ...(observability === null ? {} : { observability }),
    server: {
      apiRoutes: [
        chatRoute({
          path: CHAT_ROUTE_PATH,
          version: CHAT_PROTOCOL_VERSION,
          // 思考过程随流下发（round29）：库默认 false —— reasoning 只进存储、不进直播流，
          // 渲染端直播时先看到的是工具调用（观感首字延迟），刷新后才从存储回放出"思考过程"。
          // wire 形状钉在 __tests__/reasoning-stream.spec.ts（reasoning 先于 tool-input 到达）
          sendReasoning: true,
          // 记账钩子：每个 run 收尾取 totalUsage/model，落 usage_runs（细节见 usage.ts 头注）；
          // round 19：输入处理器把该会话的压缩摘要注入成系统前缀（不碰消息流/存储，见 compaction.ts）
          defaultOptions: {
            // round 33：单轮步数预算（初始流与审批恢复流共用这一处，机理见 KYCLAW_MAX_STEPS 头注）
            maxSteps: KYCLAW_MAX_STEPS,
            onFinish: createUsageRecorder({ store: usage }),
            inputProcessors: [createCompactionProcessor(compactionStore)]
          }
        })
      ],
      // C-1：chatRoute 的 handler 在流开始前抛错（如模型解析失败）时会走到这里
      // （@mastra/server 的 buildCustomRouteHandler.onError）。提供自定义 onError 后库不再
      // 自己记日志，所以真实错误在这里落（message 进字符串，排障复制即可）；响应体一律给人话
      // （错误卡原样渲染响应体，见上注）。
      onError: (error, c) => {
        const { status, message } = userFacingError(error)
        const detail = error instanceof Error ? error.message : String(error)
        console.error(`[kyclaw] 对话请求失败（已回 ${status} 的人话文案）：${detail}`, error)
        return c.text(message, status)
      }
    }
  })

  return {
    mastra,
    storage,
    memory,
    usage,
    sessionProjects,
    compaction,
    telemetry: { langfuse: observability !== null },
    recall
  }
}
