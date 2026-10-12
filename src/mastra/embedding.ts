/**
 * 语义召回（round 28 模块 3；round 58 起 thread 作用域 = 只召回本会话的消息）的嵌入解析：
 * 把「设置 + 密钥」翻成 Memory 能用的 embedder，并如实回答"这次启动到底有没有召回"
 * （状态行见 shared/memory.ts 的 RecallStatus）。
 *
 * 嵌入接口只有一条：**OpenAI 兼容 `/embeddings`**（baseURL + model + key）。它既能接外部服务，
 * 也正好是本机引擎（llama.cpp 子进程，模块 3B）的形状——3B 就是这么接进来的：
 * 给 source 加一项（`localEngine`）+ 这里多一个分支，`ResolveRecallOptions.localEmbedding`
 * 由主进程注入（引擎与网关都在 `src/main/llama/*`，本模块只知道"给我一个 OpenAI 兼容端点"）。
 *
 * 失败＝加法（硬口径）：开关关着、配置半截、服务不通、启动自检不过 —— 任何一种都只是
 * **这一次没有召回**：不动 Memory 的历史窗口与画像、不拦对话；原因进日志 + 状态行。
 *
 * 接口版本结论（v1 实测，沿用）：Memory 认的嵌入模型是 AI SDK **spec v2/v3**。
 *   - 直接用项目里的 `@ai-sdk/openai-compatible`（ai@7）建出来的是 spec **v4**，
 *     `@mastra/memory` 1.36.0 的 embed 分派不认（落到 v1 分支直接抛 UnsupportedModelVersionError）；
 *   - Mastra 自己的 `ModelRouterEmbeddingModel`（`@mastra/core/llm`）把"OpenAI 兼容 + 自定义
 *     baseURL"包成 spec v2，正是 Memory 认的形状——所以走它。
 *
 * 依赖形态：@mastra/core/llm 是 ESM-only，主进程产物是 CJS —— 运行时动态 import()（同 model.ts）。
 */
import type { MastraEmbeddingModel } from '@mastra/core/vector'
import { LOCAL_EMBEDDING_MODELS } from '../shared/local-models'
import type { RecallStatus } from '../shared/memory'
import type { SemanticRecallSettings } from '../shared/settings'

/** 远程嵌入的探测超时（挂上 embedder 前那一次最小调用） */
const PROBE_TIMEOUT_MS = 15_000

/**
 * 本机引擎的探测超时：第一次调用要把 `llama-server` 拉起来并**把模型读进内存**
 * （实测 bge-small-zh 25MB 约 0.2 秒；Qwen3-Embedding-0.6B Q8_0 610MB 量级在秒级，
 * 慢盘上更久）——所以这一路的探测给足 60 秒，别把一次正常的冷启动判成"不可用"。
 */
const LOCAL_PROBE_TIMEOUT_MS = 60_000

/** 启动自检的超时（挂上后、服务起来前，让 Memory 自己那条"取维度"的路先跑一遍） */
export const EMBEDDER_VALIDATION_TIMEOUT_MS = 20_000

/**
 * 语义召回喂给模型的条数：与 Mastra 的缺省一致（4 条相似消息，各自带前后 1 条上下文）。
 * 单用户桌面场景够用——多召回几条会把 prompt 撑胖，收益却不明显。
 */
export const SEMANTIC_RECALL_TOP_K = 4
export const SEMANTIC_RECALL_MESSAGE_RANGE = 1

export interface RecallRuntime {
  /** 本次装配用的嵌入来源（与设置里的 `source` 同值；3B 会多出 `localEngine`） */
  readonly source: SemanticRecallSettings['source']
  /** 现读本次运行的召回状态（UI 每次打开都拿最新） */
  status(): RecallStatus
  /** 装配期的后台活（本模块没有；3B 的本地引擎准备会用）——不会抛 */
  settled(): Promise<void>
  /**
   * 装配**之后**才发现不可用（启动自检没过）：把状态改成"不可用 + 原因"。
   * 只在装配阶段调用一次（不被运行期来回翻状态留口子）。
   */
  markUnavailable(detail: string): void
}

export interface ResolvedRecall extends RecallRuntime {
  /** 挂给 Memory 的嵌入模型；undefined = 本次运行没有语义召回 */
  embedder?: MastraEmbeddingModel<string>
}

/** 本机嵌入引擎给的端点（主进程算好；`apiKey` 是网关那把本机密钥，不是用户的密钥） */
export interface LocalEmbeddingEndpoint {
  baseUrl: string
  /** 本地模型标识（当 embedder 的 model 名用；引擎不校验它） */
  modelId: string
  apiKey: string
}

export interface ResolveRecallOptions {
  settings: SemanticRecallSettings
  /** 嵌入服务的 API Key（主进程 safeStorage 解出来的明文；缺省 = null） */
  embeddingKey?: string | null
  /**
   * 本机引擎的端点获取器（模块 3B）：设置里来源选「本机引擎」时才会被调用。
   * 生产由 main/index.ts 注入（它会先确保引擎起来）；返回 null = 还没有可用的本机模型。
   * 缺省 = 没接上（这一路直接按"不可用"处理，不拦启动）。
   */
  localEmbedding?: () => Promise<LocalEmbeddingEndpoint | null>
  /** 测试用：直接给一个 embedder（跳过配置解析与探测） */
  embedder?: MastraEmbeddingModel<string>
  /** 日志口（缺省 console.warn；文案里绝不带密钥） */
  log?: (message: string, error?: unknown) => void
}

function defaultLog(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message)
  else console.warn(message, error)
}

/** 嵌入服务那一路的"配置齐不齐"（人话；不碰密钥内容，只说有没有） */
export function embeddingProblems(settings: SemanticRecallSettings, key: string | null): string[] {
  const problems: string[] = []
  if (settings.baseUrl.trim() === '') problems.push('缺服务地址')
  if (settings.model.trim() === '') problems.push('缺模型名')
  if (key === null || key.trim() === '') problems.push('缺 API Key')
  return problems
}

/** 状态盒子：`markUnavailable` 改它，UI 每次读都是最新的那份 */
interface RecallCell {
  status: RecallStatus
}

/** 造一个"运行时"；`settled` / `embedder` 有就给（本模块前者用不上，3B 会） */
function runtimeOf(
  source: SemanticRecallSettings['source'],
  cell: RecallCell,
  options: { settled?: () => Promise<void>; embedder?: MastraEmbeddingModel<string> } = {}
): ResolvedRecall {
  const runtime: RecallRuntime = {
    source,
    status: () => cell.status,
    settled: async () => {
      if (options.settled !== undefined) await options.settled()
    },
    markUnavailable: (detail: string) => {
      cell.status = {
        state: 'unavailable',
        active: false,
        enabled: cell.status.enabled,
        source: cell.status.source,
        detail
      }
    }
  }
  return options.embedder === undefined ? runtime : { ...runtime, embedder: options.embedder }
}

/** 一个"没挂上 embedder"的运行时（关着 / 起不来），状态直接给定 */
function unavailableOf(
  source: SemanticRecallSettings['source'],
  enabled: boolean,
  state: RecallStatus['state'],
  detail: string
): ResolvedRecall {
  return runtimeOf(source, { status: { state, active: false, enabled, source, detail } })
}

/**
 * 解析本次运行的语义召回。**不抛**：任何一路起不来都回一个没有 embedder 的实例
 * （状态里说清原因），调用方据此照常装配 Memory。
 */
export async function resolveRecall(options: ResolveRecallOptions): Promise<ResolvedRecall> {
  const settings = options.settings

  if (!settings.enabled) {
    return unavailableOf(settings.source, false, 'off', '语义召回未开启')
  }

  // 测试注入：不碰设置之外的东西，直接算"开了"
  if (options.embedder !== undefined) {
    return runtimeOf(
      settings.source,
      {
        status: {
          state: 'active',
          active: true,
          enabled: true,
          source: settings.source,
          detail: '已开启（测试注入的嵌入模型）'
        }
      },
      { embedder: options.embedder }
    )
  }

  // 模块 3B：本机引擎这一支（llama.cpp 子进程 + 本地 GGUF）；其余走 OpenAI 兼容服务
  if (settings.source === 'localEngine') {
    return await resolveLocalRecall({ ...options, settings })
  }
  return await resolveRemoteRecall({ ...options, settings })
}

/**
 * 本机引擎这一支：把 embedder 指到主进程给的**嵌入网关**地址上（`127.0.0.1:<port>/v1`）。
 *
 * 与远程那一路的三点不同：
 *   1. 没有 baseUrl / key 配置项 —— 地址由主进程现场算（引擎端口随起随落，网关端口固定）；
 *   2. "没有模型"不是配置错，只是**还没下载**：状态照实说，界面会给下一步动作；
 *   3. 探测给足 60 秒：这一次调用会顺手把引擎拉起来（冷启动的成本记在这一步上）。
 *
 * 引擎/网关的细节全在 `src/main/llama/*`：本模块只知道"给个 OpenAI 兼容端点"。
 */
async function resolveLocalRecall(
  options: ResolveRecallOptions & { settings: SemanticRecallSettings }
): Promise<ResolvedRecall> {
  const log = options.log ?? defaultLog
  const settings = options.settings
  const provide = options.localEmbedding

  if (provide === undefined) {
    return unavailableOf(
      settings.source,
      true,
      'unavailable',
      '本机引擎没有接上（这次运行没有召回）'
    )
  }

  let endpoint: LocalEmbeddingEndpoint | null
  try {
    endpoint = await provide()
  } catch (error) {
    log('[kyclaw] 语义召回：本机嵌入引擎起不来（不影响对话）', error)
    return unavailableOf(
      settings.source,
      true,
      'unavailable',
      `本机嵌入引擎起不来：${reasonOf(error)}（这次运行没有召回）`
    )
  }
  if (endpoint === null) {
    return unavailableOf(
      settings.source,
      true,
      'unavailable',
      '还没有启用本机嵌入模型（这次运行没有召回）'
    )
  }

  let embedder: MastraEmbeddingModel<string>
  try {
    const { ModelRouterEmbeddingModel } = await import('@mastra/core/llm')
    embedder = new ModelRouterEmbeddingModel({
      providerId: 'kyclaw-local-engine',
      modelId: endpoint.modelId,
      url: endpoint.baseUrl,
      apiKey: endpoint.apiKey
    })
  } catch (error) {
    log('[kyclaw] 语义召回：本机嵌入模型初始化失败（不影响对话）', error)
    return unavailableOf(
      settings.source,
      true,
      'unavailable',
      `本机嵌入模型初始化失败：${reasonOf(error)}（这次运行没有召回）`
    )
  }

  try {
    const probe = await embedder.doEmbed({
      values: ['kyclaw'],
      abortSignal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS)
    })
    if (probe.embeddings[0] === undefined || probe.embeddings[0].length === 0) {
      throw new Error('引擎没有返回可用的向量')
    }
  } catch (error) {
    log('[kyclaw] 语义召回：本机嵌入引擎探测失败（不影响对话）', error)
    return unavailableOf(
      settings.source,
      true,
      'unavailable',
      `本机嵌入引擎不可用：${reasonOf(error)}（这次运行没有召回）`
    )
  }

  return runtimeOf(
    settings.source,
    {
      status: {
        state: 'active',
        active: true,
        enabled: true,
        source: settings.source,
        detail: `已开启（本机引擎：${localModelLabel(endpoint.modelId)}）`
      }
    },
    { embedder }
  )
}

/** 状态行里的模型名：能对上清单就用清单的中文名，自定义档就叫"自定义模型" */
function localModelLabel(id: string): string {
  return LOCAL_EMBEDDING_MODELS.find((model) => model.id === id)?.name ?? '自定义模型'
}

async function resolveRemoteRecall(
  options: ResolveRecallOptions & { settings: SemanticRecallSettings }
): Promise<ResolvedRecall> {
  const log = options.log ?? defaultLog
  const settings = options.settings
  const key = options.embeddingKey ?? null

  const problems = embeddingProblems(settings, key)
  if (problems.length > 0) {
    const detail = `嵌入服务配置不完整：${problems.join('、')}（这次运行没有召回）`
    log(`[kyclaw] 语义召回：${detail}`)
    return unavailableOf(settings.source, true, 'unavailable', detail)
  }

  let embedder: MastraEmbeddingModel<string>
  try {
    const { ModelRouterEmbeddingModel } = await import('@mastra/core/llm')
    embedder = new ModelRouterEmbeddingModel({
      providerId: 'kyclaw-embedding',
      modelId: settings.model.trim(),
      url: settings.baseUrl.trim(),
      apiKey: key ?? ''
    })
  } catch (error) {
    log('[kyclaw] 语义召回：嵌入模型初始化失败（不影响对话）', error)
    return unavailableOf(
      settings.source,
      true,
      'unavailable',
      `嵌入模型初始化失败：${reasonOf(error)}（这次运行没有召回）`
    )
  }

  // 挂上之前先探一条：不通就不挂（挂上去的话，每轮对话会先问它要维度，那一步抛错就是整轮报错）
  try {
    const probe = await embedder.doEmbed({
      values: ['kyclaw'],
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (probe.embeddings[0] === undefined || probe.embeddings[0].length === 0) {
      throw new Error('服务没有返回可用的向量')
    }
  } catch (error) {
    log('[kyclaw] 语义召回：嵌入服务探测失败（不影响对话）', error)
    return unavailableOf(
      settings.source,
      true,
      'unavailable',
      `嵌入服务不可用：${reasonOf(error)}（这次运行没有召回）`
    )
  }

  return runtimeOf(
    settings.source,
    {
      status: {
        state: 'active',
        active: true,
        enabled: true,
        source: settings.source,
        detail: `已开启（嵌入服务：${settings.model.trim()}）`
      }
    },
    { embedder }
  )
}

/**
 * 启动自检：让 Memory 自己那条"取嵌入维度"的路先跑一遍，并把结果记进它的缓存。
 *
 * 为什么必须做（实测）：`Memory.getEmbeddingDimension()` 是**每轮**装配输入处理器时的前置
 * （`SemanticRecall` 处理器要按维度挑索引），它一抛，整轮对话就是 500——"失败＝加法"在这条
 * 路上会破。而它只在第一次成功前会真去问 embedder（promise 记忆化），所以启动时先跑一遍：
 *   - 通过 = 这条致命路已经缓存好，之后 embedder 再挂也只是没有召回（处理器自己吞错）；
 *   - 不通过 = 装配层不挂 embedder，用一份没有语义召回的 Memory 顶上（状态如实说原因）。
 *
 * `getEmbeddingDimension` 在类型上是 protected（TS 拿不到），这里按运行时行为探测：
 * 拿不到就当没有自检（不拦启动）。
 */
export async function validateRecallEmbedder(
  memory: unknown,
  timeoutMs: number = EMBEDDER_VALIDATION_TIMEOUT_MS
): Promise<string | null> {
  const probe = (memory as { getEmbeddingDimension?: () => Promise<number | undefined> })
    .getEmbeddingDimension
  if (typeof probe !== 'function') return null

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      probe.call(memory),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`)),
          timeoutMs
        )
      })
    ])
    return null
  } catch (error) {
    return `嵌入模型没通过启动自检：${reasonOf(error)}`
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 人话的原因摘要：取错误第一行，截断到一行能读的长度（绝不带密钥——错误里也不该有） */
function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const firstLine = raw.split('\n')[0]?.trim() ?? ''
  const text = firstLine === '' ? '未知原因' : firstLine
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}
