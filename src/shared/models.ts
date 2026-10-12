/**
 * 模型注册表（round 18；round 22 起**实测优先**）：模型名 → 上下文长度与思考挡位。
 *
 * 口径（round 22 更新；round 46 补视觉）：
 *   - **取值优先级：probed（实测，settings.probedModels）→ 注册表 → 保守默认**——
 *     round 18 按名字猜的 deepseek-flash=128K 是臆测，官方端点实测是 1M（1048576）；
 *     每个取数函数都接受可选的 `probed` 参数按字段覆盖（probed 没给的字段才回落注册表）；
 *   - **视觉能力（模块 2）也在 probed 里**（round 46）：主进程真发一条带图请求探测出来的结论
 *     （见 main/model-probe.ts），没有探测结论时才回落注册表——用户不再有手动开关；
 *   - 匹配用「归一后的模型名前缀」（小写、去 `provider/` 前缀）——与 usage.ts 的 pricingFor 同口径；
 *   - `thinkingEfforts` 的 id 就是**要透传给供应商的值**（如 `low`/`high`/`max`），`default` 表示不传；
 *     能不能真透传由适配器决定（见 shared/providers.ts 的 `providerOptionsKeyFor`）：
 *     DeepSeek 官方端点支持 `reasoning_effort: low|high|max`（@ai-sdk/deepseek 的 provider options），
 *     openai 兼容家族原样透传字符串；Anthropic 本轮不接（如实只给「默认」档）。
 *   - `contextWindow` 是对话长度滑块的 100%（10% 起步）；`defaultEffort` 是端点默认档
 *     （probed 的 `effort.default_level`，如 deepseek-flash 的 `high`）——用户没选过就用它。
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
  /**
   * 端点默认挡位（round 22：probed 的 `effort.default_level`；没有 = `default`）。
   * 用户没显式选过挡位时，effectiveEffortId 回落它——UI 显示与透传同值。
   */
  defaultEffort: string
  /**
   * 能不能看图（模块 2）：**只有明确知道才写** —— 注册表里标了的用它，没标的按 false 保守处理。
   * round 46 起这只是"回落值"：真实能力由探测（真发一条带图请求）说了算，见 visionOf。
   */
  vision?: boolean
}

/**
 * 探测到的模型实测值（round 22；视觉判定 round 46 合住同一条记录，键 = `<providerId>:<modelId>`）。
 * 字段按端点给多少存多少：两个来源各写各的字段，谁都没给的可选。
 */
export interface ProbedModelSpec {
  /** 实测上下文长度（如 deepseek-flash = 1048576；只探出视觉时没有这一项） */
  contextWindow?: number
  /** 实测最大输出（暂未参与 UI，如实存档） */
  maxOutputTokens?: number
  /** 实测思考挡位（原样值，如 ['low','high','max']；没有 = 回落注册表） */
  efforts?: string[]
  /** 实测默认挡位（如 'high'；没有 = `default`） */
  defaultEffort?: string
  /**
   * 视觉能力实测（round 46）：主进程真发一条带图请求得到的结论——
   * `true` 收下了 / `false` 端点明确拒图；**没有** = 这次探不出结论（认证/限流/超时…），
   * 消费侧回落注册表（见 visionOf），绝不把"不知道"当成"不能"。
   */
  vision?: boolean
  /** ISO 时间串（`GET /models` 那一趟的抓取时刻；渲染端用它判过期 >24h。只有视觉判定时没有） */
  fetchedAt?: string
}

/** 探测记录的过期时长（超过它，模型菜单打开时后台重抓） */
export const PROBED_MODELS_TTL_MS = 24 * 60 * 60 * 1000

/** 探测记录的键：`<providerId>:<modelId>`（provider 的模型名原文，不归一） */
export function probedKeyOf(providerId: string, model: string): string {
  return `${providerId}:${model}`
}

/**
 * 探测记录是否新鲜（**元数据**那一趟；没有记录 / 没有时间戳 / 时间戳解析不了 = 过期）。
 * 渲染端据此在菜单打开时触发刷新——只探出视觉（没有 fetchedAt）不算新鲜，元数据仍要补。
 */
export function isProbedFresh(
  probed: ProbedModelSpec | undefined,
  now: number = Date.now()
): boolean {
  if (probed === undefined || probed.fetchedAt === undefined) return false
  const at = Date.parse(probed.fetchedAt)
  if (Number.isNaN(at)) return false
  return now - at <= PROBED_MODELS_TTL_MS
}

/** 挡位 id → 中文标签（round 18 的既有映射；未知挡位原样显示——如实） */
const EFFORT_LABELS: Record<string, string> = {
  default: '默认',
  low: '低',
  high: '高',
  max: '最高'
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

/** 注册表：按顺序取第一个命中的前缀（更具体的写在前面）。
 *  round 22 起这只是**回落值**：探测到真实元数据（probedModels）时以实测为准——
 *  round 18 把 deepseek-flash 写 128K 是臆测，官方端点实测是 1M（context_window=1048576）。 */
const REGISTRY: ReadonlyArray<{ prefix: string; spec: ModelSpec }> = [
  // DeepSeek V4 家族：官方 SDK 明确支持 reasoning_effort(low|high|max)；
  // 视觉（模块 2）：**全系 false** —— DeepSeek 官方接口不收图片（如实标，不猜也不留空）
  {
    prefix: 'deepseek-v4-pro',
    spec: {
      contextWindow: 1_000_000,
      thinkingEfforts: V4_EFFORTS,
      defaultEffort: 'default',
      vision: false
    }
  },
  {
    prefix: 'deepseek-v4-flash',
    spec: {
      contextWindow: 128_000,
      thinkingEfforts: V4_EFFORTS,
      defaultEffort: 'default',
      vision: false
    }
  },
  // 现行 Flash（官方脚注：遗留名 deepseek-v4-flash 由它承载）
  {
    prefix: 'deepseek-flash',
    spec: {
      contextWindow: 128_000,
      thinkingEfforts: V4_EFFORTS,
      defaultEffort: 'default',
      vision: false
    }
  },
  // 上一代：不暴露思考挡位 → 如实「默认」单档
  {
    prefix: 'deepseek-chat',
    spec: {
      contextWindow: 128_000,
      thinkingEfforts: DEFAULT_ONLY,
      defaultEffort: 'default',
      vision: false
    }
  },
  {
    prefix: 'deepseek-reasoner',
    spec: {
      contextWindow: 128_000,
      thinkingEfforts: DEFAULT_ONLY,
      defaultEffort: 'default',
      vision: false
    }
  }
]

/** 模型名归一：小写、去空白、去 `provider/` 前缀（与 pricingFor 同口径） */
export function normalizeModelId(model: string | null | undefined): string {
  if (typeof model !== 'string') return ''
  const normalized = model.trim().toLowerCase()
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** 模型 → 规格（round 22 优先级：**probed 实测 → 注册表 → 保守默认**，不抛） */
export function modelSpecOf(model: string | null | undefined, probed?: ProbedModelSpec): ModelSpec {
  const fallback = registrySpecOf(model)
  if (probed === undefined) return fallback

  // 上下文长度：实测有效（正整数）才覆盖注册表
  const contextWindow =
    typeof probed.contextWindow === 'number' &&
    Number.isFinite(probed.contextWindow) &&
    probed.contextWindow > 0
      ? Math.round(probed.contextWindow)
      : fallback.contextWindow

  // 思考挡位：实测给了非空挡位表才覆盖（表内剔除 `default`——那是"不传"的本地语义，
  // 统一放列表首个；顺序照端点；未知挡位标签原样显示，如实）
  const levels = (probed.efforts ?? []).filter(
    (level) => typeof level === 'string' && level.trim() !== '' && level !== 'default'
  )
  const thinkingEfforts: readonly ThinkingEffortSpec[] =
    levels.length === 0
      ? fallback.thinkingEfforts
      : [
          { id: 'default', label: EFFORT_LABELS.default ?? '默认' },
          ...levels.map((level) => ({ id: level, label: EFFORT_LABELS[level] ?? level }))
        ]

  const defaultEffort =
    typeof probed.defaultEffort === 'string' &&
    thinkingEfforts.some((effort) => effort.id === probed.defaultEffort)
      ? probed.defaultEffort
      : 'default'

  // 视觉：探测结论（round 46）压过注册表；没探出来才回落注册表那层
  const vision = typeof probed.vision === 'boolean' ? probed.vision : fallback.vision

  return { contextWindow, thinkingEfforts, defaultEffort, vision }
}

/** 注册表（不含探测）的规格：probed 缺某字段时按字段回落的那一层 */
function registrySpecOf(model: string | null | undefined): ModelSpec {
  const bare = normalizeModelId(model)
  const entry = REGISTRY.find((candidate) => bare.startsWith(candidate.prefix))
  return (
    entry?.spec ?? {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      thinkingEfforts: DEFAULT_ONLY,
      defaultEffort: 'default',
      vision: false
    }
  )
}

/**
 * 这个模型能不能看图（模块 2）。生效口径（round 46）：**探测结论 > 注册表 > false（保守）**。
 *
 * `probed` 就是 settings.probedModels 里这一条（键 `<providerId>:<model>`，见 probedKeyOf）：
 *   - `vision === true`  → 能看图（端点真收下过带图请求）；
 *   - `vision === false` → 不能（端点明确拒图）；
 *   - **没有这个字段** → 还没探出结论（认证/限流/超时…），回落注册表；注册表没标的按 false 保守处理。
 * 没有手动开关：能力只认"真发过图片"的实测结论，用户不必也不该替端点声明。
 */
export function visionOf(
  model: string | null | undefined,
  probed?: { vision?: boolean } | undefined
): boolean {
  if (probed?.vision !== undefined) return probed.vision
  return registrySpecOf(model).vision === true
}

/** 该模型的思考挡位（至少一档；probed 实测优先） */
export function thinkingEffortsOf(
  model: string | null | undefined,
  probed?: ProbedModelSpec
): readonly ThinkingEffortSpec[] {
  return modelSpecOf(model, probed).thinkingEfforts
}

/** 该模型的上下文长度（probed 实测优先） */
export function contextWindowOf(
  model: string | null | undefined,
  probed?: ProbedModelSpec
): number {
  return modelSpecOf(model, probed).contextWindow
}

/** 对话长度百分比 → tokens（夹到 10–100、取整；probed 实测优先） */
export function contextTokensFor(
  model: string | null | undefined,
  pct: number | undefined,
  probed?: ProbedModelSpec
): number {
  const clamped = Math.min(100, Math.max(10, Math.round(pct ?? 100)))
  return Math.round((modelSpecOf(model, probed).contextWindow * clamped) / 100)
}

/**
 * 挡位 id 在当前模型下是否可用：
 *   - 显式选了列表里的挡位 → 用它；
 *   - 没选 / 选了不存在的 → 回落**端点默认档**（probed 的 default_level，没有才是 `default`）。
 */
export function effectiveEffortId(
  model: string | null | undefined,
  effortId: string | undefined,
  probed?: ProbedModelSpec
): string {
  const spec = modelSpecOf(model, probed)
  if (typeof effortId === 'string' && effortId !== '') {
    if (spec.thinkingEfforts.some((effort) => effort.id === effortId)) return effortId
  }
  return spec.defaultEffort
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
 * 思考挡位要不要真透传、怎么透传（round 18；round 22 起挡位取自 probed 实测优先）：
 *   - `default` / 空 → 不传；
 *   - DeepSeek 官方端点（baseUrl 命中官方主机）→ providerOptions `{ deepseek: { reasoningEffort } }`
 *     （@ai-sdk/deepseek 的 schema 是 low|high|max）；
 *   - 其余 openai 兼容家族 → `{ 'kyclaw-openai-compatible': { reasoningEffort } }`（字符串原样，端点认不认由端点决定）；
 *   - Anthropic → 本轮不接，返回 null（如实：仅保存与显示）。
 * 用户没显式选挡位时用端点默认档（probed default_level，如 deepseek-flash 的 `high`）——显示与透传同值。
 */
export function requestProviderOptions(
  provider: Pick<ProviderConfig, 'type' | 'model' | 'baseUrl'>,
  effortId: string | undefined,
  probed?: ProbedModelSpec
): Record<string, Record<string, unknown>> | null {
  const effort = effectiveEffortId(provider.model, effortId, probed)
  if (effort === 'default') return null
  if (provider.type === 'anthropic') return null
  const key = isDeepSeekBaseUrl(provider.baseUrl) ? 'deepseek' : OPENAI_COMPATIBLE_PROVIDER_NAME
  return { [key]: { reasoningEffort: effort } }
}
