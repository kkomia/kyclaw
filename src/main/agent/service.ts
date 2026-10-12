/**
 * 内嵌 agent 服务（链路原型①）：Mastra（@mastra/hono 适配器）挂在 Node http 上，只监听 127.0.0.1。
 *
 * 边界就两条：
 *   1. 端口随机（缺省让 OS 分配空闲端口；显式给了端口但被占用就换，≤5 次）——
 *      固定端口迟早和用户机器上别的东西撞车；
 *   2. Bearer token（每次启动新生成、经 IPC 只交给本应用的渲染端）——缺/错一律 401。
 * CORS 白名单只是让渲染端读得到响应，真正的闸门是 token。
 *
 * 纯 Node 模块：**顶层不 import electron**（dataDir 由调用方注入——生产传 app.getPath('userData')，
 * 测试传临时目录），所以整条链路能在 vitest（node 环境）里真跑起来。
 * Mastra 系依赖 ESM-only、主进程产物 CJS：运行时依赖一律动态 import()。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createKyclawMastra } from '../../mastra/index'
import { createMcpRouter } from '../../mastra/routes/mcp'
import { createMemoryRouter } from '../../mastra/routes/memory'
import { createProjectsRouter } from '../../mastra/routes/projects'
import { createThreadsRouter } from '../../mastra/routes/threads'
import { createUsageRouter } from '../../mastra/routes/usage'
import { KYCLAW_AGENT_ID } from '../../mastra/agents/kyclaw'
import { resolveModel, type KyclawModel } from '../../mastra/model'
import type { ModelResolver } from '../../mastra/agents/kyclaw'
import type { LangfuseExportConfig } from '../../mastra/telemetry'
import { readSettings, settingsPath, updateSettings } from '../settings'
import { McpLifecycle } from '../mcp/lifecycle'
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'
import type { Project } from '../../shared/projects'
import type {
  AppSettings,
  McpServerConfig,
  PermissionRule,
  SemanticRecallSettings,
  Workspace
} from '../../shared/settings'
import type { AgentEndpoint } from '../../shared/ipc'
import type { LibSQLStore } from '@mastra/libsql'
import type { Mastra } from '@mastra/core/mastra'
import type { MastraMemory } from '@mastra/core/memory'
import type { MastraEmbeddingModel } from '@mastra/core/vector'
import type { LocalEmbeddingEndpoint, RecallRuntime } from '../../mastra/embedding'
import type { PdfPrinter } from '../../mastra/tools/artifacts'
import type { WebSearchRuntime } from '../../shared/search'

const HOST = '127.0.0.1'

/** 线程 API 的挂载前缀（路由本体在 src/mastra/routes/threads.ts） */
export const THREADS_ROUTE_PREFIX = '/api/threads'

/** MCP 管理 API 的挂载前缀（路由本体在 src/mastra/routes/mcp.ts） */
export const MCP_ROUTE_PREFIX = '/api/mcp'

/** 记忆 API 的挂载前缀（T14；working memory 的查看/编辑/清空） */
export const MEMORY_ROUTE_PREFIX = '/api/memory'

/** 用量 API 的挂载前缀（T14；token 与花费的窗口统计） */
export const USAGE_ROUTE_PREFIX = '/api/usage'

/** 项目映射 API 的挂载前缀（T18；会话↔项目映射的读/写） */
export const PROJECTS_ROUTE_PREFIX = '/api/projects'

/** 端口尝试上限（显式端口被占时换端口重试的次数） */
const DEFAULT_PORT_ATTEMPTS = 5

/** token 熵：32 字节随机 → base64url 43 字符 */
const TOKEN_BYTES = 32

/**
 * CORS 放行名单：dev 的 vite（5173/5174）与生产 file:// 的 'null' origin。
 * 名单外一律不回 ACAO 头（浏览器自己会挡），但 token 才是真闸门——curl 带对 token 一样能通。
 */
const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:5174', 'null']

export interface AgentServerOptions {
  /** 应用数据目录：libsql 库文件落这里（生产 = userData），settings.json 也从这里读 provider */
  dataDir: string
  /** 注入模型（测试用，整场不变） */
  model?: KyclawModel
  /**
   * 每轮对话重新解析模型（**生产用**：main/index.ts 注入"读 settings + secrets"的实现，
   * 于是用户配好 provider/密钥后不用重启，下一轮就是真模型）。
   */
  resolveModel?: ModelResolver
  /**
   * 授权工作区（文件工具的权限边界）：**现读**的取值函数，用户中途加工作区/切模式下一轮就生效。
   * 缺省 = 从 dataDir/settings.json 的 workspaces 读（与设置页写入的是同一份）。
   */
  workspaces?: () => readonly Workspace[]
  /**
   * 默认工作区（T18）：**现读**；缺省 = 从 dataDir/settings.json 读。
   * 未指定项目的会话落在它**下面的会话子目录**里（round 55，规则见 shared/session-dir.ts）。
   */
  defaultWorkspace?: () => string | null
  /** 项目清单（T18）：**现读**；缺省 = 从 dataDir/settings.json 读 */
  projects?: () => readonly Project[]
  /**
   * "永久允许"规则（T13）：同样是**现读**的取值函数（审批卡里点"永久允许"落进 settings.json，
   * 下一轮工具调用就不再弹审批）。缺省 = 从 dataDir/settings.json 的 permissions.rules 读。
   */
  permissionRules?: () => readonly PermissionRule[]
  /**
   * MCP server 设置（T12）：现读的取值函数（设置页的 /api/mcp/servers 写的就是这份）。
   * 缺省 = 从 dataDir/settings.json 的 mcpServers 读。
   */
  mcpServers?: () => readonly McpServerConfig[]
  /**
   * T17：Langfuse 追踪配置（现读）。生产由 main/index.ts 注入"读设置 + safeStorage 密钥"的实现；
   * 缺省 = null（不导出）——本模块刻意不 import electron，读不到 safeStorage 里的密钥。
   */
  langfuse?: () => LangfuseExportConfig | null
  /**
   * round 28：语义召回设置（现读；**装配只在启动时做一次**，改设置要重启应用才生效）。
   * 缺省 = 从 dataDir/settings.json 的 semanticRecall 读（与设置页写的是同一份）。
   */
  semanticRecall?: () => SemanticRecallSettings
  /**
   * round 28：嵌入服务的 API Key（safeStorage 明文；缺省 = null——本模块不 import electron）。
   * 生产由 main/index.ts 注入"读 secrets.json"的实现。
   */
  embeddingKey?: () => string | null
  /**
   * round 28 模块 3B：本机引擎的端点（缺省 = 没接上）。生产由 main/index.ts 注入
   * `localModelService.embeddingEndpoint`（它会确保引擎起来）；测试可以注入假端点。
   */
  localEmbedding?: () => Promise<LocalEmbeddingEndpoint | null>
  /** round 28：测试用——直接给一个 embedder（跳过设置解析与探测） */
  recallEmbedder?: MastraEmbeddingModel<string>
  /**
   * 模块 4：PDF 打印钩子（HTML → PDF 字节）。**缺省 = 没有**（create_pdf 报"环境不支持"）。
   * 生产由 main/index.ts 注入 Electron printToPDF 的实现（本模块刻意不 import electron）。
   */
  printPdf?: PdfPrinter
  /**
   * round 45：联网搜索的运行时配置（现读：设置 + 三个可选 Key）。
   * 缺省 = 从 dataDir/settings.json 读设置、没有 Key（密钥在 safeStorage 里，本模块不 import electron；
   * 生产由 main/index.ts 注入"读设置 + 解密钥"的实现）。
   */
  webSearch?: () => WebSearchRuntime
  /** 起始端口；缺省交给 OS 分配（随机空闲端口） */
  port?: number
  /** 端口尝试上限（默认 5，至少 1） */
  attempts?: number
}

export interface AgentServerHandle extends AgentEndpoint {
  port: number
  /** T17：本次装配的追踪状态（设置页「追踪」栏用它说"已开启 / 重启后开启"） */
  telemetry: { langfuse: boolean }
  /**
   * round 28：本次装配的语义召回状态（设置页/记忆页用它说"已开启 / 重启后开启 / 准备中"）。
   * 现读（本地模型的后台准备会改它）；`settled()` 等后台活干完（测试与收尾用，不抛）。
   */
  recall: RecallRuntime
  /**
   * round 15：会话 → 项目 id（session_projects 内存镜像，同步）。
   * `workspace:list-files` 借它把 threadId 解析成会话根（与文件工具同口径）；
   * 没有映射（或镜像没载入）回 null —— 上游按"无项目"回落。
   */
  projectIdOf(threadId: string): string | null
  /** 断开监听、收掉 Mastra 与 storage；重复调用是空操作 */
  stop(): Promise<void>
}

/** serve() 拿到的 http server 类型（@hono/node-server 的 ServerType） */
type NodeServer = Awaited<ReturnType<typeof import('@hono/node-server').serve>>

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  )
}

/** 恒定时间比较（长度不同直接 false，不进 timingSafeEqual） */
function tokenMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) return false
  const given = Buffer.from(header.slice(prefix.length))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** 起一次监听；成功即返回实际端口，失败把错误原样抛出（调用方决定要不要换端口重试） */
async function listenOn(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number
): Promise<{ server: NodeServer; port: number }> {
  const { serve } = await import('@hono/node-server')
  const server = serve({ fetch, port, hostname: HOST })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
  } catch (error) {
    server.close()
    throw error
  }

  // 监听期的错误监听器换成运行期日志：没人接的 'error' 事件会直接把进程带崩
  server.removeAllListeners('error')
  server.on('error', (error) => {
    console.error('[kyclaw] agent 服务运行期错误', error)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('agent 服务启动失败：拿不到监听端口')
  }
  return { server, port: address.port }
}

/**
 * 静默收尾：收不掉只记日志（不能盖住调用方真正关心的那个错误）。
 * storage 是句柄的真正持有者 —— 无论 Mastra 收尾成不成功都要关（try/finally，T6 随修）；
 * memory 给了就先等它把后台活干完（T9：标题落库之类的写入不能和 storage.close 赛跑）。
 * 导出只为一件事：失败路径没法用真句柄造（shutdown 抛错），单测拿假件打这条顺序。
 */
export async function teardownQuietly(
  mastra: Mastra,
  storage: LibSQLStore,
  memory?: Pick<MastraMemory, 'settled'>
): Promise<void> {
  try {
    await mastra.shutdown()
  } catch (error) {
    console.warn('[kyclaw] agent 服务收尾失败（Mastra）', error)
  } finally {
    if (memory !== undefined) {
      try {
        await memory.settled()
      } catch (error) {
        console.warn('[kyclaw] agent 服务收尾失败（memory）', error)
      }
    }
    try {
      await storage.close()
    } catch (error) {
      console.warn('[kyclaw] agent 服务收尾失败（storage）', error)
    }
  }
}

/**
 * 缺省模型来源：按 dataDir 下的 settings.providers 解析（没配 provider → 内置 mock）。
 *
 * 这里没有密钥来源（密钥在 electron 的 safeStorage 里，本模块刻意不 import electron），
 * 所以**配了 provider 时会以"配置不完整：缺 API 密钥"失败**——生产路径由 main/index.ts
 * 注入带 secrets 的 resolveModel；故意的失败好过静默回落 mock（T8 裁决）。
 */
function settingsModelResolver(dataDir: string): ModelResolver {
  return async () => {
    const providers = readSettings(settingsPath(dataDir)).providers
    return (await resolveModel(providers, () => null)).model
  }
}

export async function startAgentServer(options: AgentServerOptions): Promise<AgentServerHandle> {
  const [{ Hono }, { cors }, { MastraServer }] = await Promise.all([
    import('hono'),
    import('hono/cors'),
    import('@mastra/hono')
  ])

  const staticModel = options.model
  const resolveModelFor: ModelResolver =
    options.resolveModel ??
    (staticModel !== undefined ? async () => staticModel : settingsModelResolver(options.dataDir))
  // 工具权限边界走同一份 settings.json（设置页的 workspace:* 通道写的也是它）；
  // "永久允许"规则（T13）同样现读，审批卡点完下一轮就生效；默认工作区与项目清单（T18）同理 ——
  // 用户在侧栏建项目 / 指认默认工作区，下一个会话/下一轮工具调用就反映出来
  const settingsFor = (): AppSettings => readSettings(settingsPath(options.dataDir))
  const workspacesFor = options.workspaces ?? (() => settingsFor().workspaces)
  const defaultWorkspaceFor = options.defaultWorkspace ?? (() => settingsFor().defaultWorkspace)
  const projectsFor = options.projects ?? (() => settingsFor().projects)
  const permissionRulesFor = options.permissionRules ?? (() => settingsFor().permissions.rules)
  const mcpServersFor = options.mcpServers ?? (() => settingsFor().mcpServers)
  // 追踪（T17）：缺省不导出（密钥在 safeStorage 里，本模块读不到；生产由 main/index.ts 注入）
  const langfuseFor = options.langfuse ?? ((): LangfuseExportConfig | null => null)
  // 语义召回（round 28）：设置现读（装配只做一次，改设置要重启生效）；密钥同样在 safeStorage 里
  const semanticRecallFor = options.semanticRecall ?? (() => settingsFor().semanticRecall)
  const embeddingKeyFor = options.embeddingKey ?? ((): string | null => null)
  // round 45：联网搜索设置现读；Key 在 safeStorage 里（本模块读不到 → 缺省没有，走免费档）
  const webSearchFor =
    options.webSearch ??
    ((): WebSearchRuntime => ({
      settings: settingsFor().webSearch,
      searchKey: null,
      readerKey: null
    }))
  // MCP 连接的生命周期：stdio 子进程的持有者，随 agent 服务起停（stop 见 handle.stop）
  const mcpLifecycle = new McpLifecycle({ servers: mcpServersFor })
  const { mastra, storage, memory, usage, sessionProjects, compaction, telemetry, recall } =
    await createKyclawMastra({
      dataDir: options.dataDir,
      resolveModel: resolveModelFor,
      workspaces: workspacesFor,
      defaultWorkspace: defaultWorkspaceFor,
      projects: projectsFor,
      permissionRules: permissionRulesFor,
      mcpServers: mcpServersFor,
      mcpTools: (gate) => mcpLifecycle.tools(gate),
      langfuse: langfuseFor,
      semanticRecall: semanticRecallFor,
      embeddingKey: embeddingKeyFor,
      ...(options.localEmbedding === undefined ? {} : { localEmbedding: options.localEmbedding }),
      ...(options.recallEmbedder === undefined ? {} : { recallEmbedder: options.recallEmbedder }),
      // 模块 4：产出物的 PDF 钩子（缺省没有 —— 无窗口环境/测试里 create_pdf 会明确报不支持）
      ...(options.printPdf === undefined ? {} : { printPdf: options.printPdf }),
      // round 45：联网搜索（web_search + fetch 阅读模式共用这一份运行时配置）
      webSearch: webSearchFor
    })

  // 会话↔项目映射的镜像载入（重启后映射要回来）。载入失败不挡服务：这些会话按"没有项目"跑
  // （退化为默认工作区），下一轮写入/重启还会再试 —— 一条副线不该让整个对话起不来。
  await sessionProjects.load().catch((error: unknown) => {
    console.warn('[kyclaw] 会话↔项目映射载入失败（这些会话按无项目处理，不影响对话）', error)
  })

  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  const app = new Hono()
  app.use(
    '*',
    cors({
      origin: ALLOWED_ORIGINS,
      // 线程 API 用到了 GET/DELETE/PATCH，chat 是 POST，MCP 管理 API 是 GET/PUT/POST（T12）
      allowMethods: ['POST', 'GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600
    })
  )
  // 预检（OPTIONS）没有 Authorization，由上面的 cors 直接收口；其余一律先过 token
  app.use('*', async (context, next) => {
    if (!tokenMatches(context.req.header('authorization'), token)) {
      return context.json({ error: 'unauthorized' }, 401)
    }
    return next()
  })

  const mastraServer = new MastraServer({ app, mastra })
  await mastraServer.init()

  // 线程 API 挂同一份服务、走同一道 token 闸门（在闸门之后注册，所以它同样被挡在里面）
  app.route(
    THREADS_ROUTE_PREFIX,
    createThreadsRouter({
      memory,
      resolveModel: resolveModelFor,
      // 删线程前先掐掉在跑的那一轮（agent 的线程级取消），否则"取消 → 半截回复落库"
      // 会把刚删掉的线程写回来（T9 实测到的复活）
      abortThreadRun: (threadId) => {
        const agent = mastra.getAgentById(KYCLAW_AGENT_ID)
        agent?.abortThreadStream({ threadId, resourceId: LOCAL_USER_RESOURCE_ID })
      },
      // T18：会话没了，它的项目映射也一起摘掉（别在映射表里留一条指向不存在会话的行）。
      // 尽力而为：清理失败只记日志，不影响删除本身。
      onThreadDeleted: (threadId) => {
        void sessionProjects.clear(threadId).catch((error: unknown) => {
          console.warn('[kyclaw] 删除会话后清理项目映射失败（不影响删除本身）', error)
        })
        // round 19：压缩记录同理（它的 thread_id 指向已不存在的会话）
        void compaction.clear(threadId).catch((error: unknown) => {
          console.warn('[kyclaw] 删除会话后清理压缩记录失败（不影响删除本身）', error)
        })
      },
      // round 19：上下文压缩（记录读 + 摘要服务）；POST 失败在路由层转人话
      compaction: {
        compact: (threadId, keep) => compaction.compact(threadId, keep),
        of: (threadId) => compaction.current(threadId)
      }
    })
  )

  // 项目映射 API（T18）：会话↔项目映射的读（侧栏按项目分组）/ 写（新建会话归属项目）
  app.route(PROJECTS_ROUTE_PREFIX, createProjectsRouter({ store: sessionProjects }))

  // MCP 管理 API（T12）：服务端是配置的权威，写盘走 updateSettings（同一条校验路）；
  // 写完立即让 lifecycle 对齐连接（启停/删除当场生效，子进程随之下线/上线）
  app.route(
    MCP_ROUTE_PREFIX,
    createMcpRouter({
      readServers: mcpServersFor,
      saveServers: (servers) =>
        updateSettings(settingsPath(options.dataDir), { mcpServers: servers }).mcpServers,
      onServersChanged: () => {
        // 对齐失败必须在这里落地：写盘已经成功，半个 URL / 起不来的 server 只该影响"这条连接"，
        // 不能让 rejection 冒到主进程（Electron 未处理 rejection 会弹错，而 UI 还显示保存成功）
        mcpLifecycle.refresh().catch((error) => {
          console.warn('[kyclaw] MCP 连接对齐失败（下一轮对话会再对齐）', error)
        })
      }
    })
  )

  // 记忆 API（T14）：working memory 的查看/编辑/清空 + 语义召回的运行状态（round 28）
  app.route(MEMORY_ROUTE_PREFIX, createMemoryRouter({ memory, recall }))

  // 用量 API（T14）：窗口统计；表在 createKyclawMastra 里已建好，这里共用同一个 store
  app.route(USAGE_ROUTE_PREFIX, createUsageRouter({ store: usage }))

  const attempts = Math.max(1, options.attempts ?? DEFAULT_PORT_ATTEMPTS)
  let server: NodeServer | undefined
  let port = 0
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // 第一次用调用方指定的端口（测试注入"被占用的端口"就走这条），之后换随机空闲端口
    const candidate = attempt === 1 && options.port !== undefined ? options.port : 0
    try {
      const listening = await listenOn(app.fetch, candidate)
      server = listening.server
      port = listening.port
      break
    } catch (error) {
      lastError = error
      if (!isAddrInUse(error)) throw error
    }
  }

  if (!server) {
    // 起不来就不留半个服务：把已经建好的 Mastra/storage/连接收掉，再带着原因抛出去
    await mcpLifecycle.stop()
    await teardownQuietly(mastra, storage, memory)
    throw new Error(`agent 服务启动失败：${attempts} 次都没能监听 ${HOST} 的端口`, {
      cause: lastError
    })
  }

  // 启动预热（round 54 首字延迟修复）：把 MCP 发现挪到应用启动后的后台做——可达的 server 在
  // 用户敲字时已经就绪；不可达的在这里走完重试上限、标成暂停使用，不占任何一轮对话的等待预算。
  // refresh 自己吞错（对齐失败只记日志），不会冒未处理 rejection。
  void mcpLifecycle.refresh()

  let stopped = false
  return {
    baseUrl: `http://${HOST}:${port}`,
    token,
    port,
    telemetry,
    recall,
    projectIdOf: (threadId) => sessionProjects.get(threadId),
    stop: async () => {
      if (stopped) return
      stopped = true
      try {
        // 先强制收掉已建立的连接再关监听：SSE 是长连接，等它自然结束会把 stop() 拖死（T6 随修）
        if ('closeAllConnections' in server) server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
      } finally {
        // MCP 子进程随连接断开而下线（应用退出前收干净）；再收 Mastra / memory / storage
        await mcpLifecycle.stop()
        await teardownQuietly(mastra, storage, memory)
      }
    }
  }
}
