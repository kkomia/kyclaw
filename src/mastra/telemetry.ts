/**
 * 追踪开关（T17）：Langfuse exporter 接线，**默认关**。
 *
 * 姿态（与 R18 的"遥测禁"不冲突）：Mastra 自己的 PostHog 打点仍然关着（main/index.ts 启动即设
 * MASTRA_TELEMETRY_DISABLED，见 main/__tests__/telemetry-env.spec.ts）；这里是**用户显式开启**的可观测：
 * 服务地址 + 公私钥三项配齐才导出，缺一项就当没配（不发请求、不报错）——什么都不配时内容不出机器。
 *
 * 本模块只管两件事：判定"配齐了没" + 建 observability 入口（不碰 electron、不碰文件）；
 * 设置与密钥从哪读在 main/telemetry.ts（那里有 safeStorage）。
 *
 * round 67：**上报可以走代理**。地址（`endpoint`）与代理（`proxyUrl`）都是设置项，代理没填时
 * 回落 `HTTPS_PROXY`/`HTTP_PROXY` 等环境变量（`resolveProxyUrl`）。代理的落地方式只有一条路——
 * 本机中转（langfuse-relay.ts，那里写了为什么 exporter 自己吃不下代理），所以配了代理时
 * exporter 的 baseUrl 是本机中转地址。
 *
 * 生效时机：exporter 随 Mastra 实例一起建，所以**配置改动要重启应用才生效**——
 * 设置页「追踪」栏的状态文案说的就是这件事（shared/ipc.ts 的 langfuseStateSchema.active）。
 *
 * @mastra/* 是 ESM-only、主进程产物是 CJS：运行时依赖一律动态 import()。
 */
import { langfuseRelay } from './langfuse-relay'
import type { ObservabilityEntrypoint } from '@mastra/core/observability'

export interface LangfuseExportConfig {
  endpoint: string
  publicKey: string
  secretKey: string
  /**
   * HTTP(S) 代理（round 67；空/缺省 = 直连）。取值见 `resolveProxyUrl`：
   * 设置项优先，没填再看环境变量。代理怎么落地见 langfuse-relay.ts 的模块注释。
   */
  proxyUrl?: string
}

/** Langfuse 里的 service.name 维度 */
export const LANGFUSE_SERVICE_NAME = 'kyclaw'

/** 地址归一：去空白、去结尾斜杠（exporter 拿它拼 /api/public/otel/v1/traces） */
export function normalizeLangfuseEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '')
}

/**
 * 代理地址的兜底来源（按序取第一个非空）：先专用变量，再 HTTP 系的通用代理变量
 * （大写小写都认，与 Node 原生代理的读法一致），最后 ALL_PROXY。
 */
export const LANGFUSE_PROXY_ENV_KEYS = [
  'LANGFUSE_PROXY_URL',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
] as const

/**
 * 代理地址归一：去空白；没写协议就补 `http://`（`127.0.0.1:7890` 是常见写法，
 * 而 `new URL('127.0.0.1:7890')` 会把 `127.0.0.1:` 当成协议——必须先补）。空串 = 没配。
 */
export function normalizeProxyUrl(proxyUrl: string): string {
  const trimmed = proxyUrl.trim()
  if (trimmed.length === 0) return ''
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`
}

/** 生效的代理：设置项优先，没填回落环境变量（两者都没有 = 直连） */
export function resolveProxyUrl(
  setting: string | null | undefined,
  env: Record<string, string | undefined>
): string {
  const fromSetting = normalizeProxyUrl(setting ?? '')
  if (fromSetting.length > 0) return fromSetting
  for (const key of LANGFUSE_PROXY_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.trim().length > 0) return normalizeProxyUrl(value)
  }
  return ''
}

/** 三项都非空才算"开启导出"：缺一 = null（默认关走的就是这条路——地址是空串） */
export function langfuseConfigOf(input: {
  endpoint: string
  publicKey: string | null
  secretKey: string | null
  proxyUrl?: string | null
}): LangfuseExportConfig | null {
  const endpoint = normalizeLangfuseEndpoint(input.endpoint)
  const publicKey = input.publicKey ?? ''
  const secretKey = input.secretKey ?? ''
  if (endpoint.length === 0 || publicKey.length === 0 || secretKey.length === 0) return null
  const proxyUrl = normalizeProxyUrl(input.proxyUrl ?? '')
  return proxyUrl.length === 0
    ? { endpoint, publicKey, secretKey }
    : { endpoint, publicKey, secretKey, proxyUrl }
}

/**
 * exporter 真正用的 baseUrl：没配代理 = 配置里的地址；配了代理 = 本机中转的地址
 * （中转再用 Node 原生代理转发过去，见 langfuse-relay.ts）。
 * 中转起不来只记一条日志后回落直连——追踪是加法，配置坏了不该把对话拦下来。
 */
async function langfuseBaseUrl(config: LangfuseExportConfig): Promise<string> {
  if (config.proxyUrl === undefined) return config.endpoint
  try {
    return (await langfuseRelay({ target: config.endpoint, proxyUrl: config.proxyUrl })).url
  } catch (error) {
    console.warn('[kyclaw] Langfuse 代理中转起不来，本次运行改直连（代理没生效）', error)
    return config.endpoint
  }
}

/**
 * 建 observability 入口：一条 langfuse 配置，一个 LangfuseExporter。
 * `realtime` 不开（批量导出是 exporter 的缺省口径），环境/发布标记不填——个人桌面端没有这两层语义。
 * baseUrl 经 `langfuseBaseUrl`：没配代理就是用户填的那个地址，配了代理就走本机中转。
 */
export async function createLangfuseObservability(
  config: LangfuseExportConfig
): Promise<ObservabilityEntrypoint> {
  const [{ Observability }, { LangfuseExporter }] = await Promise.all([
    import('@mastra/observability'),
    import('@mastra/langfuse')
  ])
  const baseUrl = await langfuseBaseUrl(config)
  return new Observability({
    configs: {
      langfuse: {
        serviceName: LANGFUSE_SERVICE_NAME,
        exporters: [
          new LangfuseExporter({
            baseUrl,
            publicKey: config.publicKey,
            secretKey: config.secretKey
          })
        ]
      }
    }
  })
}

/**
 * 建入口的"安静版"：没配或建不起来都回 null，只留一条日志。
 * 追踪是加法——配置坏了最多不上报，不该把对话拦下来。
 */
export async function langfuseObservabilityQuietly(
  config: LangfuseExportConfig | null
): Promise<ObservabilityEntrypoint | null> {
  if (config === null) return null
  try {
    return await createLangfuseObservability(config)
  } catch (error) {
    console.warn('[kyclaw] Langfuse 导出没有挂上（本次运行不追踪）', error)
    return null
  }
}
