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
 *
 * 兼容层的"工具结果里的图片"（round 68 补）：
 *   - `@ai-sdk/openai-compatible` 的 `supportsMultiPartToolContent` **默认 false**，那时工具结果里的
 *     多段内容（render_ppt 的页图走的就是它）会被 `JSON.stringify` 成一个字符串 —— **图静默消失**，
 *     模型看不到，而且不报错。DeepSeek 官方包（`@ai-sdk/deepseek`）内建支持，所以只有"通用兼容层"
 *     这一条需要显式打开；
 *   - 打开有代价：**有些兼容端点不接受数组形态的 tool content**（回 400）。所以这里同时套一层
 *     回落：这一轮 prompt 里真有媒体块、第一次调用又失败了，就去掉媒体块**重试一次**并打日志，
 *     不让"一张模型本该看到的图"把整轮对话打成失败。细节见 withToolMediaFallback。
 */
import type { LanguageModel } from 'ai'
/** 类型专用：mock 的流 part 形状从这里取（import type 会被编译擦掉，不会把 ESM 带进 CJS 产物） */
import type { MockLanguageModelV4 } from 'ai/test'
import { providerConfigProblems, type ProviderConfig } from '../shared/providers'
/** round 18：DeepSeek 官方端点判定 / 兼容层 provider 名搬到了 shared（渲染端也要判）——这里 import 使用 */
import { isDeepSeekBaseUrl, OPENAI_COMPATIBLE_PROVIDER_NAME } from '../shared/providers'

/** 强制离线的环境变量（值必须是 '1'，避免 "0" 被当真的陷阱） */
export const FORCE_MOCK_ENV = 'KYCLAW_FORCE_MOCK'

/**
 * 通用兼容层"工具结果里可以放多段内容"的逃生门：值 `0` / `off` / `false` 关掉。
 * 默认**开着**（不关就静默丢图，见文件头注）；但万一遇到一种端点连"去掉图重试"都救不回来，
 * 用户/排障至少还有一招把这一轮跑通（关掉之后行为与打开这个能力之前一致：图不进请求体）。
 */
export const TOOL_MEDIA_ENV = 'KYCLAW_TOOL_MEDIA_CONTENT'

/** 回落时替掉媒体块的文字：让模型知道"这儿原本有图，是端点没接住"，而不是无声地少一块 */
export const TOOL_MEDIA_OMITTED = '（图片已省略：当前模型端点不接受工具结果里的图片）'

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
 * 通用兼容层是否开启"工具结果里的多段内容"（默认开）。`env` 可注入，测试不必动 process.env。
 * 只认**关**的几个写法（'0' / 'off' / 'false'）：其余（含没设）都当开着 —— 默认值必须是"图能到"，
 * 不然这个功能在换端点的第一天就静默失效，正是这次要修的问题。
 */
export function toolMediaEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const value = env[TOOL_MEDIA_ENV]?.trim().toLowerCase()
  return !(value === '0' || value === 'off' || value === 'false')
}

/** doGenerate / doStream 同一个参数形状（从模型类型推，不额外引运行期符号） */
type ModelCallOptions = Parameters<KyclawModel['doGenerate']>[0]

/**
 * 把 prompt 里**工具结果中的媒体块**换成一段说明文字。
 * 只动 `role: 'tool'` 的 `output.type === 'content'`（render_ppt 的页图就是这条路）；
 * 用户消息里的图片（附件）不碰 —— 那条路 AI SDK 走的是 `image_url`，
 * `__tests__/vision-wire.spec.ts` 已在真服务上验过，不属于这次要兜的风险。
 *
 * `dropped === 0` = 这轮没有媒体块，调用方就别回落了（重试一遍同样的请求没有意义）。
 */
export function stripToolMedia(prompt: ModelCallOptions['prompt']): {
  prompt: ModelCallOptions['prompt']
  dropped: number
} {
  let dropped = 0
  const next = prompt.map((message) => {
    if (message.role !== 'tool') return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'content') return part
        const value = part.output.value.map((item) => {
          if (item.type !== 'file') return item
          dropped += 1
          return { type: 'text' as const, text: TOOL_MEDIA_OMITTED }
        })
        return { ...part, output: { ...part.output, value } }
      })
    }
  })
  return { prompt: next, dropped }
}

/**
 * 给兼容层的模型套一层"接不住就退回纯文字"：
 *   - 成功 → 原样返回，多一层包装不改变任何行为；
 *   - 失败且**这一轮 prompt 里真有媒体块** → 打一条日志（说清是哪一步、模型这次看不到图、怎么关），
 *     去掉媒体块重发一次。回落到"没有图"至少等于打开这个能力之前的行为，不会比原来更差；
 *   - 回落那次也失败 → 把**第一次**的错误抛出去（那是端点对这条请求给的直接原因），
 *     并再打一条日志；绝不吞异常、绝不循环重试（只重试一次）。
 *
 * 只在**通用兼容层**这条路上套：DeepSeek 官方包自己就支持多段式工具结果，没有这个风险。
 */
export function withToolMediaFallback(model: KyclawModel): KyclawModel {
  const attempt = async <T>(
    options: ModelCallOptions,
    run: (options: ModelCallOptions) => PromiseLike<T>
  ): Promise<T> => {
    try {
      return await run(options)
    } catch (cause) {
      const stripped = stripToolMedia(options.prompt)
      if (stripped.dropped === 0) throw cause

      console.warn(
        `[kyclaw] 这个模型端点没接住工具结果里的 ${stripped.dropped} 个图片块（多半是不支持数组形态的 ` +
          `tool content）。已去掉图片重试一次：模型这一轮看不到那些图，正文里的文字与页图路径仍然有效。` +
          `若反复如此，设 ${TOOL_MEDIA_ENV}=off 可不再尝试把图交给模型。`,
        cause
      )
      try {
        return await run({ ...options, prompt: stripped.prompt })
      } catch (retryCause) {
        console.warn('[kyclaw] 去掉图片重试仍然失败（上面那条是端点的原始错误）', retryCause)
        throw cause
      }
    }
  }

  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => attempt(options, (next) => model.doGenerate(next)),
    doStream: (options) => attempt(options, (next) => model.doStream(next))
  }
}

/**
 * 按配置造模型（resolveModel 与"测试连接"共用同一条装配路径）。
 * 调用前配置已被 `providerConfigProblems` 验过（openai-compatible 的 baseUrl 非空）。
 * `env` 只影响通用兼容层的"工具结果里带图"开关（见 TOOL_MEDIA_ENV）。
 */
export async function buildLanguageModel(
  config: ProviderConfig,
  apiKey: string,
  env: Readonly<Record<string, string | undefined>> = process.env
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

  const toolMedia = toolMediaEnabled(env)
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
  const model = createOpenAICompatible({
    name: OPENAI_COMPATIBLE_PROVIDER_NAME,
    baseURL: baseUrl,
    apiKey,
    // 不开这一项，工具结果里的图片会被 JSON.stringify 成字符串**静默丢掉**（见文件头注）
    supportsMultiPartToolContent: toolMedia
  }).chatModel(config.model)

  return toolMedia ? withToolMediaFallback(model) : model
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

  return { model: await buildLanguageModel(config, apiKey, env), source: config.type }
}
