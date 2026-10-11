/**
 * 模型元数据探测（round 22）：`GET {baseUrl}/models`（Bearer key）取**实测值**——
 * 上下文长度（context_window）、最大输出（max_output_tokens）、思考挡位
 * （effort.supported_levels / default_level），落 settings.probedModels，键 `<providerId>:<modelId>`。
 *
 * 为什么：round 18 的注册表按模型名**猜**（deepseek-flash 写 128K），官方端点实测是 1M
 * （context_window = 1048576）——用户点名的"要按 API 服务自动获取真实值"。
 *
 * 纪律：
 *   - **尽力而为、静默失败**：探测失败只 `console.warn`（不抛、不挡保存/测试连接/菜单）；
 *   - **密钥不出主进程**：只进 Authorization 头；日志与回包永不含 key（错误文案只写状态码）；
 *   - 超时 5s（自带 AbortSignal.timeout），不重试（下一次触发自然会重试）；
 *   - 解析逐项防御：条目没有有效 context_window 就跳过（拿不到分母的模型不入库）；
 *     efforts 缺省 = 回落注册表；`default_level` 不在 supported_levels 里 = 不采信；
 *   - Anthropic 无 baseUrl（走官方默认域）时自然跳过——本轮如实只探 openai 兼容端点。
 *
 * 触发（四处，全在 main 侧或经 IPC）：①连接测试成功后（渲染端走 settings:probe-models）；
 * ②provider 保存后（settings:update 里后台跑）；③应用启动时（main/index.ts 后台跑）；
 * ④模型菜单打开且缓存过期 >24h（渲染端经 settings:probe-models 触发）。
 */
import type { AppSettings, ProbedModel } from '../shared/settings'
import { probedKeyOf, type ProbedModelSpec } from '../shared/models'
import type { ProviderConfig } from '../shared/providers'
import { readSettings, updateSettings } from './settings'

/** 探测超时（网络掐住不该拖着保存/启动流程） */
export const PROBE_TIMEOUT_MS = 5_000

/** 解析出来的一条实测元数据（还没有 fetchedAt；落库时才盖时间戳） */
export type ParsedModelMeta = Omit<ProbedModelSpec, 'fetchedAt'>

/** 触发方要的依赖：全部可注入（单测不碰 electron / 真网络） */
export interface ProbeDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
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
 * 探一个 provider 并**落盘**：并入现有 probedModels（其它 provider/模型的记录不动），
 * 回合并后的完整设置。失败抛（打包函数 `probeProviderModelsQuietly` 负责吞）。
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
    probedModels[probedKeyOf(input.providerId, modelId)] = { ...meta, fetchedAt }
  }
  return updateSettings(input.file, { probedModels })
}

/** 静默版：失败只记日志（不挡调用方），回当前设置（可能没变） */
export async function probeProviderModelsQuietly(input: ProbeProviderInput): Promise<AppSettings> {
  try {
    return await probeProviderModels(input)
  } catch (error) {
    console.warn(`[kyclaw] 模型元数据探测失败（provider=${input.providerId}，不影响使用）`, error)
    return readSettings(input.file)
  }
}

/** 启动时跑一轮：对每个已配置 provider 各探一次（后台、静默；串行避免一起打端点） */
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
