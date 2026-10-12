/**
 * 模型能力探测（round 22 起；视觉 round 48 补）——两趟请求，各写 `settings.probedModels` 的字段
 * （键 `<providerId>:<modelId>`，与消费侧同一个 `probedKeyOf`）：
 *
 *   ① `GET {baseUrl}/models`（Bearer key）取**元数据实测值**：上下文长度（context_window）、
 *      最大输出（max_output_tokens）、思考挡位（effort.supported_levels / default_level）。
 *      为什么：round 18 的注册表按模型名**猜**（deepseek-flash 写 128K），官方端点实测是 1M。
 *   ② **一条真发图片的最小非流式 chat 请求**（round 48）取**视觉能力**：端点收下了 → `vision: true`；
 *      明确拒图（400/415/422 且错误体点名 image/vision/modality）→ `vision: false`；
 *      其余（401/403/429/超时/网络/5xx）→ **不写**（不知道就不标，绝不误判成"不能看图"）。
 *      为什么：用户点名的"注册模型后自动探测多模态，不存在'有但我不开'"——手动开关整个删掉了。
 *
 * 纪律：
 *   - **尽力而为、静默失败**：探测失败只 `console.warn`（不抛、不挡保存/测试连接/菜单/启动）；
 *   - **密钥不出主进程**：只进 Authorization / x-api-key 头；日志与回包永不含 key（错误文案只写状态码）；
 *   - 超时：元数据 5s、视觉 10s（自带 AbortSignal.timeout），不重试（下一次触发自然会重试）；
 *   - 解析逐项防御：条目没有有效 context_window 就跳过（拿不到分母的模型不入库）；
 *     efforts 缺省 = 回落注册表；`default_level` 不在 supported_levels 里 = 不采信；
 *   - **只探 provider 的当前模型**（`provider.model`）；没有密钥的一律跳过；
 *   - 视觉那趟在**同一 provider 内去重**（同时只跑一趟，后面的搭车）——它是会真花钱的 chat 请求。
 *   - Anthropic 的元数据这趟没有 baseUrl（走官方默认域）→ 自然跳过；视觉那趟照探（官方域 + 官方协议）。
 *
 * 触发（四处，全在 main 侧或经 IPC，与 round 22 同址）：①连接测试成功后（渲染端走 settings:probe-models）；
 * ②provider/key 保存后（settings:update 里后台跑；渲染端写密钥成功后也补一发）；
 * ③应用启动时（main/index.ts 后台跑）；④模型菜单打开且缓存过期 >24h（渲染端经 settings:probe-models 触发）。
 */
import type { AppSettings, ProbedModel } from '../shared/settings'
import { probedKeyOf, type ProbedModelSpec } from '../shared/models'
import type { ProviderConfig } from '../shared/providers'
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
 * `GET /models` 的回包 → `{ [modelId]: 元数据 }`（纯函数）。
 * 容忍三种数组形态与缺字段：没有有效 context_window 的条目**整条跳过**（拿不到分母）；
 * effort 不是对象 / supported_levels 非法 → 该字段缺省；default_level 必须在 supported_levels 里。
 */
export function parseModelsPayload(payload: unknown): Record<string, ParsedModelMeta> {
  const models: Record<string, ParsedModelMeta> = {}
  for (const entry of entriesOf(payload)) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    const contextWindow = positiveInt(entry.context_window)
    if (contextWindow === undefined) continue

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
    models[id] = meta
  }
  return models
}

/**
 * 抓一个 provider 的模型清单（成功回 `{ [modelId]: 元数据 }`；失败抛——调用方决定吞不吞）。
 * 没有 baseUrl（Anthropic 官方域）→ 直接回空表（本轮不探）。
 */
export async function fetchProviderModels(
  config: Pick<ProviderConfig, 'type' | 'baseUrl'>,
  apiKey: string,
  deps: ProbeDeps = {}
): Promise<Record<string, ParsedModelMeta>> {
  const baseUrl = config.baseUrl?.trim() ?? ''
  if (baseUrl === '') return {}

  const fetchImpl = deps.fetchImpl ?? fetch
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`模型清单请求失败（${response.status}）`)
  }
  return parseModelsPayload(await response.json())
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
 */
export async function probeProviderModels(input: ProbeProviderInput): Promise<AppSettings> {
  const current = readSettings(input.file)
  const provider = current.providers.find((candidate) => candidate.id === input.providerId)
  if (provider === undefined) return current

  const apiKey = input.readKey(input.providerId)
  if (apiKey === null || apiKey === '') return current

  const models = await fetchProviderModels(provider, apiKey, input)
  if (Object.keys(models).length === 0) return current

  const fetchedAt = (input.now ?? (() => new Date()))().toISOString()
  const probedModels: Record<string, ProbedModel> = { ...current.probedModels }
  for (const [modelId, meta] of Object.entries(models)) {
    const key = probedKeyOf(input.providerId, modelId)
    // 摊平在既有记录上：视觉判定是另一趟写的（round 48），这一趟不该把它抹掉
    probedModels[key] = { ...probedModels[key], ...meta, fetchedAt }
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
 * 没有密钥 / 没有模型名 / （openai 兼容）没有 baseUrl → 原样回当前设置，不发请求。失败抛。
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
