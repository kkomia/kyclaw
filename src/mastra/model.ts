/**
 * 模型解析（R3 离线优先 + T8 provider 定稿）：把 settings.providers + 密钥翻译成 AI SDK 模型。
 *
 * 四种口径：
 *   - `KYCLAW_FORCE_MOCK=1` 强制内置 mock（T16 E2E / 离线开发用）；
 *   - **一条 provider 都没配** → 同样回内置 mock（首次启动、离线都不至于打不开）；
 *   - 配了且配置完整 → openai-compatible（baseUrl + model，**密钥可缺**）/ anthropic（**必须有密钥**）；
 *     DeepSeek 官方端点走官方包 `@ai-sdk/deepseek`（reasoning 等能力贴着自家协议），其余走通用兼容层；
 *   - 配了但**半截**（缺 baseUrl / 缺模型名 / anthropic 缺密钥）→ 抛 `ProviderConfigError`（"配置不完整：缺 X"），
 *     绝不静默回落 mock——否则用户会以为自己在用真模型。
 *
 * 密钥口径（打包态实报修正）：`openai-compatible` 没密钥也照发——本机服务（LM Studio / llama.cpp /
 * ollama）与自建网关常常不校验密钥，而 SDK 在 `apiKey` 为空时**不发 Authorization 头**；真要认证由
 * 服务端回 401/403。只有 `anthropic` 仍强制密钥（官方 SDK 的 x-api-key 必填）。见 `providerKeyOptional`。
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
 *
 * 兼容层的"system 只有一条且在最前"（round 88 补）：用户内网网关实报
 * `400 System message must be at the beginning.`（那台网关的**确切规则未取证**）；本机实测
 * 发出去的正文是**3 条连续的 system**（agent 指令 + 工作记忆 + 规矩），故在**模型边界**把它们
 * 归并成唯一首条 —— 见 mergeSystemFirstPrompt / withSystemFirstPrompt、逃生门 SYSTEM_FIRST_ENV。
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

import { ProviderConfigError } from '../main/model'
export { ProviderConfigError }

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
 * system-first 归并的逃生门：值 `0` / `off` / `false` 关掉，其余（含没设）都当**开着**
 * （与 TOOL_MEDIA_ENV 同一口径：默认必须是"这条端点能跑通"）。只有某台兼容端点确实不接受
 * "归并成一条 system"时才需要它。
 */
export const SYSTEM_FIRST_ENV = 'KYCLAW_SYSTEM_FIRST'

/** 归并多条 system 时的连接符：原消息之间的**段边界**（不是新加的话） */
const SYSTEM_JOIN = '\n\n'

/** 通用兼容层是否做 system-first 归并（默认做）。只认**关**的几个写法：'0' / 'off' / 'false'。 */
export function systemFirstEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const value = env[SYSTEM_FIRST_ENV]?.trim().toLowerCase()
  return !(value === '0' || value === 'off' || value === 'false')
}

/**
 * 把 prompt 里的 system 消息**归并成唯一一条、放在第一条**。
 *
 * 放在模型边界（而不是 `processInput`）的原因只有一条：决定"发出去长什么样"的是 provider 收到
 * prompt 之后那一步（`@ai-sdk/openai-compatible` 把每条 `role:'system'` 照搬进 `messages[]`），
 * 而 `processInput` 读的 `messageList.get.all.db()` 里**没有** system（MessageList 把 system 放在
 * 自己的桶里）—— 在那里改是改不到 wire 的。
 *
 * 契约：
 *   - 只在"有 system 且不是唯一首条"时重建数组；其余情况**原样返回**（同一引用，零开销）；
 *   - 归并正文 = 各 system 的 content 按**原相对顺序**用空行连接；
 *   - 其余消息（user / assistant / tool）**顺序、条数、对象身份都不变**；
 *   - `providerOptions` **只保留第一条** system 的，后续 system 的**丢弃**（不做无损声明）。
 *     该层的事实（源码 + 实测）：provider 只序列化 `providerOptions.openaiCompatible` 这一个键
 *     （`getOpenAIMetadata` 写死），provider 名那个键它不看；而本应用从不给 system 设
 *     providerOptions（实抓的请求体里 system 只有 role/content）。所以当前实际不丢东西，但
 *     "归并会丢后续 providerOptions"这条限制由 `__tests__/system-first-wire.spec.ts` 的
 *     providerOptions 用例钉住；
 *   - 纯函数：不改输入数组、不改输入消息对象，也不碰 MessageList / 数据库 / 消息来源。
 */
export function mergeSystemFirstPrompt(
  prompt: ModelCallOptions['prompt']
): ModelCallOptions['prompt'] {
  const systems = prompt.filter((message) => message.role === 'system')
  const first = systems[0]
  if (first === undefined) return prompt
  if (systems.length === 1 && prompt[0]?.role === 'system') return prompt

  const content = systems
    .map((message) => message.content)
    .filter((text) => text !== '')
    .join(SYSTEM_JOIN)

  return [{ ...first, content }, ...prompt.filter((message) => message.role !== 'system')]
}

/** 给兼容层的模型套一层 system-first：doGenerate / doStream 前先把 prompt 归一。 */
export function withSystemFirstPrompt(model: KyclawModel): KyclawModel {
  const normalize = (options: ModelCallOptions): ModelCallOptions => {
    const prompt = mergeSystemFirstPrompt(options.prompt)
    return prompt === options.prompt ? options : { ...options, prompt }
  }

  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(normalize(options)),
    doStream: (options) => model.doStream(normalize(options))
  }
}

/**
 * 按配置造模型（resolveModel 与"测试连接"共用同一条装配路径）。
 * 调用前配置已被 `providerConfigProblems` 验过（openai-compatible 的 baseUrl 非空；anthropic 已给密钥）。
 *
 * **空密钥时不传 `apiKey` 这个字段**（而不是传空串）：
 *   - 通用兼容层：`...options.apiKey && { Authorization }`，空值/缺省都不发头——这正是"优先无头"；
 *     传空串会发出 `Authorization: Bearer `（空凭据），有些网关把它当"无效凭据"直接 401；
 *   - DeepSeek 官方包：`loadApiKey` 只认**字符串**（空串照收）→ 会发一个空的 `Bearer `，还会把
 *     `DEEPSEEK_API_KEY` 环境变量挡在外面。缺省传才会回落到环境变量；两者都没有则在请求前抛
 *     `LoadAPIKeyError`（一句人话，连接测试会翻出来）。
 * `env` 只影响通用兼容层的两个开关：TOOL_MEDIA_ENV（工具结果里带图）与 SYSTEM_FIRST_ENV
 * （system-first 归并）。**两个都只在通用兼容层这条分支上套**：anthropic 的 system 由官方包收进
 * 顶层 `system` 参数、且逐条带自己的 `providerOptions.anthropic`（cache_control 等），在边界归并
 * 会抹掉这些元数据；DeepSeek 官方端点自带归并口径，本次故障端点也不是它 —— 都不动。
 */
/**
 * PB-027：流式 usage 的「先请求、被拒降级」补丁（只作用于**通用兼容层**：
 * `@ai-sdk/openai-compatible` 的 `includeUsage` 开关 = 请求体里的 `stream_options.include_usage`）。
 *
 * - DeepSeek 官方包（`@ai-sdk/deepseek`）**本身就固定发** `stream_options:{include_usage:true}`
 *   （node_modules/@ai-sdk/deepseek/dist/index.js:848-849），不需要也不应该再包一层；
 * - 自建网关/部分兼容服务不认这个字段会直接 **400** —— 不能让对话挂：把 provider 记成
 *   「不支持流式 usage」，**丢掉 stream_options 重试一次**（此后该 provider 不再带该字段）。
 *
 * 只发一次额外请求（就是那次被 400 的请求本身）→ 不新增高频远程请求。
 */
const usageUnsupportedProviders = new Set<string>()

export function withUsageFallbackFetch(providerId: string): typeof fetch {
  const patched: typeof fetch = async (input, init) => {
    const first = await fetch(input, init)
    if (first.status !== 400 || usageUnsupportedProviders.has(providerId)) return first
    // 只在"看起来是 stream_options/unknown field"的 400 上降级；其它 400 原样交给上层（真错误不吞）
    let text = ''
    try {
      text = await first.clone().text()
    } catch {
      return first
    }
    if (!/stream_options|include_usage|unknown|unrecognized|unsupported/i.test(text)) return first
    usageUnsupportedProviders.add(providerId)
    if (process.env.KYCLAW_USAGE_DEBUG === '1') {
      console.warn(
        `[usage-debug] provider「${providerId}」不支持 stream_options.include_usage（400），已降级为不带该字段`
      )
    }
    let body = init?.body
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        delete parsed.stream_options
        body = JSON.stringify(parsed)
      } catch {
        // body 不是 JSON：原样重试（理论上不会发生：AI SDK 发的是 JSON）
      }
    }
    return fetch(input, { ...init, body })
  }
  return patched
}

export async function buildLanguageModel(
  config: ProviderConfig,
  apiKey: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<KyclawModel> {
  const keyOption = apiKey.trim() === '' ? {} : { apiKey }

  if (config.type === 'anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    return createAnthropic(keyOption).chat(config.model)
  }

  const baseUrl = config.baseUrl ?? ''
  if (isDeepSeekBaseUrl(baseUrl)) {
    const { createDeepSeek } = await import('@ai-sdk/deepseek')
    return createDeepSeek({ ...keyOption, baseURL: baseUrl }).chat(config.model)
  }

  const toolMedia = toolMediaEnabled(env)
  const systemFirst = systemFirstEnabled(env)
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
  const providerModel = createOpenAICompatible({
    name: OPENAI_COMPATIBLE_PROVIDER_NAME,
    baseURL: baseUrl,
    ...keyOption,
    // PB-027：请求流式 usage（OpenAI 语义 `stream_options.include_usage:true`）；被网关 400 时
    // 由 withUsageFallbackFetch 降级重试一次（不再带该字段），见上面的注释
    includeUsage: !usageUnsupportedProviders.has(config.id),
    fetch: withUsageFallbackFetch(config.id),
    // 不开这一项，工具结果里的图片会被 JSON.stringify 成字符串**静默丢掉**（见文件头注）
    supportsMultiPartToolContent: toolMedia
  }).chatModel(config.model)

  // 两个包装各管一件事，互不依赖：system-first 归一 prompt（见 SYSTEM_FIRST_ENV），
  // 工具图片回落只在开多段式工具结果时才需要（见 TOOL_MEDIA_ENV）
  const model = systemFirst ? withSystemFirstPrompt(providerModel) : providerModel
  return toolMedia ? withToolMediaFallback(model) : model
}

/**
 * 按设置解析模型（env 可注入，测试不必动 process.env）：
 * 默认标记优先；半截配置抛 ProviderConfigError（"配置不完整：缺 X"），不静默回落 mock。
 * 密钥可缺（openai 兼容族，见文件头注）；anthropic 缺密钥仍抛。
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

  // 密钥**可缺**（openai 兼容族：本机 / 自建端点常常不要密钥，SDK 在空密钥时不发 Authorization
  // 头）；真要认证由服务端回 401/403，不在本地替它拦。anthropic 仍必须有密钥（providerConfigProblems 把关）。
  const apiKey = readKey(config.id) ?? ''
  const problems = providerConfigProblems(config, apiKey !== '')
  if (problems.length > 0) {
    throw new ProviderConfigError(config.id, problems)
  }

  return { model: await buildLanguageModel(config, apiKey, env), source: config.type }
}
