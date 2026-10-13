/**
 * Langfuse 上报的**代理中转**（round 67）：只有配了代理时才起，指向 127.0.0.1 的随机端口。
 *
 * 为什么要这一跳（不是直接给 exporter 配代理）：
 *   - 我们的上报链路是 `@mastra/langfuse` → `@langfuse/otel` 的 LangfuseSpanProcessor →
 *     `@opentelemetry/exporter-trace-otlp-http` 的 OTLPTraceExporter，底层走 **node:http 的
 *     http.request**，而且它自己 `new http.Agent({keepAlive:true})` —— **显式传了 agent**；
 *   - Node 24 的原生代理（`--use-env-proxy` / `http.setGlobalProxyFromEnv()` / `proxyEnv` 选项）
 *     只对"没有显式传 agent"的请求生效，显式 agent 的请求照样直连（本机实测：显式 agent +
 *     `setGlobalProxyFromEnv` 仍直连）——而 exporter 内部那个 agent 我们够不着
 *     （Mastra 的 LangfuseExporter 不接受自定义 exporter/agent）；
 *   - 所以代理只能落在**我们自己能控制的那一跳**上：把 exporter 的 baseUrl 指到本机中转，
 *     中转再用 **Node 原生代理 agent**（`new http(s).Agent({ proxyEnv })`，见 Node 24 文档
 *     「Built-in Proxy Support」）转发到真正的 Langfuse。不装任何新依赖。
 *
 * 边界/代价（报告里也写明）：
 *   - 代理只影响 Langfuse 这一条链路（中转只往配置里的那一个地址转发，不是开放代理）；
 *   - 因为 baseUrl 变了，Langfuse 侧的**媒体引用**（图片/音频上传后写回 trace 的 URL）会带上
 *     本机中转地址；不上传媒体的普通 trace 不受影响（这版不处理，记录在案）。
 *
 * 纯 Node 模块（不 import electron），能在 vitest 的 node 环境里真跑。
 */
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type AgentOptions as HttpAgentOptions
} from 'node:http'
import * as nodeHttp from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'

/**
 * Node 24 的 `proxyEnv` agent 选项（文档「Built-in Proxy Support」，选项本身是 24.5 起）：
 * 本仓库的 @types/node 还是 22 版的，还没有这个字段，所以在这里显式声明一次形状。
 * 运行时是 Electron 44 自带的 Node 24.21 —— 确有这个选项；真遇到老运行时由下面的
 * `assertNativeProxy()` 拦下来（回落直连，而不是静默地"配了代理却不走代理"）。
 */
interface ProxyEnvAgentOptions extends HttpAgentOptions {
  proxyEnv: { HTTP_PROXY: string; HTTPS_PROXY: string; NO_PROXY: string }
}

/**
 * 运行时有原生代理吗：拿 `http.setGlobalProxyFromEnv`（与 proxyEnv 同族的公开 API，24.14 起）
 * 当探针——它在就是原生代理在，不在就别装（宁可回落直连，也不留一个假装走了代理的中转）。
 */
function assertNativeProxy(): void {
  const probe = (nodeHttp as unknown as Record<string, unknown>).setGlobalProxyFromEnv
  if (typeof probe !== 'function') {
    throw new Error('这个运行时没有 Node 原生代理支持（需要 Node >= 24.14 / Electron >= 44）')
  }
}

export interface LangfuseRelay {
  /** 给 exporter 用的 baseUrl（`http://127.0.0.1:<随机端口>`） */
  url: string
  /** 真正要去的 Langfuse 地址（归一后） */
  target: string
  /** 走哪个代理（归一后，非空） */
  proxyUrl: string
  /** 收掉中转（重复调用是空操作） */
  stop(): Promise<void>
}

/**
 * 起一个本机中转：`startLangfuseRelay({ target: 'http://lf:3000', proxyUrl: 'http://p:8080' })`。
 *
 * 目标地址协议不合法、代理地址 Node 认不出来（`ERR_PROXY_INVALID_CONFIG`）都在这里抛出——
 * 调用方（mastra/telemetry.ts）接住后回落直连，不拦对话。
 */
export async function startLangfuseRelay(input: {
  target: string
  proxyUrl: string
}): Promise<LangfuseRelay> {
  const targetUrl = new URL(input.target)
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`Langfuse 地址必须是 http(s)：${input.target}`)
  }
  const secure = targetUrl.protocol === 'https:'
  assertNativeProxy()
  // 原生代理：http 与 https 目标各一个 agent（https 目标由 Node 自己走 CONNECT 隧道）。
  // NO_PROXY 显式清空：用户的 NO_PROXY 不该让这一跳绕过代理。
  const proxyEnv = { HTTP_PROXY: input.proxyUrl, HTTPS_PROXY: input.proxyUrl, NO_PROXY: '' }
  const agentOptions = { keepAlive: true, proxyEnv } as ProxyEnvAgentOptions
  const agent = secure ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions)

  const server = createServer((incoming, outgoing) => {
    const forward = secure ? httpsRequest : httpRequest
    const upstream = forward(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port === '' ? undefined : Number(targetUrl.port),
        method: incoming.method,
        path: incoming.url ?? '/',
        // Host 换成真正的 Langfuse 主机（本机中转的 127.0.0.1:port 对上游客没意义）
        headers: { ...incoming.headers, host: targetUrl.host },
        agent
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      }
    )
    upstream.on('error', (error: Error) => {
      // 只回一句人话（中转自己坏掉不该让 exporter 卡住；它那边有 5s 超时兜底）
      if (outgoing.headersSent) {
        outgoing.destroy()
        return
      }
      outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      outgoing.end(`langfuse relay: ${error.message}`)
    })
    incoming.pipe(upstream)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 只绑本机回环：外部访问不到这一跳
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  // 中转不该把进程钉在活着（应用退出 / 测试收尾时随进程消失）
  server.unref()

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Langfuse 代理中转起不来：拿不到监听端口')
  }

  let stopped = false
  return {
    url: `http://127.0.0.1:${address.port}`,
    target: targetUrl.origin,
    proxyUrl: input.proxyUrl,
    stop: async () => {
      if (stopped) return
      stopped = true
      // 先掐掉在途连接再关监听（这里只有 keep-alive 的空闲连接，但收干净更稳妥）
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      agent.destroy()
    }
  }
}

/**
 * 中转的进程级登记表：同一个 (目标, 代理) 只起一跳（exporter 随 Mastra 实例建，
 * 一个进程里通常只有一次；按 key 复用是为了重复装配/测试里不堆端口）。
 */
const relays = new Map<string, Promise<LangfuseRelay>>()

function relayKey(target: string, proxyUrl: string): string {
  return `${target}\u0000${proxyUrl}`
}

export function langfuseRelay(input: { target: string; proxyUrl: string }): Promise<LangfuseRelay> {
  const key = relayKey(input.target, input.proxyUrl)
  const existing = relays.get(key)
  if (existing !== undefined) return existing

  const starting = startLangfuseRelay(input)
  relays.set(key, starting)
  // 起不来就把 key 摘掉（下次装配还能再试），错误原样交给调用方
  starting.catch(() => relays.delete(key))
  return starting
}

/** 收掉所有中转（应用收尾与测试用；重复调用是空操作） */
export async function stopLangfuseRelays(): Promise<void> {
  const starting = [...relays.values()]
  relays.clear()
  await Promise.all(
    starting.map(async (relay) => {
      try {
        await (await relay).stop()
      } catch (error) {
        console.warn('[kyclaw] Langfuse 代理中转收尾失败', error)
      }
    })
  )
}
