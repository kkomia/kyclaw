/**
 * 模型注册表（round 18）：模型名 → 上下文长度与思考挡位；注册 provider 时按名字**尽力探测**
 * （没有公开元数据可查，以本表为准；未知模型给保守默认，不假装知道）。
 *
 * 口径：
 *   - 匹配用「归一后的模型名前缀」（小写、去 `provider/` 前缀）——与 usage.ts 的 pricingFor 同口径；
 *   - `thinkingEfforts` 的 id 就是**要透传给供应商的值**（如 `low`/`high`/`max`），`default` 表示不传；
 *     能不能真透传由适配器决定（见 shared/providers.ts 的 `providerOptionsKeyFor`）：
 *     DeepSeek 官方端点支持 `reasoning_effort: low|high|max`（@ai-sdk/deepseek 的 provider options），
 *     openai 兼容家族原样透传字符串；Anthropic 本轮不接（如实只给「默认」档）。
 *   - `contextWindow` 是**官方上下文长度**（对话长度滑块的 100%）；10% 起步。
 */
import type { ProviderConfig } from './providers'
import { isDeepSeekBaseUrl, OPENAI_COMPATIBLE_PROVIDER_NAME } from './providers'

export interface ThinkingEffortSpec {
  /** 透传给供应商的值；`default` = 不传（走端点默认） */
  id: string
  label: string
}

export interface ModelSpec {
  /** 官方上下文长度（tokens） */
  contextWindow: number
  /** 可用思考挡位（至少一档「默认」；顺序即展示顺序） */
  thinkingEfforts: readonly ThinkingEffortSpec[]
}

/** 未知模型 / 不暴露元数据时的保守默认 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

const DEFAULT_ONLY: readonly ThinkingEffortSpec[] = [{ id: 'default', label: '默认' }]

const V4_EFFORTS: readonly ThinkingEffortSpec[] = [
  { id: 'default', label: '默认' },
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' }
]

/** 注册表：按顺序取第一个命中的前缀（更具体的写在前面） */
const REGISTRY: ReadonlyArray<{ prefix: string; spec: ModelSpec }> = [
  // DeepSeek V4 家族：官方 SDK 明确支持 reasoning_effort(low|high|max)；Pro 是 1M 档
  { prefix: 'deepseek-v4-pro', spec: { contextWindow: 1_000_000, thinkingEfforts: V4_EFFORTS } },
  {
    prefix: 'deepseek-v4-flash',
    spec: { contextWindow: 128_000, thinkingEfforts: V4_EFFORTS }
  },
  // 现行 Flash（官方脚注：遗留名 deepseek-v4-flash 由它承载）
  { prefix: 'deepseek-flash', spec: { contextWindow: 128_000, thinkingEfforts: V4_EFFORTS } },
  // 上一代：不暴露思考挡位 → 如实「默认」单档
  { prefix: 'deepseek-chat', spec: { contextWindow: 128_000, thinkingEfforts: DEFAULT_ONLY } },
  { prefix: 'deepseek-reasoner', spec: { contextWindow: 128_000, thinkingEfforts: DEFAULT_ONLY } }
]

/** 模型名归一：小写、去空白、去 `provider/` 前缀（与 pricingFor 同口径） */
export function normalizeModelId(model: string | null | undefined): string {
  if (typeof model !== 'string') return ''
  const normalized = model.trim().toLowerCase()
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** 模型 → 规格（未知模型给保守默认，不抛） */
export function modelSpecOf(model: string | null | undefined): ModelSpec {
  const bare = normalizeModelId(model)
  const entry = REGISTRY.find((candidate) => bare.startsWith(candidate.prefix))
  return entry?.spec ?? { contextWindow: DEFAULT_CONTEXT_WINDOW, thinkingEfforts: DEFAULT_ONLY }
}

/** 该模型的思考挡位（至少一档） */
export function thinkingEffortsOf(model: string | null | undefined): readonly ThinkingEffortSpec[] {
  return modelSpecOf(model).thinkingEfforts
}

/** 该模型的官方上下文长度 */
export function contextWindowOf(model: string | null | undefined): number {
  return modelSpecOf(model).contextWindow
}

/** 对话长度百分比 → tokens（夹到 10–100、取整） */
export function contextTokensFor(
  model: string | null | undefined,
  pct: number | undefined
): number {
  const clamped = Math.min(100, Math.max(10, Math.round(pct ?? 100)))
  return Math.round((modelSpecOf(model).contextWindow * clamped) / 100)
}

/** 挡位 id 在当前模型下是否可用（不在列表 → 回落 `default`） */
export function effectiveEffortId(
  model: string | null | undefined,
  effortId: string | undefined
): string {
  if (typeof effortId !== 'string' || effortId === '') return 'default'
  return thinkingEffortsOf(model).some((effort) => effort.id === effortId) ? effortId : 'default'
}

/** token 数 → 人话（`51K` / `1M`；给滑块与用量浮层用） */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1))}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(Math.max(0, Math.round(tokens)))
}

/**
 * 思考挡位要不要真透传、怎么透传（round 18）：
 *   - `default` / 空 → 不传；
 *   - DeepSeek 官方端点（baseUrl 命中官方主机）→ providerOptions `{ deepseek: { reasoningEffort } }`
 *     （@ai-sdk/deepseek 的 schema 是 low|high|max）；
 *   - 其余 openai 兼容家族 → `{ 'kyclaw-openai-compatible': { reasoningEffort } }`（字符串原样，端点认不认由端点决定）；
 *   - Anthropic → 本轮不接，返回 null（如实：仅保存与显示）。
 */
export function requestProviderOptions(
  provider: Pick<ProviderConfig, 'type' | 'model' | 'baseUrl'>,
  effortId: string | undefined
): Record<string, Record<string, unknown>> | null {
  const effort = effectiveEffortId(provider.model, effortId)
  if (effort === 'default') return null
  if (provider.type === 'anthropic') return null
  const key = isDeepSeekBaseUrl(provider.baseUrl) ? 'deepseek' : OPENAI_COMPATIBLE_PROVIDER_NAME
  return { [key]: { reasoningEffort: effort } }
}
