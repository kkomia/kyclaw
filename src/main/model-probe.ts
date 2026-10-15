/**
 * 模型能力探测（round 22 起；视觉 round 48 补）——两趟请求，各写 `settings.probedModels` 的字段
 * （键 `<providerId>:<modelId>`，与消费侧同一个 `probedKeyOf`）：
 *
 *   ① `GET {baseUrl}/models` 取**元数据实测值**：上下文长度（context_window）、
 *      最大输出（max_output_tokens）、思考挡位（effort.supported_levels / default_level）。
 *      为什么：round 18 的注册表按模型名**猜**（deepseek-flash 写 128K），官方端点实测是 1M。
 *      **没有密钥也跑**（不带 Authorization 头）：本机服务（LM Studio / llama.cpp / ollama）不要密钥，
 *      挡掉它等于本机模型永远没有元数据。只发 GET，不产生推理开销。
 *   ② **一条真发图片的最小非流式 chat 请求**（round 48）取**视觉能力**：端点收下了 → `vision: true`；
 *      明确拒图（400/415/422 且错误体点名 image/vision/modality）→ `vision: false`；
 *      其余（401/403/429/超时/网络/5xx）→ **不写**（不知道就不标，绝不误判成"不能看图"）。
 *      为什么：用户点名的"注册模型后自动探测多模态，不存在'有但我不开'"——手动开关整个删掉了。
 *      **没有密钥就跳过**：这是唯一会真烧算力的一趟，不该被"没配密钥"自动触发。
 *
 * 纪律：
 *   - **尽力而为、静默失败**：探测失败只 `console.warn`（不抛、不挡保存/测试连接/菜单/启动）；
 *   - **密钥不出主进程**：只进 Authorization / x-api-key 头；日志与回包永不含 key（错误文案只写状态码）；
 *   - 超时：元数据 5s、视觉 10s（自带 AbortSignal.timeout），不重试（下一次触发自然会重试）；
 *   - 解析逐项防御：条目没有有效 context_window 就不入**元数据表**（拿不到分母），
 *     但"端点上有这个模型"这件事照样列得出来（parseModelIds，用户反馈 006/007）；
 *     efforts 缺省 = 回落注册表；`default_level` 不在 supported_levels 里 = 不采信；
 *   - **只要真问过一趟就盖 fetchedAt**（用户反馈 006）：一条元数据都没解析出来也盖——
 *     不然（无密钥的本机服务尤其如此）模型菜单每次打开都重探。"问过"≠"问出了元数据"，
 *     但如果连时间戳都没盖，菜单就会一直重试。
 *   - **只探 provider 的当前模型**（`provider.model`）；
 *   - 视觉那趟在**同一 provider 内去重**（同时只跑一趟，后面的搭车）——它是会真花钱的 chat 请求。
 *   - Anthropic 的元数据这趟没有 baseUrl（走官方默认域）→ 自然跳过；视觉那趟照探（官方域 + 官方协议）。
 *
 * 触发（五处，全在 main 侧或经 IPC）：①连接测试成功后（渲染端走 settings:probe-models）；
 * ②provider/key 保存后（settings:update 里后台跑；渲染端写密钥成功后也补一发）；
 * ③应用启动时（main/index.ts 后台跑）；④模型菜单打开且缓存过期 >24h（渲染端经 settings:probe-models 触发）；
 * ⑤模型菜单里的「刷新模型信息」——**不看 TTL**，点一次就重试一次（手动可重试）。
 *
 * 另有一条**只读**的口子（用户反馈 007）：`listProviderModels` 用同一趟 GET /models 列出端点上的
 * 可选模型，给"新增 / 给端点加模型"的弹窗挑——**不落盘**，失败由 IPC 那层吞成空表。
 * `discoverProviderModels` 是它的"还没保存"版本：地址与密钥由弹窗现给（不走设置），失败带原因
 * 回来而不是静默空表——新注册这条路就是靠它在保存前看到端点上有哪些模型。
 */
import type { AppSettings, ProbedModel } from '../shared/settings'
import { probedKeyOf, type ProbedModelSpec } from '../shared/models'
import type { ProviderConfig, ProviderType } from '../shared/providers'
import { describeProbeError } from './error-text'
import { readSettings, updateSettings } from './settings'

/** 元数据探测超时（网络掐住不该拖着保存/启动流程） */
export const PROBE_TIMEOUT_MS = 5_000

/** 视觉探测超时：一条最小 chat 请求，10s 足够（本地模型冷启动慢的话也只是这一次探不出结论） */
export const VISION_PROBE_TIMEOUT_MS = 10_000

/**
 * 探测用的图：**1×1 透明 PNG**（68 字节，IHDR/CRC 都合法——端点会真解 data URL，占位串会被当成坏图）。
 * 挂在 data URL 上发出去；除此之外不落任何字节到磁盘。
 */
export const VISION_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

/** 探测的正文：越短越好（只为"收不收得下图"，不为回答） */
const VISION_PROBE_TEXT = 'ping'

/**
 * Anthropic 的官方端点（settings 里 anthropic 不填 baseUrl —— 与 `createAnthropic({apiKey})` 的
 * 缺省同源；自定义 baseUrl 时用用户填的那个）。
 */
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'

/** Anthropic Messages API 的版本头（官方现役值） */
const ANTHROPIC_API_VERSION = '2023-06-01'

/**
 * "不收图"的措辞特征：**必须落在 400/415/422 里才采信**——否则会把别的 400（max_tokens 不支持、
 * 参数写错）误判成"没有视觉"。所以这里只认与图片/模态相关的词。
 */
const VISION_REJECTION_PATTERN = /image|vision|multimodal|modality|media[\s_-]*type/i

/**
 * "**这张图本身**不合法"的措辞（2026-10-12 在真端点上实测到的原样句子：
 * `You have uploaded an unsupported image. Please make sure your image is valid and has one of the
 * following formats: webp, png, jpeg, and gif.`）——它说的是我们的图有问题，**不是模型不能看图**。
 * 这类 400 一律不采信（回 null = 不知道），否则会把"能看图的端点"标成"不能看图"。
 */
const VISION_IMAGE_INVALID_PATTERN =
  /unsupported image|invalid image|image is not valid|make sure your image is valid|image too (small|large)|failed to (decode|parse|read) (the )?image/i

/** 解析出来的一条实测元数据（还没有 fetchedAt；落库时才盖时间戳） */
export type ParsedModelMeta = Omit<ProbedModelSpec, 'fetchedAt' | 'vision'>

/** 触发方要的依赖：全部可注入（单测不碰 electron / 真网络） */
export interface ProbeDeps {
  fetchImpl?: typeof fetch
  /** 元数据那趟的超时（缺省 PROBE_TIMEOUT_MS） */
  timeoutMs?: number
  /** 视觉那趟的超时（缺省 VISION_PROBE_TIMEOUT_MS） */
  visionTimeoutMs?: number
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数组形态兼容：`{data:[...]}`（OpenAI/DeepSeek 风格）/ `{models:[...]}` / 顶层数组 / 单个对象 */
function entriesOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.models)) return payload.models
  if (typeof payload.id === 'string') return [payload]
  return []
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  )
  return items.length === 0 ? undefined : items
}

/**
 * `GET /models` 的回包 → 端点列出的模型 id（**纯"列清单"这一件事**，去重、保序、不要求有元数据）。
 * 用户反馈 006：清单与元数据是两件事——条目没有 context_window 仍然"存在这个模型"，
 * 该列的照样列（`parseModelsPayload` 那边会把它跳过，它只管"能不能算出分母"）。
 */
export function parseModelIds(payload: unknown): string[] {
  const ids: string[] = []
  for (const entry of entriesOf(payload)) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

/**
 * 一条条目 → 实测元数据（没有有效 context_window 的条目回 undefined）。
 * effort 不是对象 / supported_levels 非法 → 该字段缺省；default_level 必须在 supported_levels 里。
 */
function metaOfEntry(entry: Record<string, unknown>): ParsedModelMeta | undefined {
  const contextWindow = positiveInt(entry.context_window)
  if (contextWindow === undefined) return undefined

  const meta: ParsedModelMeta = { contextWindow }
  const maxOutputTokens = positiveInt(entry.max_output_tokens)
  if (maxOutputTokens !== undefined) meta.maxOutputTokens = maxOutputTokens

  if (isRecord(entry.effort)) {
    const efforts = stringArray(entry.effort.supported_levels)
    if (efforts !== undefined) {
      const levels = efforts.filter((level) => level !== 'default')
      if (levels.length > 0) meta.efforts = levels
      const defaultEffort = entry.effort.default_level
      if (
        typeof defaultEffort === 'string' &&
        defaultEffort !== '' &&
        defaultEffort !== 'default' &&
        levels.includes(defaultEffort)
      ) {
        meta.defaultEffort = defaultEffort
      }
    }
  }
  return meta
}

/**
 * `GET /models` 的回包 → `{ [modelId]: 元数据 }`（纯函数）。
 * 容忍三种数组形态与缺字段：**没有有效 context_window 的条目不进这张表**（拿不到分母就不入库），
 * 但它在 `parseModelIds` 那边照样是"端点上有这个模型"。
 */
export function parseModelsPayload(payload: unknown): Record<string, ParsedModelMeta> {
  const models: Record<string, ParsedModelMeta> = {}
  for (const entry of entriesOf(payload)) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    const meta = metaOfEntry(entry)
    if (meta === undefined) continue
    models[id] = meta
  }
  return models
}

/**
 * `GET /models` 没成功（非 2xx）：带上状态码，让"列清单"那条路能把它翻成
 * "这个端点没有 /models" 这类能照做的人话（探测那条路照旧只吞成一句 warn）。
 */
export class ModelListError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ModelListError'
    this.status = status
  }
}

/**
 * GET `{baseUrl}/models` 的原始回包（**"列清单"与"取元数据"共用这一趟**；不解析、不落盘）。
 * 没有 baseUrl（Anthropic 官方域，见 fetchProviderModels 的说明）→ 回 `undefined`：**没问过**，
 * 与"问了但端点回了空清单"是两件事（`probeProviderModels` 的 fetchedAt 就靠它区分）。
 *
 * 密钥为空时**不发 Authorization 头**（而不是发一个 `Bearer ` 空串）：本机服务
 * （LM Studio / llama.cpp / ollama）本来就不要密钥，空头有些网关会当"给了个无效凭据"直接 401。
 * 要不要认证由服务自己回（401/403），调用方照它说人话。
 */
export async function fetchModelsPayload(
  config: Pick<ProviderConfig, 'type' | 'baseUrl'>,
  apiKey: string,
  deps: ProbeDeps = {}
): Promise<unknown | undefined> {
  const baseUrl = config.baseUrl?.trim() ?? ''
  if (baseUrl === '') return undefined

  const fetchImpl = deps.fetchImpl ?? fetch
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const key = apiKey.trim()
  const response = await fetchImpl(url, {
    ...(key === '' ? {} : { headers: { authorization: `Bearer ${key}` } }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new ModelListError(`模型清单请求失败（${response.status}）`, response.status)
  }
  return await response.json()
}

/**
 * 抓一个 provider 的模型元数据（成功回 `{ [modelId]: 元数据 }`；失败抛——调用方决定吞不吞）。
 * 没有 baseUrl（Anthropic 官方域）→ 直接回空表（本轮不探）。
 */
export async function fetchProviderModels(
  config: Pick<ProviderConfig, 'type' | 'baseUrl'>,
  apiKey: string,
  deps: ProbeDeps = {}
): Promise<Record<string, ParsedModelMeta>> {
  const payload = await fetchModelsPayload(config, apiKey, deps)
  return payload === undefined ? {} : parseModelsPayload(payload)
}

/**
 * 列一个 provider 端点上的**可选模型**（用户反馈 007：新增/加模型时让用户挑，而不是凭记忆敲）。
 * 一个模型两项：`id` 与（端点给了才有）`contextWindow`。
 * **只读**：不落盘、不写 probedModels、不动任何设置；失败抛（IPC handler 吞掉回空表——
 * "这条端点没有 /models"不该变成一个硬错误）。
 */
export async function listProviderModels(
  config: Pick<ProviderConfig, 'type' | 'baseUrl'>,
  apiKey: string,
  deps: ProbeDeps = {}
): Promise<{ id: string; contextWindow?: number }[]> {
  const payload = await fetchModelsPayload(config, apiKey, deps)
  if (payload === undefined) return []

  const meta = parseModelsPayload(payload)
  return parseModelIds(payload).map((id) => {
    const contextWindow = meta[id]?.contextWindow
    return contextWindow === undefined ? { id } : { id, contextWindow }
  })
}

/** discoverProviderModels 的回包：带原因的成功/失败（**不是异常**） */
export type ModelDiscoveryResult =
  { ok: true; models: { id: string; contextWindow?: number }[] } | { ok: false; message: string }

/**
 * 用户反馈 007（补齐）：拿**用户刚在弹窗里填的**地址与密钥列一次模型清单。
 *
 * 与 `listProviderModels` 的两点不同，都是刻意的：
 *   ① 地址与密钥是这次调用现给的（那条端点还没落盘）——所以"新注册"这条路上，
 *      用户不必先手填一个模型名、存下去，才能看到端点上有什么；
 *   ② 失败回 `{ok:false, message}` 而不是抛/空表：弹窗要把"读不到（给原因）"与
 *      "读到了、端点就是空的（直接手填）"分开说，静默空表在这里会变成误导。
 *
 * 仍然**只读**：不落盘、不动 probedModels；密钥只活在这一趟的请求头里，
 * 不进日志、不进回包（失败文案经 error-text.ts 抹一遍）。
 *
 * **密钥可以留空**（用户反馈 007 的补充）：本机服务（LM Studio / llama.cpp / ollama）压根不要
 * 密钥，一律空着也能试；空着就不发 Authorization 头，要不要认证由服务回（401/403）——
 * 那时才说"这个端点需要 API Key"。密钥是**可选**的，不是**必需**的。
 */
export async function discoverProviderModels(
  input: { type: ProviderType; baseUrl?: string },
  apiKey: string,
  deps: ProbeDeps = {}
): Promise<ModelDiscoveryResult> {
  const baseUrl = input.baseUrl?.trim() ?? ''
  if (baseUrl === '') {
    return {
      ok: false,
      message:
        input.type === 'anthropic'
          ? '这个渠道走官方端点，没有模型清单可读：直接手填模型名'
          : '先填 Base URL，再发现模型'
    }
  }

  // 密钥留空**照试**：本机服务（LM Studio / llama.cpp / ollama）不要密钥，前端一刀切会把
  // "离线也能用"这条路挡死。要不要认证由服务自己回（401/403），那时才说"需要 API Key"。
  const key = apiKey.trim()
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  try {
    const models = await listProviderModels({ type: input.type, baseUrl }, key, deps)
    return { ok: true, models }
  } catch (error) {
    return { ok: false, message: describeDiscoveryError(error, key, timeoutMs) }
  }
}

/**
 * 列清单的失败 → 能照做的一句话（401/403/404 各说各的，其余走通用翻译）。
 * `apiKey` 为空时 401/403 的措辞是"**这个端点**要密钥"——不是"先填密钥"（那等于替服务下判断）。
 * `timeoutMs` 是这一趟**实际**用的预算（超时文案要说真话）。
 */
function describeDiscoveryError(error: unknown, apiKey: string, timeoutMs: number): string {
  const status = error instanceof ModelListError ? error.status : undefined
  if (status === 401 || status === 403) {
    return apiKey === ''
      ? `这个端点需要 API Key（${status}）：填一把再试；本机服务通常不需要`
      : `认证失败（${status}）：换一把能访问这个端点的 API Key 再试`
  }
  if (status === 404) {
    return '这个端点没有模型清单（/models 不存在）：直接手填模型名'
  }
  return describeProbeError(error, timeoutMs, apiKey)
}

/** 探测的上下文：settings 文件路径 + 密钥读取器（生产 = safeStorage 那条；单测注入假件） */
export interface ProbeProviderInput extends ProbeDeps {
  file: string
  readKey: (providerId: string) => string | null
  providerId: string
}

/**
 * 探一个 provider 的**元数据**（GET /models）并落盘：并入现有 probedModels（其它 provider / 模型的
 * 记录、以及同一条记录里的视觉判定都不动），回合并后的完整设置。失败抛（静默包装负责吞）。
 *
 * 四条口径：
 *   - **只发 GET /models、不发 chat**：这一趟永远不产生推理开销（视觉那趟是另一件事，见
 *     probeProviderVision 的密钥要求）；
 *   - **密钥可以缺**：本机服务（LM Studio / llama.cpp / ollama）就不要密钥。`readKey` 回 null
 *     或空串都照发（不带 Authorization 头）——"没配密钥"不等于"不用探"，否则本机模型永远拿不到
 *     元数据、也永远盖不上 fetchedAt，菜单每次打开都白探一次；
 *   - **只要真问过一趟就盖 fetchedAt**（用户反馈 006）：即使一条元数据都没解析出来（端点不回
 *     context_window、条目形状不认、清单是空的）。"新鲜"说的是"刚问过这个端点"，不是"问出了
 *     元数据"；新鲜期仍是 PROBED_MODELS_TTL_MS（24h）；
 *   - **拿不到就不写**：端点不给 context_window 就只盖时间戳，绝不填一个默认值冒充实测
 *     （消费侧回落注册表，见 shared/models.ts 的 contextWindowSourceOf）。
 */
export async function probeProviderModels(input: ProbeProviderInput): Promise<AppSettings> {
  const current = readSettings(input.file)
  const provider = current.providers.find((candidate) => candidate.id === input.providerId)
  if (provider === undefined) return current

  // 没有 baseUrl（Anthropic 官方域）就没有 /models 可问：本轮不探、也不盖时间戳
  if ((provider.baseUrl?.trim() ?? '') === '') return current

  // 密钥可缺：null（没配过 / 解不开）与空串在这条路上同待遇——不带 Authorization 头发出去
  const apiKey = input.readKey(input.providerId) ?? ''

  const models = await fetchProviderModels(provider, apiKey, input)

  const fetchedAt = (input.now ?? (() => new Date()))().toISOString()
  const probedModels: Record<string, ProbedModel> = { ...current.probedModels }
  for (const [modelId, meta] of Object.entries(models)) {
    const key = probedKeyOf(input.providerId, modelId)
    // 摊平在既有记录上：视觉判定是另一趟写的（round 48），这一趟不该把它抹掉
    probedModels[key] = { ...probedModels[key], ...meta, fetchedAt }
  }

  // 当前模型这一条无论如何都盖上时间戳（清单里没有它 / 它没有元数据也一样）——006 的修复点
  const ownModel = provider.model.trim()
  if (ownModel !== '') {
    const key = probedKeyOf(input.providerId, ownModel)
    probedModels[key] = { ...probedModels[key], fetchedAt }
  }

  return updateSettings(input.file, { probedModels })
}

/**
 * 探测回包 → 结论（纯函数；`null` = **不写**）：
 *   - 2xx：端点收下了这条带图请求 → `true`（能看图）；
 *   - 400 / 415 / 422 且错误体命中"不收图"措辞 → `false`（端点**明确**说它不认图）；
 *   - 同状态码但说的是"你这张图不合法"（`unsupported image` / `invalid image`…）→ `null`：
 *     那是我们这次发的图的问题，不是端点的能力问题；
 *   - 其余一切（401 / 403 / 404 / 429 / 5xx / 别的 4xx）→ `null`：认证、限流、端点不存在都不是
 *     能力问题，写下去就是误标——宁可让消费侧回落注册表，也不把"不知道"当成"不能"。
 */
export function classifyVisionProbe(status: number, body: string): boolean | null {
  if (status >= 200 && status < 300) return true
  const rejected = status === 400 || status === 415 || status === 422
  if (!rejected) return null
  if (VISION_IMAGE_INVALID_PATTERN.test(body)) return null
  return VISION_REJECTION_PATTERN.test(body) ? false : null
}

/** 带图请求的形态：openai 兼容 = content 里的 `image_url` data URL；Anthropic = base64 image block */
function visionRequestOf(
  config: Pick<ProviderConfig, 'type' | 'model' | 'baseUrl'>,
  apiKey: string
): { url: string; init: RequestInit } | null {
  const model = config.model.trim()
  if (model === '') return null

  const content = [
    { type: 'text', text: VISION_PROBE_TEXT },
    config.type === 'anthropic'
      ? {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: VISION_PROBE_PNG_BASE64 }
        }
      : {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${VISION_PROBE_PNG_BASE64}` }
        }
  ]
  // max_tokens 取极小：这一趟只为"收不收图"，不为回答（Anthropic 这一项还是必填）
  const body =
    config.type === 'anthropic'
      ? { model, max_tokens: 1, messages: [{ role: 'user', content }] }
      : { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content }] }

  const configured = config.baseUrl?.trim() ?? ''
  if (config.type === 'anthropic') {
    const baseUrl = configured === '' ? ANTHROPIC_DEFAULT_BASE_URL : configured
    return {
      url: `${baseUrl.replace(/\/+$/, '')}/messages`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 密钥只进这里（x-api-key）；不进日志、不回包
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION
        },
        body: JSON.stringify(body)
      }
    }
  }

  // 没有 baseUrl 就拼不出地址（半截配置）：跳过——这是"探不了"，不是"不能看图"
  if (configured === '') return null
  return {
    url: `${configured.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    }
  }
}

/**
 * 真发一条带图请求，回结论（`null` = 这次问不出结论）。网络错/超时/中断抛——由静默包装吞掉。
 * 回包体**只在主进程里读**，且只用来分类（不回渲染端、不进日志：供应商偶尔会把 key 回显在里面）。
 */
export async function fetchVisionSupport(
  config: Pick<ProviderConfig, 'type' | 'model' | 'baseUrl'>,
  apiKey: string,
  deps: ProbeDeps = {}
): Promise<boolean | null> {
  const request = visionRequestOf(config, apiKey)
  if (request === null) return null

  const fetchImpl = deps.fetchImpl ?? fetch
  const response = await fetchImpl(request.url, {
    ...request.init,
    signal: AbortSignal.timeout(deps.visionTimeoutMs ?? VISION_PROBE_TIMEOUT_MS)
  })
  const body = await response.text().catch(() => '')
  return classifyVisionProbe(response.status, body)
}

/**
 * 探一个 provider 的**视觉能力**并落盘：只探它的当前模型（`provider.model`），结论写进同一条
 * probedModels 记录（`<providerId>:<model>`；同一条记录里的其它字段与别的记录都不动）。
 *
 * **这是唯一一条会真发 chat 请求（带图）的探测**，所以它跟元数据那趟的密钥口径**刻意不同**：
 * 没有密钥就**不发**（原样回当前设置）。本机服务（LM Studio 那类）不需要密钥，若在这里也放行，
 * 用户一存配置/一开菜单就会自动朝本地端点打一条图像推理请求——那是实打实的算力开销，不该由
 * "没配密钥"这个事实悄悄触发。没有密钥时的视觉能力照旧回落注册表（shared/models.ts 的 visionOf），
 * 不把"没探过"当成"不能看图"。失败抛。
 */
export async function probeProviderVision(input: ProbeProviderInput): Promise<AppSettings> {
  const current = readSettings(input.file)
  const provider = current.providers.find((candidate) => candidate.id === input.providerId)
  if (provider === undefined) return current

  const apiKey = input.readKey(input.providerId)
  if (apiKey === null || apiKey === '') return current

  const vision = await fetchVisionSupport(provider, apiKey, input)
  if (vision === null) return current

  const key = probedKeyOf(input.providerId, provider.model)
  const probedModels: Record<string, ProbedModel> = {
    ...current.probedModels,
    [key]: { ...current.probedModels[key], vision }
  }
  return updateSettings(input.file, { probedModels })
}

/** 同一 provider 的视觉探测并发去重（键 = 设置文件 + provider；跑完自清） */
const visionProbesInFlight = new Map<string, Promise<AppSettings>>()

/**
 * 视觉探测的静默版 + **并发去重**：同一 provider 同时只真发一趟带图请求，后来的直接搭前一趟的车
 * （这是会真花钱的 chat 请求，而"保存 + 连接测试 + 菜单刷新"撞在一起是常态）。
 * 失败只记日志，回当前设置（可能没变）。
 */
export async function probeProviderVisionQuietly(input: ProbeProviderInput): Promise<AppSettings> {
  const key = `${input.file}\u0000${input.providerId}`
  const running = visionProbesInFlight.get(key)
  if (running !== undefined) return running

  // 只可能在"没有在飞的那趟"时写入，跑完即摘（无需比对身份）
  const task = probeProviderVision(input)
    .catch((error: unknown) => {
      console.warn(`[kyclaw] 视觉能力探测失败（provider=${input.providerId}，不影响使用）`, error)
      return readSettings(input.file)
    })
    .finally(() => {
      visionProbesInFlight.delete(key)
    })
  visionProbesInFlight.set(key, task)
  return task
}

/**
 * **静默组合入口**（触发方用的就是它）：先元数据（GET /models）、后视觉（带图 chat），
 * 两趟都绝不抛——失败只记日志，回当前设置（可能没变）。探测是"尽力拿真实值"，不挡保存/测试/菜单/启动。
 *
 * 两趟的密钥口径不同（刻意）：**元数据那趟无密钥也跑**（本机服务；只发 GET，不产生推理开销），
 * **视觉那趟无密钥直接跳过**（它会真发一条带图 chat，不该被"没配密钥"自动触发）。
 */
export async function probeProviderModelsQuietly(input: ProbeProviderInput): Promise<AppSettings> {
  try {
    await probeProviderModels(input)
  } catch (error) {
    console.warn(`[kyclaw] 模型元数据探测失败（provider=${input.providerId}，不影响使用）`, error)
  }
  return probeProviderVisionQuietly(input)
}

/** 启动时跑一轮：对每个已配置 provider 各探一次（元数据 + 视觉；后台、静默；串行避免一起打端点） */
export async function probeConfiguredProvidersQuietly(input: {
  file: string
  readKey: (providerId: string) => string | null
  deps?: ProbeDeps
}): Promise<void> {
  const providers = readSettings(input.file).providers
  for (const provider of providers) {
    await probeProviderModelsQuietly({
      file: input.file,
      readKey: input.readKey,
      providerId: provider.id,
      ...input.deps
    })
  }
}
