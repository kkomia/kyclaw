/**
 * 0.2.2：kyclaw 设置里的模型 provider / 密钥 → DSH 内核模型配置（桥）。
 *
 * 为什么需要这层：0.2.x 起对话由 DSH 内核（Node 子进程）承接，内核只认**它自己**的模型配置——
 * `agent-default-model` 指哪条路由、`llm-deepseek` / `llm-pi-ai` 的 baseURL 是什么、凭证从
 * `$DSH_HOME/.credentials.yaml`（或继承环境）里取哪把 key。而 kyclaw 设置页写的是自己的
 * `settings.json`（providers）与 safeStorage 里的密钥，两者在 0.2.0/0.2.1 从没接起来：
 * 「测试连接成功」跑的是 kyclaw 自己的探测链，真发消息时内核报 `MISSING_CREDENTIAL`，界面映射成
 * 「模型密钥缺失或失效」。
 *
 * 传法（**活配置**，改完即时生效、不用重启）：内核 web profile 挂着 settings / credentials 控制器，
 * 主进程用 adapter 的裸 RPC 调：
 *   - `settings/describe`                        读内核现况（llm-deepseek 的模型目录、agent-default-model 现值）
 *   - `credentials/set`                          写密钥（只在这个方向见到明文；不落日志、不进帧）
 *   - `settings/mutate`                          按路径改路由/默认模型（走内核自己的活配置通道）
 *
 * 路由选择：
 *   - **DeepSeek 官方端点**（`isDeepSeekBaseUrl`）→ 用内核自带的 `deepseek-official` 路由
 *     （Messages 协议；官方端点是 `https://api.deepseek.com/anthropic`），密钥写 `DEEPSEEK_API_KEY`。
 *     内核目录里已有该模型就不动 models；当前模型不在目录里时把目录 + 缺的那条一起写回去。
 *   - **其它 openai-compatible / anthropic 端点** → 在 `llm-pi-ai` 里建一条 `kyclaw-<id>` 自定义路由
 *     （协议分别是 `openai-completions` / `anthropic-messages`），密钥写 kyclaw 自己的 credential ref。
 *   - 最后把 `agent-default-model` 指到「该路由 + providers 里当前选中的模型」，模型 chip 切换时重跑一遍。
 *
 * 纪律：
 *   - 没有可用 provider（没配 / 模型名空 / 缺必填 Base URL）→ **什么都不写**（保持内核现状，
 *     不把用户上次能用的配置改坏；缺什么由设置页与错误卡去说）；
 *   - 只清理**自己写过的** pi-ai 路由（`kyclaw-` 前缀），不碰内核/用户建的路由；
 *   - 全程纯函数 + 一个 RPC 调用器：单测不碰内核，真内核验证走 gated 集成用例。
 */
import type { ProbedModel } from '../../shared/settings'
import type { ProviderConfig, ProviderType } from '../../shared/providers'
import { isDeepSeekBaseUrl, providerLabel, registeredModelsOf } from '../../shared/providers'

/** 内核 settings/mutate 的一条路径编辑（与内核 wire 契约同形，只收本文件会用的两种） */
export type KernelSettingsOp =
  { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** 一次同步要写的某个 settings namespace（`llm-deepseek` / `llm-pi-ai` / `agent-default-model`） */
export interface KernelSettingsMutation {
  ns: string
  ops: KernelSettingsOp[]
}

/** 桥接模式：官方 DeepSeek 路由 / pi-ai 自定义路由 */
export type KernelModelMode = 'deepseek-official' | 'pi-ai'

/** 同步计划（纯数据；由 `syncKernelModel` 按顺序落地到内核） */
export interface KernelModelPlan {
  mode: KernelModelMode
  /** 当前选中的 kyclaw provider id（日志/诊断用） */
  providerId: string
  /** 写进 credential store 的明文（只在主进程内存里过一趟，不落日志） */
  credentials: Array<{ ref: string; value: string }>
  /** llm 配置（可能同时含 llm-deepseek 与 llm-pi-ai 两个 ns：主配置 + 清理旧路由） */
  mutations: KernelSettingsMutation[]
  /** 内核默认模型（`agent-default-model` 的 provider/model） */
  defaultModel: { provider: string; model: string }
}

/** 同步入参：kyclaw 侧现况 + 内核现况（describe 得到的模型目录/旧路由） */
export interface KernelModelInput {
  providers: readonly ProviderConfig[]
  readKey: (providerId: string) => string | null
  probedModels?: Readonly<Record<string, ProbedModel>>
  /**
   * 内核 `llm-deepseek` 目录里的模型条目（`settings/describe` 的 value.models，原样回写用）。
   * 缺省 = 不知道（不写 models 字段，模型名按用户设置直传）。
   */
  deepseekModels?: readonly Readonly<Record<string, unknown>>[]
  /** 内核 `llm-pi-ai` user 层里已经存在的 provider 路由名（用来清理我们写过的旧路由） */
  piRoutes?: readonly string[]
}

/** 内核裸 RPC 调用器（生产 = adapter.rpcCall；测试 = 假函数） */
export type KernelSettingsCall = (
  method: string,
  args?: Record<string, unknown>
) => Promise<unknown>

/** 同步结果（日志/诊断用；不带到 renderer） */
export interface KernelModelSyncResult {
  applied: boolean
  /** 没写的原因（applied=false 时） */
  reason?: string
  mode?: KernelModelMode
  route?: string
  providerId?: string
  model?: string
}

/** 内核官方 DeepSeek 路由名（`dsh-llm-deepseek-api-key` 里写死的 provider） */
export const KERNEL_DEEPSEEK_PROVIDER = 'deepseek-official'

/** 官方路由的凭证引用名（内核 llm-deepseek 的 apiKeyEnv 缺省值） */
export const KERNEL_DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY'

/**
 * 官方 DeepSeek 的 Messages 端点：`llm-deepseek` 是 Messages 协议（`<base>/v1/messages`），
 * 官方 OpenAI 兼容地址 `https://api.deepseek.com` 不能直接当 base 用，要指到 `/anthropic`。
 * 已经是 `/anthropic`（或用户显式写了它）就原样保留。
 */
export function deepseekMessagesBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? '').trim().replace(/\/+$/u, '')
  if (raw === '') return 'https://api.deepseek.com/anthropic'
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/+$/u, '')
    if (path.endsWith('/anthropic')) return `${url.origin}${path}`
    return `${url.origin}/anthropic`
  } catch {
    return 'https://api.deepseek.com/anthropic'
  }
}

/** pi-ai 路由 id：设置页的 provider id 不一定符合内核的要求，统一加 `kyclaw-` 前缀并归一 */
export function piAiRouteId(providerId: string): string {
  const slug = providerId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return `kyclaw-${slug === '' ? 'provider' : slug}`
}

/** pi-ai 路由的凭证引用名（credential ref = POSIX shell 标识符；大写 + 下划线） */
export function piAiKeyRef(providerId: string): string {
  const slug = providerId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return `KYCLAW_${slug === '' ? 'PROVIDER' : slug}_API_KEY`
}

/** pi-ai 路由的 wire 协议（kyclaw 只有两档通道类型） */
export function piAiProtocol(type: ProviderType): 'openai-completions' | 'anthropic-messages' {
  return type === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
}

/** 当前生效的 provider（isDefault 优先，其次第一条；模型名为空的半截配置不算） */
export function activeProviderOf(providers: readonly ProviderConfig[]): ProviderConfig | undefined {
  const candidates = providers.filter((provider) => provider.model.trim() !== '')
  return candidates.find((provider) => provider.isDefault) ?? candidates[0]
}

/** 这条 provider 走官方 DeepSeek 路由的条件（端点 = 官方；anthropic 类型不算） */
export function usesDeepSeekOfficial(provider: ProviderConfig): boolean {
  return provider.type === 'openai-compatible' && isDeepSeekBaseUrl(provider.baseUrl)
}

/**
 * 一条 pi-ai 模型条目：内核不知道的模型要自带上下文窗口/输出上限/模态，
 * 有 kyclaw 实测元数据就带上（没有就让内核用自己的缺省）。
 */
export function piAiModelEntry(
  providerId: string,
  model: string,
  probed: Readonly<Record<string, ProbedModel>> | undefined
): Record<string, unknown> {
  const meta = probed?.[`${providerId}:${model}`]
  return {
    id: model,
    ...(typeof meta?.contextWindow === 'number' ? { contextWindow: meta.contextWindow } : {}),
    ...(typeof meta?.maxOutputTokens === 'number' ? { maxTokens: meta.maxOutputTokens } : {}),
    ...(meta?.vision === true ? { input: ['text', 'image'] } : {})
  }
}

/** provider 里已注册的模型（当前选中那个一定在内，见 `registeredModelsOf`） */
function routeModelsOf(
  provider: ProviderConfig,
  probed: Readonly<Record<string, ProbedModel>> | undefined
): Array<Record<string, unknown>> | undefined {
  const models = registeredModelsOf(provider).filter((model) => model !== '')
  if (models.length === 0) return undefined
  return models.map((model) => piAiModelEntry(provider.id, model, probed))
}

/**
 * 官方 DeepSeek 路由的 models 回写：内核目录里已有当前模型就**不动**（保住它自带的
 * 上下文窗口 / 图片模态等元数据）；缺了才把「目录 + 缺的那几条」一起写回去。
 */
export function deepseekModelsPatch(
  provider: ProviderConfig,
  catalog: readonly Readonly<Record<string, unknown>>[],
  probed: Readonly<Record<string, ProbedModel>> | undefined
): Array<Record<string, unknown>> | undefined {
  const known = new Set(
    catalog.flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : []))
  )
  const wanted = registeredModelsOf(provider).filter((model) => model !== '')
  const missing = wanted.filter((model) => !known.has(model))
  if (missing.length === 0) return undefined
  return [
    ...catalog.map((entry) => ({ ...entry })),
    ...missing.map((model) => ({
      ...piAiModelEntry(provider.id, model, probed)
    }))
  ]
}

/**
 * 算出本次要写到内核的模型配置；没有可用 provider 回 `null`（调用方不写任何东西）。
 * 纯函数：不读盘、不发请求。
 */
export function buildKernelModelPlan(input: KernelModelInput): KernelModelPlan | null {
  const provider = activeProviderOf(input.providers)
  if (provider === undefined) return null
  const key = (input.readKey(provider.id) ?? '').trim()
  const model = provider.model.trim()
  const stalePiRoutes = (input.piRoutes ?? []).filter((route) => route.startsWith('kyclaw-'))

  if (usesDeepSeekOfficial(provider)) {
    // 官方端点必须认证：没有 key 时先不指过去（否则内核每次请求都缺凭证，比现状更糟）
    if (key === '') return null
    const ops: KernelSettingsOp[] = [
      { op: 'set', path: ['baseURL'], value: deepseekMessagesBaseUrl(provider.baseUrl) },
      { op: 'set', path: ['apiKeyEnv'], value: KERNEL_DEEPSEEK_KEY_REF }
    ]
    const models = deepseekModelsPatch(provider, input.deepseekModels ?? [], input.probedModels)
    if (models !== undefined) ops.push({ op: 'set', path: ['models'], value: models })
    return {
      mode: 'deepseek-official',
      providerId: provider.id,
      credentials: [{ ref: KERNEL_DEEPSEEK_KEY_REF, value: key }],
      mutations: [
        { ns: 'llm-deepseek', ops },
        // 从 pi-ai 切回官方时，把我们之前建的路由清掉（只碰 kyclaw- 前缀）
        ...(stalePiRoutes.length === 0
          ? []
          : [
              {
                ns: 'llm-pi-ai',
                ops: stalePiRoutes.map((route) => ({
                  op: 'unset' as const,
                  path: ['providers', route]
                }))
              }
            ])
      ],
      defaultModel: { provider: KERNEL_DEEPSEEK_PROVIDER, model }
    }
  }

  const baseUrl = (provider.baseUrl ?? '').trim()
  // openai-compatible 必须有 Base URL（缺了是半截配置）；anthropic 缺省官方端点
  if (provider.type === 'openai-compatible' && baseUrl === '') return null
  const route = piAiRouteId(provider.id)
  const profile: Record<string, unknown> = {
    displayName: providerLabel(provider),
    api: piAiProtocol(provider.type),
    baseURL: provider.type === 'anthropic' ? baseUrl || 'https://api.anthropic.com' : baseUrl
  }
  const models = routeModelsOf(provider, input.probedModels)
  if (models !== undefined) profile.models = models
  const keyRef = piAiKeyRef(provider.id)
  if (key !== '') profile.apiKeyEnv = keyRef

  const unsetOps = stalePiRoutes
    .filter((candidate) => candidate !== route)
    .map((candidate) => ({ op: 'unset' as const, path: ['providers', candidate] }))
  return {
    mode: 'pi-ai',
    providerId: provider.id,
    credentials: key === '' ? [] : [{ ref: keyRef, value: key }],
    mutations: [
      {
        ns: 'llm-pi-ai',
        ops: [{ op: 'set', path: ['providers', route], value: profile }, ...unsetOps]
      }
    ],
    defaultModel: { provider: route, model }
  }
}

/** `settings/describe` 回包里本文件用到的部分（unknown 收窄；内核换版也不炸） */
interface SettingsNamespaceView {
  ns?: unknown
  user?: unknown
  value?: unknown
}

interface SettingsDescribeValue {
  namespaces?: unknown
}

function namespaceViews(described: unknown): SettingsNamespaceView[] {
  if (typeof described !== 'object' || described === null) return []
  const namespaces = (described as SettingsDescribeValue).namespaces
  return Array.isArray(namespaces)
    ? namespaces.filter(
        (item): item is SettingsNamespaceView => typeof item === 'object' && item !== null
      )
    : []
}

function namespaceOf(
  views: readonly SettingsNamespaceView[],
  ns: string
): SettingsNamespaceView | undefined {
  return views.find((view) => view.ns === ns)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 从内核现况里取「llm-deepseek 模型目录」与「已存在的 pi-ai 路由名」 */
export function kernelModelSnapshot(described: unknown): {
  deepseekModels: Array<Record<string, unknown>>
  piRoutes: string[]
} {
  const views = namespaceViews(described)
  const deepseekModels = (() => {
    const value = recordOf(namespaceOf(views, 'llm-deepseek')?.value)
    const models = value?.models
    return Array.isArray(models)
      ? models.flatMap((entry) => {
          const record = recordOf(entry)
          return record === undefined ? [] : [record]
        })
      : []
  })()
  const piRoutes = (() => {
    const user = recordOf(namespaceOf(views, 'llm-pi-ai')?.user)
    const providers = recordOf(user?.providers)
    return providers === undefined ? [] : Object.keys(providers)
  })()
  return { deepseekModels, piRoutes }
}

/**
 * 把计划落到内核（**唯一**发请求的地方）：读现况 → 写凭证 → 写路由/模型 → 指默认模型。
 * 任一 RPC 失败都会抛（调用方决定吞不吞：同步失败不该挡应用启动，但必须留日志）。
 */
export async function syncKernelModel(
  call: KernelSettingsCall,
  input: Omit<KernelModelInput, 'deepseekModels' | 'piRoutes'>
): Promise<KernelModelSyncResult> {
  const described = await call('settings/describe', {}).catch((error: unknown) => {
    throw new Error(
      `读内核模型设置失败（settings/describe）：${error instanceof Error ? error.message : String(error)}`
    )
  })
  const snapshot = kernelModelSnapshot(described)
  const plan = buildKernelModelPlan({ ...input, ...snapshot })
  if (plan === null) return { applied: false, reason: 'no-usable-provider' }

  for (const credential of plan.credentials) {
    await call('credentials/set', { ref: credential.ref, value: credential.value })
  }
  for (const mutation of plan.mutations) {
    if (mutation.ops.length === 0) continue
    await call('settings/mutate', { ns: mutation.ns, ops: mutation.ops })
  }
  await call('settings/mutate', {
    ns: 'agent-default-model',
    ops: [
      { op: 'set', path: ['provider'], value: plan.defaultModel.provider },
      { op: 'set', path: ['model'], value: plan.defaultModel.model }
    ]
  })
  return {
    applied: true,
    mode: plan.mode,
    route: plan.defaultModel.provider,
    providerId: plan.providerId,
    model: plan.defaultModel.model
  }
}
