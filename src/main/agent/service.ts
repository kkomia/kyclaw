/**
 * 内嵌 agent 服务：本地 HTTP/SSE + Bearer token（只监听 127.0.0.1）。
 *
 * 0.2.0（PB-020）起旧 Mastra 内核装配已在 A2a 移除：chat 由 `kernelAdapter` 承接，
 * 八条旧宿主 API 由 PB-022 的 501 mount 占位；当前 flag 仍在（A2b 会把内核改成必启）。
 *
 * 边界就两条：
 *   1. 端口随机（缺省让 OS 分配空闲端口；显式给了端口但被占用就换，≤5 次）——
 *      固定端口迟早和用户机器上别的东西撞车；
 *   2. Bearer token（每次启动新生成、经 IPC 只交给本应用的渲染端）——缺/错一律 401。
 * CORS 白名单只是让渲染端读得到响应，真正的闸门是 token。
 *
 * 纯 Node 模块：**顶层不 import electron**（dataDir 由调用方注入——生产传 app.getPath('userData')，
 * 测试传临时目录），所以整条链路能在 vitest（node 环境）里真跑起来。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { KYCLAW_AGENT_ID } from '../../shared/agent-id'
import { readSettings, settingsPath } from '../settings'
import { createKernelChatHandler } from '../kernel/kernel-chat'
import { maybeStartKernelAdapter } from '../kernel/kernel-bootstrap'
import { InteractionHub, applyInteractionEvent, feedKernelEvent } from '../kernel/interaction-hub'
import { createKernelInteractionRouter } from '../kernel/kernel-interaction-route'
import { createKernelSessionOpsForAdapter } from '../kernel/kernel-session-ops'
import { createKernelUiRouter, KERNEL_UI_ROUTE_PREFIX } from '../kernel/kernel-ui-route'
import { createFeatureDisabledRouter } from '../features/feature-disabled'
import {
  createKernelThreadsRouter,
  createKernelThreadsUnavailableRouter
} from '../threads/kernel-threads'
import { createThreadCwdResolver } from '../threads/thread-cwd'
import type { Project } from '../../shared/projects'
import type { AppSettings } from '../../shared/settings'
import type { AgentEndpoint } from '../../shared/ipc'

const HOST = '127.0.0.1'

/** 线程 API 的挂载前缀（路由本体在 src/mastra/routes/threads.ts） */
export const THREADS_ROUTE_PREFIX = '/api/threads'

/** goal 命令面 API 的挂载前缀（PB-022 下架后仅保留 501 mount） */
export const GOAL_ROUTE_PREFIX = '/api/goal'

/** MCP 管理 API 的挂载前缀（路由本体在 src/mastra/routes/mcp.ts） */
export const MCP_ROUTE_PREFIX = '/api/mcp'

/** 记忆 API 的挂载前缀（T14；working memory 的查看/编辑/清空） */
export const MEMORY_ROUTE_PREFIX = '/api/memory'

/** 用量 API 的挂载前缀（T14；token 的窗口统计） */
export const USAGE_ROUTE_PREFIX = '/api/usage'

/**
 * 轨迹数据面的挂载前缀（round 87 / 用户反馈 015 + 017）：逐次模型请求的摘要与明细。
 * 与 `/api/usage` **分开**是有意的 —— 用量那条路坏了不该把轨迹原料一起带走（用户反馈 017）。
 */
export const TRAJECTORY_ROUTE_PREFIX = '/api/trajectory'

/** 项目映射 API 的挂载前缀（T18；会话↔项目映射的读/写） */
export const PROJECTS_ROUTE_PREFIX = '/api/projects'

/** 会话↔PPT 模板映射 API 的挂载前缀（round 66；模板选择的读/写） */
export const SESSION_PPT_TEMPLATES_ROUTE_PREFIX = '/api/ppt'

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
  /** 应用数据目录（生产 = userData）：settings.json 从这里读，内核 home 缺省也用它 */
  dataDir: string
  /**
   * 默认工作区（T18）：**现读**；缺省 = 从 dataDir/settings.json 读。
   * 未指定项目的会话落在它**下面的会话子目录**里（round 55，规则见 shared/session-dir.ts）。
   */
  defaultWorkspace?: () => string | null
  /** 项目清单（T18）：**现读**；缺省 = 从 dataDir/settings.json 读 */
  projects?: () => readonly Project[]
  /** 起始端口；缺省交给 OS 分配（随机空闲端口） */
  port?: number
  /** 端口尝试上限（默认 5，至少 1） */
  attempts?: number
  /**
   * PB-020 B：内核必启（没有 flag）。**生产由 main/index.ts 注入**
   * （`process.execPath` + `resources/kernel`）；测试注入本机已安装的 DSH 路径。
   *
   * ⚠️ 不要把 `DSH_TOOLS_MODE` 设成 `none`：内核 boot 会因 tools 服务缺失失败
   * （8 个插件等待 tools），B3.1a 已实测踩坑。
   */
  kernel: {
    electronExecutable: string
    /** 内核根（打包态 = process.resourcesPath/kernel；开发态 = app.getAppPath()/resources/kernel） */
    asarPath: string
    /** 内核 home（生产 = userData/dsh-home；缺省 adapter 兜底 appDataDir/dsh-kernel-home） */
    dshHome?: string
    /** 内核启动日志落点（生产 = userData/logs/kernel.log） */
    logFile?: string
    extraEnv?: Record<string, string>
  }
}

export interface AgentServerHandle extends AgentEndpoint {
  port: number
  /** 本次装配的追踪状态（0.2.0 内核路径没有 Langfuse 导出，恒 false；设置页按这个显示） */
  telemetry: { langfuse: boolean }
  rules: { processorRegistered: boolean }
  /**
   * 会话 → 项目 id（R3：内核 session cwd → projects 反查，同步）。
   * `workspace:list-files` 借它把 threadId 解析成会话根（与文件工具同口径）；
   * 拿不到（未 list 过/刚启动）回 null —— 上游按「项目映射暂不可用」处理，不回落默认工作区。
   */
  projectIdOf(threadId: string): string | null
  /** 断开监听、收掉内核子进程；重复调用是空操作 */
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

export async function startAgentServer(options: AgentServerOptions): Promise<AgentServerHandle> {
  const [{ Hono }, { cors }] = await Promise.all([import('hono'), import('hono/cors')])

  // 工具权限边界走同一份 settings.json（设置页的 workspace:* 通道写的也是它）；
  // 默认工作区与项目清单（T18）同理 —— 用户在侧栏建项目 / 指认默认工作区，下一轮就反映出来。
  const settingsFor = (): AppSettings => readSettings(settingsPath(options.dataDir))
  const defaultWorkspaceFor = options.defaultWorkspace ?? (() => settingsFor().defaultWorkspace)
  const projectsFor = options.projects ?? (() => settingsFor().projects)

  // PB-020 A2a（R3）：thread → project 的唯一来源 = 内核 session 的 cwd 反查 projects。
  // cwdOf 拿不到（未 list 过 / 刚启动 / 内核未起）→ null；调用点按「项目映射暂不可用」处理，
  // 绝不回落到 defaultWorkspace（Lead 红线）。用 mutable holder 避免 adapter 初始化期 TDZ。
  // eslint-disable-next-line prefer-const -- adapter 建好后（下面 await）才回填
  let kernelCwdOf: ((threadId: string) => string | undefined) | undefined
  const projectIdOf = (threadId: string): string | null => {
    const cwd = kernelCwdOf?.(threadId)
    if (cwd === undefined || cwd === '') return null
    const project = projectsFor().find((item) => {
      const rel = relative(item.path, cwd)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
    return project?.id ?? null
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  /**
   * PB-024 R3：cwd 的唯一权威是 thread/workspace，不是 adapter.appDataDir。
   * PB-019：解析器抽成 `threads/thread-cwd.ts`（不依赖旧 Mastra store）；
   * PB-020 A2a：数据源换成上面的 `projectIdOf`（内核 cwd 反查），同一个闭包同时喂 adapter 与 threads router。
   */
  const resolveThreadCwd = createThreadCwdResolver({
    projectIdOf,
    projects: projectsFor,
    defaultWorkspace: defaultWorkspaceFor,
    fallback: options.dataDir
  })

  /**
   * B3.1b：flag 判定入口（PB-020 A2a 后旧 Mastra loop 已删）。
   * - flag 关 → `maybeStartKernelAdapter` 返回 null：没有 chat（旧实现已删），A2b 会把内核改成必启；
   * - flag 开 → 起真内核（token/cookie 只在 main），chat 帧由 adapter 出。
   */
  // PB-004/PB-025：交互中枢（审批/提问状态源）。flag 关也建（只是永远没有内核事件进来），
  // 这样 /ask-user/pending 在两种 flag 下都返回 200 —— 404 会让 renderer composer 永久 disabled。
  const interactionHub = new InteractionHub()

  const kernelAdapter = await maybeStartKernelAdapter({
    electronExecutable: options.kernel.electronExecutable,
    asarPath: options.kernel.asarPath,
    appDataDir: options.dataDir,
    resolveCwd: resolveThreadCwd,
    // PB-004/PB-025：交互中枢——内核 session 事件与 `$events` waterfall 都喂给同一个 hub
    onSessionEvent: (threadId, event) => {
      feedKernelEvent(interactionHub, threadId, event)
    },
    onInteractionEvent: (event) => {
      applyInteractionEvent(interactionHub, event)
    },
    ...(options.kernel.dshHome === undefined ? {} : { dshHome: options.kernel.dshHome }),
    ...(options.kernel.logFile === undefined ? {} : { logFile: options.kernel.logFile }),
    ...(options.kernel.extraEnv === undefined ? {} : { extraEnv: options.kernel.extraEnv })
  }).catch((error: unknown) => {
    // PB-020 A2a：旧 Mastra 装配已删，没有 storage/memory 可清理；内核失败直接抛。
    throw error
  })
  // 内核 adapter 建好后，projectIdOf 的 cwd 来源才可用（建之前一律 null，不回落默认工作区）。
  kernelCwdOf = (threadId) => kernelAdapter?.cwdOf(threadId)

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

  // PB-004/PB-025/PB-026：交互路由（ask-user pending/cancel + hub 快照 + 写面）。
  // **两种 flag 都挂**：renderer 挂载即请求 /ask-user/pending，404 会让 composer 永久 disabled。
  // 写面只在 flag 开（有 adapter）时可用；否则回 503，不静默成功。
  app.route(
    '/',
    createKernelInteractionRouter({
      hub: interactionHub,
      ...(kernelAdapter === null ? {} : { responder: kernelAdapter })
    })
  )

  // B3.1b：flag 开才注册内核 chat 分支（同一路径、同一 token 闸门）。
  // PB-020 A2a：旧 `MastraServer.init()` 已删——旧 `/chat/:agentId`（Mastra 实现）不再注册；
  // 现在 chat 只有内核这一条路（flag 关时暂无 chat，A2b 会把 kernel 改成必启）。
  if (kernelAdapter !== null) {
    app.post(`/chat/${KYCLAW_AGENT_ID}`, createKernelChatHandler(kernelAdapter))
    console.warn(
      `[kyclaw] kernel chat enabled (session=${kernelAdapter.sessionId}, port=${String(kernelAdapter.port)})`
    )
  }

  app.route('/api/tasks', createFeatureDisabledRouter('tasks'))

  // 线程 API：0.2.0 例外项，直接走 DSH kernel session；不再注册旧 Mastra createThreadsRouter。
  // flag 关时也不回退旧实现：没有 kernel adapter 就返回 503 feature-disabled。
  const threadsDefaultCwd = resolveThreadCwd()
  const kernelThreadsOps =
    kernelAdapter === null ? null : createKernelSessionOpsForAdapter(kernelAdapter)
  const kernelThreadsDefaultSessionId = kernelAdapter?.defaultSessionId
  app.route(
    THREADS_ROUTE_PREFIX,
    kernelThreadsOps === null
      ? createKernelThreadsUnavailableRouter('kernel-not-running')
      : createKernelThreadsRouter({
          ops: kernelThreadsOps,
          defaultCwd: threadsDefaultCwd,
          ...(kernelThreadsDefaultSessionId === undefined
            ? {}
            : { defaultSessionId: kernelThreadsDefaultSessionId }),
          cwdOf: resolveThreadCwd
        })
  )

  // PB-022：八条宿主 API 0.2.0 下架；mount 保留，旧实现文件保留到 PB-020 再删。
  // 线程 API 是例外（走内核），见上；/api/kernel 是 PB-018 的命令面，不在下架清单。
  app.route(GOAL_ROUTE_PREFIX, createFeatureDisabledRouter('goal'))
  // PB-018（B3.3 renderer 半端）：renderer 的命令菜单/结果卡/六行投影统一走这层网关。
  // flag 开 → 内核命令平面；flag 关 → 旧 goal store 降级（临时，PB-020 删）。旧 /api/goal 一行未改。
  app.route(KERNEL_UI_ROUTE_PREFIX, createKernelUiRouter({ adapter: kernelAdapter }))
  app.route(PROJECTS_ROUTE_PREFIX, createFeatureDisabledRouter('projects'))

  // round 66：会话↔PPT 模板映射 API（对话页「PPT」胶囊的读/写；create_ppt 的缺省模板读同一份镜像）
  app.route(SESSION_PPT_TEMPLATES_ROUTE_PREFIX, createFeatureDisabledRouter('ppt'))

  // MCP 管理 API（T12）：服务端是配置的权威，写盘走 updateSettings（同一条校验路）。
  // PB-023：MCP 连接已迁到 DSH 内核插件（下次启动读 home patch 生效），这里不再有 lifecycle 对齐；
  // 路由本身在 PB-022 下架前保留（界面/模型的写盘入口不变，只是不再"写完即连"）。
  // round 65：这里的 saveServers 与 agent 侧 add_mcp_server / remove_mcp_server **是同一个函数**
  app.route(MCP_ROUTE_PREFIX, createFeatureDisabledRouter('mcp'))

  // 记忆 API（T14）：working memory 的查看/编辑/清空 + 语义召回的运行状态（round 28）
  app.route(MEMORY_ROUTE_PREFIX, createFeatureDisabledRouter('memory'))

  // 用量 API（T14）：已由 PB-022 统一 501；旧 store 随 A2a 装配删除
  app.route(USAGE_ROUTE_PREFIX, createFeatureDisabledRouter('usage'))

  // 轨迹数据面（用户反馈 015 / 017）：逐次模型请求的摘要 + 按 id 取正文。
  // 独立路由、独立表（request_snapshots / request_blobs）：用量那条腿坏掉不牵连轨迹。
  app.route(TRAJECTORY_ROUTE_PREFIX, createFeatureDisabledRouter('trajectory'))

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
    // 起不来就不留半个服务：把已经建好的内核连接收掉，再带着原因抛出去
    await kernelAdapter?.stop()
    throw new Error(`agent 服务启动失败：${attempts} 次都没能监听 ${HOST} 的端口`, {
      cause: lastError
    })
  }

  let stopped = false
  return {
    baseUrl: `http://${HOST}:${port}`,
    token,
    port,
    // PB-020 A2a：旧 Mastra 装配已删。追踪/语义召回/规则处理器都随旧 loop 下线；
    // 内核版本前没有对应实现 → 如实报「未开启」，不假装成功（设置页按这个显示）。
    telemetry: { langfuse: false },
    rules: { processorRegistered: false },
    projectIdOf,
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
        // 内核子进程/WS 先收（不留孤儿）；MCP 由内核子进程及其插件连接持有，随内核一起下线。
        await kernelAdapter?.stop()
      }
    }
  }
}
