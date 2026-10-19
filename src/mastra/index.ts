/**
 * Mastra 实例装配：kyclaw agent + libsql storage + agent 级 Memory + AI SDK 兼容的 chat 路由。
 *
 * - storage 落 `dataDir/kyclaw.db`（生产即 %APPDATA%/kyclaw/kyclaw.db）：thread / resource 等
 *   持久化能力从这一层进来；Memory 的存储不单独配，走 Mastra 实例上这份（mastra.ai 文档口径）。
 * - agent 级 Memory（T9）：线程/消息持久化的本体；`lastMessages` 决定每轮给模型多少历史。
 * - working memory（T14）：**每个会话一份**的画像（round 58：作用域从 resource 改成 thread）——
 *   记忆页读写的、助手在对话里更新的，都是**当前会话**那一条
 *   （`GET/PUT/DELETE /api/memory?threadId=…`）。用户口径：开几个会话就是为了隔离上下文，
 *   跨会话共享一律不再做（库里旧的 resource 画像留在原处，改后不再被读）。
 * - **语义召回（round 28 模块 3）**：把**本会话**早先聊过的相关内容找回来。
 *   `LibSQLVector` 与 storage **同库同文件**（`kyclaw.db`，@mastra/libsql 自带 vector 能力，
 *   不必引 LanceDB），embedder 由 mastra/embedding.ts 解析（OpenAI 兼容 `/embeddings`：baseURL +
 *   model + key；将来的本机引擎按同一形状接进来）。
 *   作用域 **thread**（round 58 从 resource 改过来：召回只在本会话的消息里找，同记忆的隔离口径）。
 *   起不来（服务不通 / 配置半截 / 启动自检不过）＝
 *   这一路没有召回，Memory 照常装配——失败只做加法（硬口径，见 embedding.ts 头注）。
 * - 用量记账（T14）：chat 路由的 `defaultOptions.onFinish` 从 run 收尾事件里取 usage，
 *   落 libsql 的 `usage_runs` 表（见 usage.ts 的头注：v7 的 UI 流 finish part 不带 usage）。
 * - 会话↔项目映射（T18）：同一份 libsql 里的 `session_projects` 表（见 session-projects.ts），
 *   在这里建好并注入 agent（工具按会话取根：项目 → 默认工作区下的会话子目录 → 授权列表）。
 * - 会话↔PPT 模板映射（round 66）：同一份 libsql 里的 `session_ppt_templates` 表
 *   （见 session-ppt-templates.ts），在这里建好并注入 agent —— create_ppt 不指定 theme 时
 *   按**本会话**取缺省模板（模板选择是会话级的，不落全局设置）。
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
  type NetworkSettings,
  type PermissionRule,
  type SemanticRecallSettings,
  type Workspace
} from '../shared/settings'
import type { WebSearchRuntime } from '../shared/search'
import type { SkillSource } from '../shared/skills'
import { setSkillRuntimeFactsSource, type SkillRuntimeFactsSource } from './skills/runtime'
import type { AuthoringRuntime } from '../shared/authoring'
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
import type { WebSearchDeps } from './search/backends'
import { ProviderConfigError } from './model'
import { createSessionProjectStore, type SessionProjectStore } from './session-projects'
import { createSessionPptSourceStore, type SessionPptSourceStore } from './session-ppt-sources'
import { createSessionDocxSourceStore, type SessionDocxSourceStore } from './session-docx-sources'
import {
  createSessionPptTemplateStore,
  type SessionPptTemplateStore
} from './session-ppt-templates'
import { langfuseObservabilityQuietly, type LangfuseExportConfig } from './telemetry'
import { createAskUserRoutes } from './routes/ask-user'
import { createSessionTaskStore, type SessionTaskStore } from './session-tasks'
import { createTasksContext, type TasksContext } from './tasks-context'
import { prepareTaskChatParams } from './tasks-chat'
import { AskUserRuntime } from './ask-user-runtime'
import { createSessionPlanStore, type SessionPlanStore } from './session-plan'
import { createSessionGoalStore, SessionGoalError, type SessionGoalStore } from './session-goal'
import { GOAL_ROUND_CONTEXT_KEY, goalRoundFromChatBody } from '../shared/goal'
import { createPlanRuntime, planRefOf, type PlanRuntime, type PlanSuspension } from './plan-runtime'
import { createPlanRoutes } from './routes/plans'
import { planRefSchema } from '../shared/plan'
import { createRulesProcessor, type RulesProcessorDependencies } from './rules'
import {
  createRequestFailureRecorder,
  createRequestSnapshotRecorder,
  createRequestSnapshotStore,
  tapStreamFailures,
  type RequestSnapshotStore
} from './request-log'
import {
  createUsageRecorder,
  createUsageStore,
  threadTokenReadout,
  usageSqlClient,
  type UsageStore
} from './usage'

/** libsql 库文件名（落在 dataDir 下） */
export const AGENT_DB_FILE = 'kyclaw.db'

/** chat 路由模板：实际路径是 /chat/kyclaw-agent（agent id 走动态段） */
export const CHAT_ROUTE_PATH = '/chat/:agentId'

/**
 * 单轮步数的**跑飞兜底**（round 36；口径来自 DeepSeek Harness 源码实证，归档
 * `.superpowers/sdd/2026-10-10-kyclaw-mvp/agent-steps-design-ref.md`）。
 *
 * DSH 的 agent 循环是 `while(true)`，**没有单轮步数上限**：一轮结束只有五种原因 ——
 * `completed`（模型不再要工具调用）/ `max-tokens` / `blocked` / `aborted` / `error`。
 * 它把资源收口放在别处：每步工具 **并发默认 10**（只读滚动池 + 有副作用串行屏障）、
 * 逐工具**超时**、以及**内容预算**（上下文 1M / 压缩 0.8 / 工具结果 spill 12500 + prune 8192）。
 * 包自带 README 的原话："No built-in turn budget … a policy that bounds runaway turns must
 * cancel from an existing lifecycle extension point" —— 限轮数被明确设计成上层策略；
 * 唯一带 maxRounds 的 ralph 插件默认 `disabled: true`。
 *
 * 所以"上限 = 任务边界"是错的：**正常结束靠语义**（模型不再调工具），这个常量只在真跑飞时兜底。
 * 1000 是一个人一天也走不到的量级，不该成为任何正常任务的边界；真撞上，界面会给一行
 * "已达单轮步数上限，回复「继续」可接着做"（见渲染端 ChatPage 的轮末提示），用户能看出是兜底触发了
 * （可观测性：finishReason=tool-calls 收尾就是它，与 completed 的 stop 分得开）。
 *
 * 为什么必须**显式**给一个值：Mastra agent 的缺省步数预算很小（@mastra/core 的 `model.loop`：
 * `stopWhen ?? llmStepCountIs(5)`），多步任务会**无声收尾** —— 最后一步 finishReason 还是
 * `tool-calls`，界面看起来就是"任务没做完就断了"（用户实报，trace e3530c7f…）。这个值同时覆盖
 * **审批挂起恢复流**：恢复时走 `agent.resumeStream(...)`，它 `deepMerge(agent.getDefaultOptions(),
 * streamOptions)`；chatRoute 的 `defaultOptions` 经 `baseOptions` 传进来（@mastra/ai-sdk 的
 * `handleChatStream` → `streamV6ApprovalResumes` → `resumeStream`），所以**同一处设置同时覆盖
 * 初始流与恢复流**（别再分两处挂）。
 */
export const KYCLAW_MAX_STEPS = 1000

/**
 * chat 路由的 AI SDK UI 协议版本：v7 = 渲染端 ai@7 的原生口径。
 * 工具审批的 `tool-approval-request` part 从 v6 起才有；v5（库的缺省）拿不到审批状态。
 */
export const CHAT_PROTOCOL_VERSION = 'v7'

/**
 * 每轮喂给模型的历史消息条数上限（Mastra Memory 的 lastMessages，缺省 10）。
 * 个人桌面场景下多留一些（约几十轮对话），免得用户觉得"它怎么不记得了"。
 * 注意它数的是**存储消息**：一张工具调用+结果算两条。
 * 可调上限（以及长会话的分页/摘要）仍没做——T14 管的是 working memory（每个会话一份的画像，
 * round 58 起按会话隔离），与这一项是两个开关，别把"记不住"的锅扣到记忆页上
 * （见 task-14-report 的遗留）。
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
  tasks: SessionTaskStore
  tasksContext: TasksContext
  plans: SessionPlanStore
  planRuntime: PlanRuntime
  /** PB-039：每会话一个 goal 的权威状态（revision CAS + 进程本地 activation） */
  goals: SessionGoalStore
  mastra: Mastra
  storage: LibSQLStore
  memory: MastraMemory
  /** 用量表的读写口（/api/usage 与记账钩子共用一份） */
  usage: UsageStore
  /**
   * round 87：请求快照（系统指令 / 工具表）的表读写口
   * （/api/trajectory/requests 与记账钩子共用一份；用户反馈 015 的原料）
   */
  requestSnapshots: RequestSnapshotStore
  /** 会话↔项目映射的表读写口 + 内存镜像（/api/projects/mappings 与工具取根共用一份） */
  sessionProjects: SessionProjectStore
  /**
   * round 66：会话↔PPT 模板映射的表读写口 + 内存镜像
   * （/api/ppt/templates 与 create_ppt 的缺省模板共用一份）
   */
  sessionPptTemplates: SessionPptTemplateStore
  /**
   * round 76：会话↔PPT **源结构**的表读写口（create_ppt 记、edit_ppt 读改）。
   * 不带内存镜像：它只被 edit_ppt 读（一次编辑读一次，本来就是异步），见 session-ppt-sources.ts 头注。
   */
  sessionPptSources: SessionPptSourceStore
  /**
   * 会话↔**Word 源结构**的表读写口（create_docx 记、edit_docx 读改）。与 PPT 那份同形，
   * 同样不带内存镜像（只被 edit_docx 一次编辑读一次，本来就是异步），见 session-docx-sources.ts 头注。
   */
  sessionDocxSources: SessionDocxSourceStore
  /** round 19：上下文压缩（记录读写 + 摘要服务；注入处理器与 /api/threads/:id/compact 共用） */
  compaction: CompactionService
  /** T17：本次装配有没有挂上 Langfuse 导出（设置页拿它说"已开启 / 重启后开启"） */
  telemetry: { langfuse: boolean }
  /** round 28：本次装配的语义召回状态（/api/memory/recall 与设置页状态行读它） */
  recall: RecallRuntime
  rules: { processorRegistered: boolean }
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

/**
 * 这一轮**真实的 runId**：`prepareTaskChatParams` 每条请求都产一个（任务处理链会按它校验
 * 每一步的 runId），所以会话入口的失败行也挂得上真 run。
 * 用窄读而不是断言：`ChatStreamHandlerParams` 的类型面没声明这个字段，运行时才有。
 */
function preparedRunId(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null
  const value = (params as { runId?: unknown }).runId
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export async function createKyclawMastra(options: {
  dataDir: string
  resolveModel: ModelResolver
  rules?: Pick<RulesProcessorDependencies, 'readGlobalRules' | 'readProjectRules' | 'onDiagnostics'>
  /** 授权工作区（工具权限边界）；缺省 = 没有工作区 */
  workspaces?: () => readonly Workspace[]
  /** 默认工作区（T18：没项目的会话在它下面的会话子目录里干活）；缺省 = 没指认 */
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
  /**
   * round 45：联网搜索的运行时配置（现读：设置 + Exa/Tavily/Jina 三个可选 Key）。
   * 缺省 = 免费档、没 Key（web_search 仍可用；fetch 阅读模式走免费档）。
   */
  webSearch?: () => WebSearchRuntime
  /** round 45：搜索依赖（测试注入假 fetch / 客户端；生产不传） */
  searchDeps?: WebSearchDeps
  /**
   * round 73：fetch 出站边界的白名单（**现读**的取值函数；缺省 = 一个本机/内网主机都不放行）。
   * 由 main 侧从 settings.json 的 `network` 读好注入（本模块不读盘，与 workspaces 同一口径）。
   */
  network?: () => NetworkSettings
  /**
   * round 64：技能来源（**现读**：内置技能目录 + 已装插件复制进来的技能目录）。
   * 由 main 侧算好注入（本模块不 import electron，打包态的内置目录要看 process.resourcesPath）；
   * 缺省 = 没有技能（指令里不出现技能清单，use_skill 回"暂无可用技能"）。
   */
  skillSources?: () => readonly SkillSource[]
  /**
   * round 68：**本部署事实**（`render_ppt` 能不能真渲染页图 + 当前模型能不能读图），现读取值函数。
   * `use_skill` 加载技能时把它拼在全文末尾（见 skills/runtime.ts）：技能正文只写"知识"，
   * "这台机器现在有什么"由这里注入 —— 一份手册适配无数台机器。
   *
   * 缺省 = 没有（加载技能时那一段如实写"未知"，不编造）。
   * 取值函数由 main 侧算好（路径/探测都在那边，本模块不 import electron、不碰探测）。
   */
  skillRuntimeFacts?: SkillRuntimeFactsSource
  /**
   * round 65：让模型自己落地技能 / MCP 的运行时（现读）。同样由 main 侧注入（写的是应用数据目录
   * 与 settings.json）；缺省 = 没有（四个作者工具回人话，不抛错）。
   */
  authoring?: () => AuthoringRuntime | null
}): Promise<KyclawMastra> {
  const { Mastra: MastraClass } = await import('@mastra/core/mastra')
  const { LibSQLStore: LibSQLStoreClass, LibSQLVector: LibSQLVectorClass } =
    await import('@mastra/libsql')
  const { Memory: MemoryClass } = await import('@mastra/memory')
  const { handleChatStream } = await import('@mastra/ai-sdk')
  const { registerApiRoute } = await import('@mastra/core/server')
  const { createUIMessageStreamResponse } = await import('ai')

  /**
   * round 68：本部署事实装进技能侧的注册表 —— `use_skill` 的构造在 agents/kyclaw.ts，
   * 它的参数表这次不动（那份文件由另一处改动持有），注册表是"不碰它也接得上"的那条通道：
   * 装配时装一次，`use_skill` 每次加载技能**现读**（换模型、装/卸 PowerPoint 下一轮就反映出来）。
   * 没注入 = 不装（加载技能时那一段如实写"未知"）。见 skills/runtime.ts 头注。
   */
  if (options.skillRuntimeFacts !== undefined) {
    setSkillRuntimeFactsSource(options.skillRuntimeFacts)
  }

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
        // working memory（T14）：**thread 作用域**（round 58 从 resource 改过来）= 每个会话一份，
        // 记忆页读写的与助手每轮系统提示里看到的是**当前会话**那一份（库里落在该线程的
        // metadata.workingMemory 上，见 @mastra/memory 的 getWorkingMemory / updateWorkingMemory）
        workingMemory: {
          enabled: true,
          scope: 'thread',
          template: KYCLAW_WORKING_MEMORY_TEMPLATE
        },
        // 语义召回（round 28）：**thread 作用域 = 只召回本会话的消息**（round 58 从 resource 改过来）。
        // 实测该版本（@mastra/memory 1.36.0 + @mastra/libsql）：两档都受支持，查询过滤
        // resource 档用 `{ resource_id }`、thread 档用 `{ thread_id }`
        // （见其 SemanticRecall.performSemanticSearch）；工作记忆同理 thread 档写线程 metadata。
        ...(embedder === undefined
          ? {}
          : {
              semanticRecall: {
                topK: SEMANTIC_RECALL_TOP_K,
                messageRange: SEMANTIC_RECALL_MESSAGE_RANGE,
                scope: 'thread' as const
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
  // round 87：请求快照（系统指令 / 工具表 / 消息清单）同库，供轨迹页的系统 / 上下文 / 失败行（用户反馈 015）
  const requestSnapshots = createRequestSnapshotStore(usageSqlClient(storage))
  await requestSnapshots.ensureTable()
  const recordRequest = createRequestSnapshotRecorder({ store: requestSnapshots })
  /**
   * 失败那次请求的记账（用户反馈 015）：`onFinish` 在 provider 报错时**不触发**（实测），所以失败
   * 由**三个模型调用入口**各自的 UI 消息流观察（chat 路由 / ask-user 续跑 / Plan 续跑）——
   * 每一处都把自己那一轮**真实的** threadId / runId 交进来（认不出就 null，不编）。
   */
  const recordRequestFailure = createRequestFailureRecorder({ store: requestSnapshots })
  const noteFailure =
    (threadId: string | null, runId: string | null) =>
    (errorText: string): void => {
      void recordRequestFailure({ threadId, runId, error: errorText })
    }
  // 会话↔项目映射（T18）同库同寿命：表在这里建好；内存镜像是工具同步取根的来源
  const sessionProjects = createSessionProjectStore(storage)
  // round 66：会话↔PPT 模板映射同库同寿命（模板选择是会话级的，不再落全局设置）
  const sessionPptTemplates = createSessionPptTemplateStore(storage)
  // round 76：会话↔PPT 源结构同库同寿命（create_ppt 记、edit_ppt 读改；表在第一次读写时建）
  const sessionPptSources = createSessionPptSourceStore(storage)
  // 会话↔Word 源结构同库同寿命（create_docx 记、edit_docx 读改；表在第一次读写时建）
  const sessionDocxSources = createSessionDocxSourceStore(storage)
  // 上下文压缩（round 19）：记录表同库；摘要服务用当前模型解析器，记账并进 usage
  const compactionStore = createCompactionStore(compactionSqlClient(storage))
  await compactionStore.ensureTable()
  const compaction = createCompactionService({
    memory,
    store: compactionStore,
    resolveModel: options.resolveModel,
    usage,
    // round 59：压缩前读一次该会话的 token 读数（与 /api/usage/context 同一口径，见 usage.ts）
    usageOf: (threadId) => threadTokenReadout(usage, threadId)
  })
  // 追踪（T17）：默认关——没配齐（或建不起来）就没有 observability，Mastra 自己走 no-op
  const observability = await langfuseObservabilityQuietly(options.langfuse?.() ?? null)
  const rulesProcessor =
    options.rules === undefined
      ? null
      : createRulesProcessor({
          sessionProjects,
          projects: options.projects ?? (() => []),
          ...options.rules
        })
  const tasks = createSessionTaskStore(storage)
  await tasks.ensureTable()
  const tasksContext = createTasksContext()
  const plans = createSessionPlanStore(storage)
  await plans.ensureTable()
  // PB-039：每会话一个 goal（单行 + revision CAS）；activation 在该 store 的进程内 Map 里
  const goals = createSessionGoalStore(storage)
  await goals.ensureTable()
  const planRuntime = createPlanRuntime({
    store: plans,
    coordinator: {
      assertThread: (threadId) => interactions.assertThread(threadId),
      listSuspended: async (threadId) =>
        (await interactions.listSuspended(threadId))
          .filter((target) => target.toolName === 'submit_plan' && !target.requiresApproval)
          .map((target): PlanSuspension => ({
            ...target,
            toolName: 'submit_plan',
            suspendPayload: planRefSchema.parse(target.suspendPayload)
          })),
      claimSuspend: async (threadId, runId, toolCallId, toolName) => {
        const lease = await interactions.claimSuspend(threadId, runId, toolCallId, toolName)
        return {
          ...lease,
          target: {
            ...lease.target,
            toolName: 'submit_plan',
            suspendPayload: planRefSchema.parse(lease.target.suspendPayload)
          }
        }
      },
      withThreadChange: (threadId, operation) => interactions.withThreadChange(threadId, operation),
      withIdleThread: (threadId, operation) => interactions.withIdleThread(threadId, operation)
    },
    resume: async (input) => {
      const { toAISdkStream } = await import('@mastra/ai-sdk')
      const request = tasksContext.prepareRequest(input.threadId, input.runId)
      planRuntime.prepareRequest(input.threadId, input.runId, request.requestContext)
      const guard = planRuntime.guardFor(request.requestContext)
      const result = await agent.resumeStream(input.resumeData, {
        ...chatOptions,
        ...request,
        hooks: guard.hooks,
        inputProcessors: [...chatOptions.inputProcessors, guard.processor],
        toolCallId: input.toolCallId,
        memory: { thread: input.threadId, resource: 'local-user' }
      })
      // Plan 续跑也是"一次真实的模型请求"：失败同样落在同一条账上（thread / run 都是真的）
      return tapStreamFailures(
        toAISdkStream(result, { from: 'agent', version: 'v7', sendReasoning: true }),
        noteFailure(input.threadId, input.runId)
      )
    }
  })
  const recordUsage = createUsageRecorder({ store: usage })
  const chatOptions = {
    maxSteps: KYCLAW_MAX_STEPS,
    onFinish: async (event: Parameters<typeof recordUsage>[0]) => {
      await recordUsage(event)
      // 请求快照与用量并排落，但它是**旁路**：自己兜住异常（写失败只记日志），不把这一轮打成失败
      await recordRequest(event)
      const threadId = event.response?.dbMessages?.find(
        (message) => typeof message.threadId === 'string'
      )?.threadId
      if (typeof threadId !== 'string') return
      await memory.settled()
      const state = await plans.find(threadId)
      if (
        state?.mode === 'executing' &&
        state.approval &&
        event.runId === state.approval.runId &&
        !(await interactions.listSuspended(threadId)).length
      ) {
        await plans.finish(threadId, planRefOf(state), state.approval.runId)
      }
    },
    // round 88：原先挂在这个列表末尾的 system-first processor 已删 —— 它读的
    // `messageList.get.all.db()` 里没有 system（MessageList 把 system 放自己的桶里），改不到 wire。
    // system-first 现在在模型边界做，见 model.ts 的 mergeSystemFirstPrompt / withSystemFirstPrompt。
    inputProcessors: [
      createCompactionProcessor(compactionStore),
      ...(rulesProcessor === null ? [] : [rulesProcessor]),
      tasksContext.processor
    ]
  }
  const agent = await createKyclawAgent(options.resolveModel, memory, {
    tasks,
    tasksContext,
    planRuntime,
    // PB-039：goal 三件套读写同一份权威状态（与 /api/goal 是同一个 store 实例）
    goals,
    workspaces: options.workspaces,
    defaultWorkspace: options.defaultWorkspace,
    projects: options.projects,
    projectOf: (threadId) => sessionProjects.get(threadId),
    permissionRules: options.permissionRules,
    mcpServers: options.mcpServers,
    mcpTools: options.mcpTools,
    // 模块 4：产出物的 PDF 钩子（缺省没有；有 electron 的那一侧才给得出真实现）
    printPdf: options.printPdf,
    // round 45：联网搜索（web_search + fetch 阅读模式共用这一份运行时配置）
    webSearch: options.webSearch,
    searchDeps: options.searchDeps,
    // round 73：fetch 出站边界的白名单（现读设置；撤掉就恢复拦截）
    network: options.network,
    // round 66：**这个会话**固定的 PPT 模板（create_ppt 的缺省模板；现读内存镜像，同步）
    pptTemplate: (threadId) => sessionPptTemplates.get(threadId) ?? '',
    // round 76：会话级 PPT 源结构（create_ppt 落盘时记、edit_ppt 读回来改；直连库，异步）
    pptSources: sessionPptSources,
    // 会话级 Word 源结构（create_docx 落盘时记、edit_docx 读回来改；同一路数）
    docxSources: sessionDocxSources,
    // round 64：技能来源（现读）——指令里的技能清单 + use_skill 读全文共用这一份
    ...(options.skillSources === undefined ? {} : { skillSources: options.skillSources }),
    // round 65：作者能力（现读）——create_skill / add_mcp_server 等落盘走这一份运行时
    ...(options.authoring === undefined ? {} : { authoring: options.authoring })
  })
  const interactions = new AskUserRuntime(agent, memory, storage)
  const prepareThread = async (threadId: string): Promise<void> => {
    const existing = await memory.getThreadById({ threadId })
    if (existing && existing.resourceId !== 'local-user') throw new Error('wrong-thread-resource')
    if (!existing)
      await memory.createThread({ threadId, resourceId: 'local-user', saveThread: true })
    await plans.initialize(threadId)
  }
  const askUserRoutes = await createAskUserRoutes({
    memory,
    storage,
    runtime: interactions,
    prepareThread,
    resume: async (input) => {
      const { toAISdkStream } = await import('@mastra/ai-sdk')
      const request = tasksContext.prepareRequest(input.threadId, input.runId)
      planRuntime.prepareRequest(input.threadId, input.runId, request.requestContext)
      const guard = planRuntime.guardFor(request.requestContext)
      const result = await agent.resumeStream(input.answer, {
        ...chatOptions,
        ...request,
        hooks: guard.hooks,
        inputProcessors: [...chatOptions.inputProcessors, guard.processor],
        toolCallId: input.toolCallId,
        memory: { thread: input.threadId, resource: 'local-user' }
      })
      // ask-user 续跑（回答卡片之后那一次模型请求）：失败记账同上，thread / run 都是挂起时那一轮
      return tapStreamFailures(
        toAISdkStream(result, { from: 'agent', version: 'v7', sendReasoning: true }),
        noteFailure(input.threadId, input.runId)
      )
    }
  })
  const mastra = new MastraClass({
    agents: { [KYCLAW_AGENT_ID]: agent },
    storage,
    ...(observability === null ? {} : { observability }),
    server: {
      apiRoutes: [
        ...askUserRoutes.routes,
        ...(await createPlanRoutes(planRuntime)),
        {
          ...registerApiRoute(CHAT_ROUTE_PATH, {
            method: 'POST',
            handler: async (context) => {
              const body =
                askUserRoutes.preparedBody(context.req.raw) ??
                ((await context.req.json()) as Record<string, unknown>)
              const memoryScope = body.memory as { thread: string }
              const resumedRunId = askUserRoutes.resumedRunId(context.req.raw)
              const params = prepareTaskChatParams(
                body,
                tasksContext,
                memoryScope.thread,
                resumedRunId
              )
              // PB-039 阶段③：goal round 准入 —— 只有 driver 发的那一轮（metadata.goalRound）才计数；
              // 陈旧 revision / 非 active / 轮数用尽都在这里 409（前端不重发同一轮，重新 GET 再判）。
              const goalRound = goalRoundFromChatBody(body)
              if (goalRound !== null) {
                try {
                  await goals.admitRound(memoryScope.thread, goalRound)
                } catch (error) {
                  if (error instanceof SessionGoalError)
                    return context.json({ error: error.code, message: error.message }, error.status)
                  throw error
                }
                // 工具侧（get_goal/create_goal/update_goal）靠这条标记判断来源是 goal round 还是人类轮
                params.requestContext?.set(GOAL_ROUND_CONTEXT_KEY, goalRound)
              }
              const request = planRuntime.prepareRequest(
                memoryScope.thread,
                params.runId,
                params.requestContext
              )
              const guard = planRuntime.guardFor(request.requestContext)
              const stream = await handleChatStream({
                mastra: context.get('mastra'),
                agentId: KYCLAW_AGENT_ID,
                version: CHAT_PROTOCOL_VERSION,
                sendReasoning: true,
                defaultOptions: {
                  ...chatOptions,
                  hooks: guard.hooks,
                  inputProcessors: [...chatOptions.inputProcessors, guard.processor]
                },
                params: { ...params, ...request, abortSignal: context.req.raw.signal }
              })
              return createUIMessageStreamResponse({
                // 这一轮的 runId：续跑（审批 / ask_user）用挂起时那一轮的 runId；新的一轮用
                // `prepareTaskChatParams` 刚产出的那个（任务处理链按它校验每一步）
                stream: tapStreamFailures(
                  stream,
                  noteFailure(memoryScope.thread, resumedRunId ?? preparedRunId(params))
                )
              })
            }
          }),
          middleware: askUserRoutes.middleware
        }
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
    tasks,
    tasksContext,
    plans,
    planRuntime,
    goals,
    mastra,
    storage,
    memory,
    usage,
    requestSnapshots,
    sessionProjects,
    sessionPptTemplates,
    sessionPptSources,
    sessionDocxSources,
    compaction,
    telemetry: { langfuse: observability !== null },
    rules: { processorRegistered: rulesProcessor !== null },
    recall
  }
}




