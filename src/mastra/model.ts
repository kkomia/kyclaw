/**
 * 模型解析（R3 离线优先）：把 settings 里的 provider 配置翻译成 AI SDK 模型。
 *
 * 三条路：
 *   - `KYCLAW_FORCE_MOCK=1` 强制内置 mock（T16 E2E / 离线开发用）；
 *   - 没配任何可用 provider → 同样回内置 mock（首次启动、离线都不至于打不开）；
 *   - 配了 → openai-compatible（baseUrl + apiKey + model）或 anthropic。
 *
 * mock 是 ai/test 的 MockLanguageModelV4 + simulateReadableStream：零网络、逐段增量、可预期，
 * 所以"链路是否真通"能被断言，而不是靠连真模型碰运气。
 *
 * 依赖形态：这里除了 zod 全是 ESM-only 的 AI SDK 包（`@ai-sdk/*` / `ai/test`），
 * 而主进程产物是 CJS——运行时依赖一律动态 import()（Rollup 会把 external 的动态 import
 * 原样留在 CJS 产物里），静态 import 只留编译期擦除的类型。
 */
import type { LanguageModel } from 'ai'
import { z } from '../shared/zod'

/** 强制离线的环境变量（值必须是 '1'，避免 "0" 被当真的陷阱） */
export const FORCE_MOCK_ENV = 'KYCLAW_FORCE_MOCK'

/** 内置 mock 的 provider/model 标识（写进模型对象，链路上看得见） */
export const MOCK_PROVIDER_NAME = 'kyclaw-mock'

/** openai-compatible 的 provider 标识（BaseURL 之外还能一眼看出是哪个通道） */
export const OPENAI_COMPATIBLE_PROVIDER_NAME = 'kyclaw-openai-compatible'

/** 离线 mock 回吐的文本，按增量切好——服务侧断言与 T16 E2E 共用这一份真身 */
export const MOCK_REPLY_CHUNKS = ['（kyclaw 离线模式）', '你好，', '我是 kyclaw。'] as const

/**
 * provider 配置的**临时**形状：settings.providers 在 T5 是 `unknown[]` 占位，
 * T8（模型与密钥页）才会定下正式 schema；这里先按"够用就好"的最小字段解析
 * （多余字段被忽略，不 reject——T8 加字段时这里不炸）。
 */
export const providerConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('openai-compatible'),
    baseUrl: z.string().min(1),
    apiKey: z.string().min(1),
    model: z.string().min(1)
  }),
  z.object({
    kind: z.literal('anthropic'),
    apiKey: z.string().min(1),
    model: z.string().min(1)
  })
])

export type ProviderConfig = z.infer<typeof providerConfigSchema>

/** 模型来源：mock = 离线兜底，其余 = provider 种类 */
export type ModelSource = 'mock' | ProviderConfig['kind']

/**
 * 我们用到的模型类型：AI SDK 7 的 v4 spec 语言模型。
 * 从 `LanguageModel`（含字符串路由 id 与旧版本 spec 的联合）里取出 v4 那一支——
 * Mastra 的 MastraModelConfig 认的是同一个 spec，联合里的旧版本会造成无谓的类型冲突。
 */
export type KyclawModel = Extract<LanguageModel, { specificationVersion: 'v4' }>

export interface ResolvedModel {
  model: KyclawModel
  source: ModelSource
  /** source 为 mock 时的原因：强制离线 / 一条可用 provider 都没有 */
  mockReason?: 'forced' | 'unconfigured'
}

/** 从 settings.providers（unknown[]）里挑出第一条能过 schema 的配置 */
function pickProviderConfig(providers: readonly unknown[] | undefined): ProviderConfig | undefined {
  for (const candidate of providers ?? []) {
    const parsed = providerConfigSchema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  // 配了东西却一条都用不了：别静默——用户会以为自己在用真模型（不打印原文，里面可能有密钥）
  if (providers && providers.length > 0) {
    console.warn(`[kyclaw] ${providers.length} 条 provider 配置都识别不了，回落到离线 mock 模型`)
  }
  return undefined
}

function mockUsage(): {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
  outputTokens: { total: number; text: number; reasoning: number }
} {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 }
  }
}

/** 内置离线模型：流式按 MOCK_REPLY_CHUNKS 逐段吐；generate 也给一份，免得别的路径撞上 "Not implemented" */
async function mockModel(): Promise<KyclawModel> {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test')
  const usage = mockUsage()
  // v4 spec 的 finishReason 是 { unified, raw } 两段结构
  const finishReason = { unified: 'stop' as const, raw: 'stop' }

  return new MockLanguageModelV4({
    provider: MOCK_PROVIDER_NAME,
    modelId: MOCK_PROVIDER_NAME,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'mock-text' },
          ...MOCK_REPLY_CHUNKS.map((delta) => ({
            type: 'text-delta' as const,
            id: 'mock-text',
            delta
          })),
          { type: 'text-end', id: 'mock-text' },
          { type: 'finish', finishReason, usage }
        ],
        chunkDelayInMs: 1
      })
    }),
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: MOCK_REPLY_CHUNKS.join('') }],
      finishReason,
      usage,
      warnings: []
    })
  })
}

async function configuredModel(config: ProviderConfig): Promise<KyclawModel> {
  if (config.kind === 'openai-compatible') {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
    return createOpenAICompatible({
      name: OPENAI_COMPATIBLE_PROVIDER_NAME,
      baseURL: config.baseUrl,
      apiKey: config.apiKey
    }).chatModel(config.model)
  }

  const { createAnthropic } = await import('@ai-sdk/anthropic')
  return createAnthropic({ apiKey: config.apiKey }).chat(config.model)
}

/** 按设置解析模型（env 可注入，测试不必动 process.env） */
export async function resolveModel(
  providers: readonly unknown[] | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<ResolvedModel> {
  if (env[FORCE_MOCK_ENV] === '1') {
    return { model: await mockModel(), source: 'mock', mockReason: 'forced' }
  }

  const config = pickProviderConfig(providers)
  if (!config) {
    return { model: await mockModel(), source: 'mock', mockReason: 'unconfigured' }
  }

  return { model: await configuredModel(config), source: config.kind }
}
