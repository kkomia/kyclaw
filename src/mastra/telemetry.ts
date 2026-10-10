/**
 * 追踪开关（T17）：Langfuse exporter 接线，**默认关**。
 *
 * 姿态（与 R18 的"遥测禁"不冲突）：Mastra 自己的 PostHog 打点仍然关着（main/index.ts 启动即设
 * MASTRA_TELEMETRY_DISABLED，见 __tests__/telemetry-env.spec.ts）；这里是**用户显式开启**的可观测：
 * 服务地址 + 公私钥三项配齐才导出，缺一项就当没配（不发请求、不报错）——什么都不配时内容不出机器。
 *
 * 本模块只管两件事：判定"配齐了没" + 建 observability 入口（不碰 electron、不碰文件）；
 * 设置与密钥从哪读在 main/telemetry.ts（那里有 safeStorage）。
 *
 * 生效时机：exporter 随 Mastra 实例一起建，所以**配置改动要重启应用才生效**——
 * 设置页「追踪」栏的状态文案说的就是这件事（shared/ipc.ts 的 langfuseStateSchema.active）。
 *
 * @mastra/* 是 ESM-only、主进程产物是 CJS：运行时依赖一律动态 import()。
 */
import type { ObservabilityEntrypoint } from '@mastra/core/observability'

export interface LangfuseExportConfig {
  endpoint: string
  publicKey: string
  secretKey: string
}

/** Langfuse 里的 service.name 维度 */
export const LANGFUSE_SERVICE_NAME = 'kyclaw'

/** 地址归一：去空白、去结尾斜杠（exporter 拿它拼 /api/public/otel/v1/traces） */
export function normalizeLangfuseEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '')
}

/** 三项都非空才算"开启导出"：缺一 = null（默认关走的就是这条路——地址是空串） */
export function langfuseConfigOf(input: {
  endpoint: string
  publicKey: string | null
  secretKey: string | null
}): LangfuseExportConfig | null {
  const endpoint = normalizeLangfuseEndpoint(input.endpoint)
  const publicKey = input.publicKey ?? ''
  const secretKey = input.secretKey ?? ''
  if (endpoint.length === 0 || publicKey.length === 0 || secretKey.length === 0) return null
  return { endpoint, publicKey, secretKey }
}

/**
 * 建 observability 入口：一条 langfuse 配置，一个 LangfuseExporter。
 * `realtime` 不开（批量导出是 exporter 的缺省口径），环境/发布标记不填——个人桌面端没有这两层语义。
 */
export async function createLangfuseObservability(
  config: LangfuseExportConfig
): Promise<ObservabilityEntrypoint> {
  const [{ Observability }, { LangfuseExporter }] = await Promise.all([
    import('@mastra/observability'),
    import('@mastra/langfuse')
  ])
  return new Observability({
    configs: {
      langfuse: {
        serviceName: LANGFUSE_SERVICE_NAME,
        exporters: [
          new LangfuseExporter({
            baseUrl: config.endpoint,
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
