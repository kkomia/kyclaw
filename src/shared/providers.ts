/**
 * Provider（模型通道）配置：设置页、落盘（settings.providers）、模型解析三处共用一份 schema 与措辞。
 *
 * 两条纪律：
 *   1. **半截配置是"合法存档、非法可用"**——schema 收下它（不然读设置会把整份文件当坏文件丢回默认，
 *      用户录到一半的设置也没了），缺什么由 `providerConfigProblems` 报；
 *   2. **密钥是可选项，除 anthropic 外**（`providerKeyOptional`）：本机 / 自建端点的
 *      openai-compatible 渠道不带密钥也照发；报错措辞只有这一处（"配置不完整：缺 X"）：
 *      设置页里显示的就是模型解析抛的同一句话，不允许静默回落 mock。
 *
 * 密钥不在这里：ProviderConfig 只描述"连哪儿、用什么模型"，key 由 main/secrets.ts 按 `id` 存。
 */
import { z } from './zod'

/** 通道类型：openai-compatible（DeepSeek/Kimi/OpenAI/自建网关）与 anthropic 两家协议 */
export const providerTypeSchema = z.enum(['openai-compatible', 'anthropic'])

export type ProviderType = z.infer<typeof providerTypeSchema>

/**
 * 一条 provider 配置。`baseUrl` 只有 openai-compatible 需要（anthropic 走官方端点），
 * `model`/`baseUrl` 允许空——"还没填完"是用户真实会处在的状态（缺什么见 providerConfigProblems）。
 *
 * 用户反馈 001（同一端点多个模型）与 002（自定义渠道名）都靠**两个新的可选字段**表达：
 *   - `models`：这条端点**已注册的模型清单**（缺字段 = 只有 `model` 这一个，见 registeredModelsOf）。
 *     `model` 的语义**不变**：它始终是"当前选中的那个 API 模型名"（发送与探测只认它）；
 *   - `name`：渠道显示名（缺省按 id 猜，见 providerLabel）。**纯展示**：不进密钥、不进请求。
 * 两者都可选 ⇒ 老落盘文件（没有这两个键）照样合法，读盘迁移不必补空。
 */
export const providerConfigSchema = z.strictObject({
  id: z.string().min(1),
  type: providerTypeSchema,
  baseUrl: z.string().optional(),
  /** 002：渠道显示名（界面显示用；缺省 = 预设名 / `自定义 N` / id 原文） */
  name: z.string().optional(),
  /** 当前选中的 API 模型名（发送、探测、`<providerId>:<model>` 的键都用它） */
  model: z.string(),
  /** 001：这条端点已注册的模型清单（缺字段 / 空 = 只有 `model` 这一个） */
  models: z.array(z.string()).optional(),
  isDefault: z.boolean()
})

export type ProviderConfig = z.infer<typeof providerConfigSchema>

/**
 * 一条 provider 的密钥状态（IPC 只回这个形状，永远不带明文）：
 * needsReentry = 存过密钥但这台机器解不开（换机/迁移/系统账户变了），UI 引导重录。
 */
export const providerKeyStateSchema = z.strictObject({
  hasKey: z.boolean(),
  needsReentry: z.boolean()
})

export type ProviderKeyState = z.infer<typeof providerKeyStateSchema>

/** "没配过密钥"（注意：这不是 needsReentry——没配过不需要引导重录） */
export const NO_KEY: ProviderKeyState = { hasKey: false, needsReentry: false }

/** 预置通道：设置页一键添加（model 缺省值可改，用户自己的部署/网关走"自定义"） */
export interface ProviderPreset {
  id: string
  label: string
  type: ProviderType
  baseUrl?: string
  defaultModel: string
}

/**
 * 预设的 baseUrl / 模型：
 * - DeepSeek 走官方端点 https://api.deepseek.com（本任务裁决）；
 * - Moonshot Kimi 用官方文档的 https://api.moonshot.cn/v1 与 kimi-k3（2026-10 文档口径）；
 * - OpenAI / Anthropic 用保守的通用默认（可改；模型 id 会随时间变，预设只是起点）。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash'
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    defaultModel: 'claude-sonnet-4-5'
  }
]

export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}

/**
 * 列表里显示的名字（002）：手填的渠道名优先，其余按 id 猜——预设用预设名，自定义用序号，手写 id 原样
 * （密钥按 id 存，所以 id 就是身份；`name` 只是显示，改名不影响任何存下来的东西）。
 */
export function providerLabel(config: ProviderConfig): string {
  const custom = config.name?.trim()
  if (custom !== undefined && custom !== '') return custom
  const preset = providerPreset(config.id)
  if (preset) return preset.label
  const matched = /^custom-(\d+)$/.exec(config.id)
  return matched ? `自定义 ${matched[1]}` : config.id
}

/**
 * 这条通道现在注册了哪些模型（001）。
 *   - `models` 缺字段 / 空清单 = 只有当前这一个（老配置、单模型通道都是这样）；
 *   - 显式列了清单就以它为准（去重、去空、按清单顺序），但**当前选中的 `model` 一定在内**——
 *     它可能刚被手改过、还没并进清单（设置页里改模型名就是这么个中间态）；
 *   - 半截配置（模型名空、清单也空）回 `['']`：调用方按"通道名"兜底显示，别把它当模型名用。
 */
export function registeredModelsOf(config: Pick<ProviderConfig, 'model' | 'models'>): string[] {
  const current = config.model.trim()
  const listed = [...new Set((config.models ?? []).map((model) => model.trim()))].filter(
    (model) => model !== ''
  )
  if (listed.length === 0) return [current]
  if (current === '' || listed.includes(current)) return listed
  return [current, ...listed]
}

/**
 * 往这条端点**加一个模型并选中它**（001 的"给端点加模型"）：清单去重追加、`model` 写回新模型。
 * `isDefault` 不动——"默认通道"与"这个通道当前用哪个模型"是两件事，加一个模型不该悄悄换掉默认通道。
 */
export function withRegisteredModel(config: ProviderConfig, model: string): ProviderConfig {
  const next = model.trim()
  if (next === '') return config
  const listed = registeredModelsOf(config).filter((entry) => entry !== '')
  return {
    ...config,
    model: next,
    models: listed.includes(next) ? listed : [...listed, next]
  }
}

/** baseUrl 归一（比对用）：去空白、去尾斜杠、小写（`https://x/v1/` 与 `https://X/v1` 是同一条端点） */
function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * 哪条 provider 已经是这个端点（001：同一条 baseUrl 配第二个模型 = **往它加**，不新建 provider、
 * 不再要一把 key）。只认 openai-compatible（anthropic 走官方端点、没有 baseUrl）；空 baseUrl 不算。
 */
export function providerWithBaseUrl(
  existing: readonly ProviderConfig[],
  baseUrl: string
): ProviderConfig | undefined {
  const target = normalizeBaseUrl(baseUrl)
  if (target === '') return undefined
  return existing.find(
    (provider) =>
      provider.type === 'openai-compatible' && normalizeBaseUrl(provider.baseUrl) === target
  )
}

/** 「缺 API 密钥」那一句（只有"必须有密钥"的渠道才会报它） */
export const MISSING_KEY_PROBLEM = '配置不完整：缺 API 密钥'

/**
 * 预置渠道用到的**云主机**（永远要认证的那些）：从预置表推出来，加/改预置时不会忘。
 * 这些地址没有密钥一定是"还没填完"，提前报"缺 API 密钥"比放到请求前让 SDK 抛错更好懂。
 */
const PRESET_HOSTS: ReadonlySet<string> = new Set(
  PROVIDER_PRESETS.flatMap((preset) => {
    if (preset.baseUrl === undefined) return []
    try {
      return [new URL(preset.baseUrl).hostname]
    } catch {
      return []
    }
  })
)

/**
 * 这条渠道**没有密钥能不能用**（打包态实报：LM Studio 那类本机服务不校验密钥，却被"缺 API 密钥"
 * 挡在门外，连测试连接都到不了端点）：
 *   - **非官方云主机**的 openai-compatible 端点 —— **能**：本机推理 / 内网 / 自建网关多半不要密钥，
 *     而且密钥为空时我们**不传 `apiKey` 字段**，SDK 也就**不发 Authorization 头**
 *     （不是发一个空 Bearer——那反倒会被某些网关当"无效凭据"直接 401）。真要认证就让**服务端**回
 *     401/403，界面照它说"认证失败"，比在本地提前拦一句更有信息量；
 *   - **官方云主机**（DeepSeek / Moonshot / OpenAI 预置用的那三个）—— 原口径不变：那里没有密钥
 *     就是没填完，提前报"配置不完整：缺 API 密钥"，聊天错误卡也还是那句 400 的人话；
 *   - `anthropic` —— 原口径不变：官方 SDK 的 `x-api-key` 是必填的。
 */
export function providerKeyOptional(config: Pick<ProviderConfig, 'type' | 'baseUrl'>): boolean {
  if (config.type !== 'openai-compatible') return false
  const raw = config.baseUrl?.trim() ?? ''
  // 地址为空 / 半截（写不成 URL）时按"密钥可选"算——缺地址由 providerConfigProblems 单独报
  if (raw === '') return true
  try {
    return !PRESET_HOSTS.has(new URL(raw).hostname)
  } catch {
    return true
  }
}

/**
 * 这条配置现在能不能用；缺什么报什么（顺序固定：模型 → Base URL → 密钥）。
 * **密钥这一项只有必须密钥的渠道才报**（见 providerKeyOptional）；其余交给服务端说话。
 * 设置页拿它做行内提示，模型解析拿它抛错——同一句话，用户在哪看到都对得上。
 */
export function providerConfigProblems(config: ProviderConfig, hasKey: boolean): string[] {
  const problems: string[] = []
  if (config.model.trim().length === 0) problems.push('配置不完整：缺模型名')
  if (config.type === 'openai-compatible' && (config.baseUrl ?? '').trim().length === 0) {
    problems.push('配置不完整：缺 Base URL')
  }
  if (!hasKey && !providerKeyOptional(config)) problems.push(MISSING_KEY_PROBLEM)
  return problems
}

/** 从预设新建一条配置：第一条自动成为默认（首次配置就能直接用） */
export function providerFromPreset(
  preset: ProviderPreset,
  existing: readonly ProviderConfig[]
): ProviderConfig {
  return {
    id: preset.id,
    type: preset.type,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    isDefault: existing.length === 0
  }
}

/** 新建"自定义"通道：id 自动递增（custom-1、custom-2…），model/baseUrl 留空等用户填 */
export function newCustomProvider(
  existing: readonly ProviderConfig[],
  type: ProviderType
): ProviderConfig {
  const used = new Set(existing.map((provider) => provider.id))
  let index = 1
  while (used.has(`custom-${index}`)) index += 1
  return { id: `custom-${index}`, type, model: '', isDefault: existing.length === 0 }
}

/** 默认标记只落一条：把 id 这条设为默认，其余清除（顺序不变） */
export function withDefaultProvider(
  providers: readonly ProviderConfig[],
  id: string
): ProviderConfig[] {
  return providers.map((provider) => ({ ...provider, isDefault: provider.id === id }))
}

/** openai-compatible 的 provider 标识（BaseURL 之外还能一眼看出是哪个通道；也用作 providerOptions 的键） */
export const OPENAI_COMPATIBLE_PROVIDER_NAME = 'kyclaw-openai-compatible'

/** DeepSeek 官方 API 的主机名（这个端点走 @ai-sdk/deepseek，其余 openai-compatible 走通用兼容层） */
export const DEEPSEEK_API_HOST = 'api.deepseek.com'

/** 这个 baseUrl 是不是 DeepSeek 官方端点（round 18 从 mastra/model.ts 搬到 shared：渲染端也要判） */
export function isDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname === DEEPSEEK_API_HOST
  } catch {
    return false
  }
}
