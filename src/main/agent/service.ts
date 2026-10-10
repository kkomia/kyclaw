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
import { resolveModel, type KyclawModel } from '../../mastra/model'
import type { ModelResolver } from '../../mastra/agents/kyclaw'
import { readSettings, settingsPath } from '../settings'
import type { AgentEndpoint } from '../../shared/ipc'
import type { LibSQLStore } from '@mastra/libsql'
import type { Mastra } from '@mastra/core/mastra'

const HOST = '127.0.0.1'

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
  /** 起始端口；缺省交给 OS 分配（随机空闲端口） */
  port?: number
  /** 端口尝试上限（默认 5，至少 1） */
  attempts?: number
}

export interface AgentServerHandle extends AgentEndpoint {
  port: number
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
 * storage 是句柄的真正持有者 —— 无论 Mastra 收尾成不成功都要关（try/finally，T6 随修）。
 * 导出只为一件事：失败路径没法用真句柄造（shutdown 抛错），单测拿假件打这条顺序。
 */
export async function teardownQuietly(mastra: Mastra, storage: LibSQLStore): Promise<void> {
  try {
    await mastra.shutdown()
  } catch (error) {
    console.warn('[kyclaw] agent 服务收尾失败（Mastra）', error)
  } finally {
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
  const { mastra, storage } = await createKyclawMastra({
    dataDir: options.dataDir,
    resolveModel: resolveModelFor
  })

  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  const app = new Hono()
  app.use(
    '*',
    cors({
      origin: ALLOWED_ORIGINS,
      allowMethods: ['POST', 'GET', 'OPTIONS'],
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
    // 起不来就不留半个服务：把已经建好的 Mastra/storage 收掉，再带着原因抛出去
    await teardownQuietly(mastra, storage)
    throw new Error(`agent 服务启动失败：${attempts} 次都没能监听 ${HOST} 的端口`, {
      cause: lastError
    })
  }

  let stopped = false
  return {
    baseUrl: `http://${HOST}:${port}`,
    token,
    port,
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
        try {
          await mastra.shutdown()
        } finally {
          // storage 是句柄的真正持有者：前面任何一步失败都不能跳过它
          await storage.close()
        }
      }
    }
  }
}
