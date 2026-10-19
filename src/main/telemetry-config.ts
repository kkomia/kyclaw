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
