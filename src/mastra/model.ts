/**
 * 模型解析（R3 离线优先 + T8 provider 定稿）：把 settings.providers + 密钥翻译成 AI SDK 模型。
 *
 * 四种口径：
 *   - `KYCLAW_FORCE_MOCK=1` 强制内置 mock（T16 E2E / 离线开发用）；
 *   - **一条 provider 都没配** → 同样回内置 mock（首次启动、离线都不至于打不开）；
 *   - 配了且配置完整 → openai-compatible（baseUrl + apiKey + model）/ anthropic；
 *     DeepSeek 官方端点走官方包 `@ai-sdk/deepseek`（reasoning 等能力贴着自家协议），其余走通用兼容层；
 *   - 配了但**半截**（缺 key / 缺 baseUrl / 缺模型名）→ 抛 `ProviderConfigError`（"配置不完整：缺 X"），
 *     绝不静默回落 mock——否则用户会以为自己在用真模型。
 *
 * mock 是 ai/test 的 MockLanguageModelV4 + simulateReadableStream：零网络、逐段增量、可预期，
 * 所以"链路是否真通"能被断言，而不是靠连真模型碰运气。
 *
 * 依赖形态：这里除了 zod 全是 ESM-only 的 AI SDK 包（`@ai-sdk/*` / `ai/test`），
 * 而主进程产物是 CJS——运行时依赖一律动态 import()（Rollup 会把 external 的动态 import
 * 原样留在 CJS 产物里），静态 import 只留编译期擦除的类型。
 */
import type { LanguageModel } from 'ai'
/** 类型专用：mock 的流 part 形状从这里取（import type 会被编译擦掉，不会把 ESM 带进 CJS 产物） */
import type { MockLanguageModelV4 } from 'ai/test'
import { providerConfigProblems, type ProviderConfig } from '../shared/providers'
/** round 18：DeepSeek 官方端点判定 / 兼容层 provider 名搬到了 shared（渲染端也要判）——这里 import 使用 */
import { isDeepSeekBaseUrl, OPENAI_COMPATIBLE_PROVIDER_NAME } from '../shared/providers'

/** 强制离线的环境变量（值必须是 '1'，避免 "0" 被当真的陷阱） */
export const FORCE_MOCK_ENV = 'KYCLAW_FORCE_MOCK'

/** 内置 mock 的 provider/model 标识（写进模型对象，链路上看得见） */
export const MOCK_PROVIDER_NAME = 'kyclaw-mock'

/**
 * mock 的段间延迟（ms）。
 * 原值 1ms 时整条回复在 ~40ms 内到齐，UI 侧一帧就渲染完 —— "流式"在真实窗口里不可观察，
 * T16 E2E 的"停止按钮生效"也没法点。改 250ms：整条回复约 0.8s，逐段可见、依旧利落。
 * （只影响离线 mock；配了 provider 就是真模型自己的节奏）
 */
export const MOCK_CHUNK_DELAY_MS = 250

/** DeepSeek 官方端点判定 / 兼容层 provider 名 / 官方主机名：round 18 起住在 shared/providers.ts
 *  （渲染端也要判"这模型在哪个端点上"，好决定 providerOptions 的键）——这里直接 import 使用 */

/** 离线 mock 回吐的文本，按增量切好——服务侧断言与 T16 E2E 共用这一份真身 */
export const MOCK_REPLY_CHUNKS = ['（kyclaw 离线模式）', '你好，', '我是 kyclaw。'] as const

/**
 * mock 的"写文件"口令（T16 E2E）：正文里出现 `[[write:<路径>]]` 时，mock 先说一句话、再照它调一次
 * `write` —— 离线下唯一能把"审批卡 → 允许 → 落盘"整条链路走完的办法（真模型自己决定写不写，
 * 不需要口令）。只认**最后一条 user 消息**：审批通过后的续跑末条是 tool 消息，不会自己咬尾巴。
 */
export const MOCK_WRITE_MARKER = /\[\[write:([^\]\n]+)\]\]/

/** 口令触发的那次写入内容（固定值：E2E 按它断言落盘内容） */
export const MOCK_WRITE_CONTENT = 'kyclaw 离线 mock 写下的内容。\n'

/** 口令触发时先吐的一句人话（让工具流的"进场"在界面上看得见） */
const MOCK_WRITE_LEAD = '好，我来创建这个文件。'

/** mock 的 toolCallId（一次流里唯一即可） */
const MOCK_WRITE_TOOL_CALL_ID = 'mock-write'

/**
 * prompt 的只读视图：这里只做结构嗅探（末条消息是谁、文本说了什么），
 * 完整类型由 AI SDK 给 —— 而 AI SDK 是 ESM-only，静态 import 只能留**类型**。
 */
type PromptLike = ReadonlyArray<{ role?: unknown; content?: unknown }>

/** 从"末条 user 消息"里读出口令里的路径；没有口令（或末条不是 user）就回 null */
export function mockWriteTarget(prompt: PromptLike): string | null {
  const last = prompt.at(-1)
  if (last === undefined || last.role !== 'user' || !Array.isArray(last.content)) return null
  const parts = last.content as ReadonlyArray<{ type?: unknown; text?: unknown }>
  const text = parts
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')
  return MOCK_WRITE_MARKER.exec(text)?.[1] ?? null
}

/** 模型来源：mock = 离线兜底，其余 = provider 类型 */
export type ModelSource = 'mock' | ProviderConfig['type']

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

/**
 * 密钥读取器：主进程注入 `getProviderKey`（secrets.ts）；本模块不 import electron，可在 node 里单测。
 * 返回 null = 没配过或解不开（两种都当"没有密钥"，由 UI 区分引导重录）。
 */
export type ProviderKeyReader = (id: string) => string | null

/** 半截配置：解析处抛它；设置页行内提示用的是同一句文案（providerConfigProblems） */
export class ProviderConfigError extends Error {
  readonly problems: readonly string[]

  constructor(id: string, problems: readonly string[]) {
    super(`provider「${id}」${problems.join('；')}`)
    this.name = 'ProviderConfigError'
    this.problems = problems
  }
}

/** 选哪条配置：默认标记优先，没有默认就是第一条（顺序 = 用户在设置页看到的顺序） */
export function selectProviderConfig(
  providers: readonly ProviderConfig[]
): ProviderConfig | undefined {
  return providers.find((provider) => provider.isDefault) ?? providers[0]
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

/** 内置离线模型：流式按 MOCK_REPLY_CHUNKS 逐段吐（带写文件口令时改吐一次 write 工具调用）；
 *  generate 也给一份，免得别的路径撞上 "Not implemented" */
async function mockModel(): Promise<KyclawModel> {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test')
  const usage = mockUsage()
  // v4 spec 的 finishReason 是 { unified, raw } 两段结构
  const finishReason = { unified: 'stop' as const, raw: 'stop' }

  return new MockLanguageModelV4({
    provider: MOCK_PROVIDER_NAME,
    modelId: MOCK_PROVIDER_NAME,
    doStream: async (options) => ({
      stream: simulateReadableStream({
        chunks: mockChunks(options.prompt),
        chunkDelayInMs: MOCK_CHUNK_DELAY_MS
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

type MockStreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends {
    stream: ReadableStream<infer Part>
  }
    ? Part
    : never

/** 这一轮流什么：有写文件口令 → 一句话 + 一次 write 调用；否则就是那三段离线文本 */
function mockChunks(prompt: PromptLike): MockStreamPart[] {
  const target = mockWriteTarget(prompt)
  if (target === null) {
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'mock-text' },
      ...MOCK_REPLY_CHUNKS.map((delta) => ({
        type: 'text-delta' as const,
        id: 'mock-text',
        delta
      })),
      { type: 'text-end', id: 'mock-text' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: mockUsage() }
    ]
  }

  const input = JSON.stringify({ path: target, content: MOCK_WRITE_CONTENT })
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'mock-text' },
    { type: 'text-delta', id: 'mock-text', delta: MOCK_WRITE_LEAD },
    { type: 'text-end', id: 'mock-text' },
    { type: 'tool-input-start', id: MOCK_WRITE_TOOL_CALL_ID, toolName: 'write' },
    { type: 'tool-input-delta', id: MOCK_WRITE_TOOL_CALL_ID, delta: input },
    { type: 'tool-input-end', id: MOCK_WRITE_TOOL_CALL_ID },
    {
      type: 'tool-call',
      toolCallId: MOCK_WRITE_TOOL_CALL_ID,
      toolName: 'write',
      input
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: mockUsage()
    }
  ]
}

/**
 * 按配置造模型（resolveModel 与"测试连接"共用同一条装配路径）。
 * 调用前配置已被 `providerConfigProblems` 验过（openai-compatible 的 baseUrl 非空）。
 */
export async function buildLanguageModel(
  config: ProviderConfig,
  apiKey: string
): Promise<KyclawModel> {
  if (config.type === 'anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    return createAnthropic({ apiKey }).chat(config.model)
  }

  const baseUrl = config.baseUrl ?? ''
  if (isDeepSeekBaseUrl(baseUrl)) {
    const { createDeepSeek } = await import('@ai-sdk/deepseek')
    return createDeepSeek({ apiKey, baseURL: baseUrl }).chat(config.model)
  }

  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
  return createOpenAICompatible({
    name: OPENAI_COMPATIBLE_PROVIDER_NAME,
    baseURL: baseUrl,
    apiKey
  }).chatModel(config.model)
}

/**
 * 按设置解析模型（env 可注入，测试不必动 process.env）：
 * 默认标记优先；半截配置抛 ProviderConfigError（"配置不完整：缺 X"），不静默回落 mock。
 */
export async function resolveModel(
  providers: readonly ProviderConfig[] | undefined,
  readKey: ProviderKeyReader,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<ResolvedModel> {
  if (env[FORCE_MOCK_ENV] === '1') {
    return { model: await mockModel(), source: 'mock', mockReason: 'forced' }
  }

  const config = selectProviderConfig(providers ?? [])
  if (!config) {
    return { model: await mockModel(), source: 'mock', mockReason: 'unconfigured' }
  }

  const apiKey = readKey(config.id)
  const problems = providerConfigProblems(config, apiKey !== null)
  if (apiKey === null || problems.length > 0) {
    throw new ProviderConfigError(config.id, problems)
  }

  return { model: await buildLanguageModel(config, apiKey), source: config.type }
}
