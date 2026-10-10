/**
 * Provider（模型通道）配置：设置页、落盘（settings.providers）、模型解析三处共用一份 schema 与措辞。
 *
 * 两条纪律：
 *   1. **半截配置是"合法存档、非法可用"**——schema 收下它（不然读设置会把整份文件当坏文件丢回默认，
 *      用户录到一半的设置也没了），缺什么由 `providerConfigProblems` 报；
 *   2. 报错措辞只有这一处（"配置不完整：缺 X"）：设置页里显示的就是模型解析抛的同一句话，
 *      不允许静默回落 mock。
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
 */
export const providerConfigSchema = z.strictObject({
  id: z.string().min(1),
  type: providerTypeSchema,
  baseUrl: z.string().optional(),
  model: z.string(),
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

/** 列表里显示的名字：预设用预设名，自定义用序号，手写 id 原样（密钥按 id 存，所以 id 就是身份） */
export function providerLabel(config: ProviderConfig): string {
  const preset = providerPreset(config.id)
  if (preset) return preset.label
  const custom = /^custom-(\d+)$/.exec(config.id)
  return custom ? `自定义 ${custom[1]}` : config.id
}

/**
 * 这条配置现在能不能用；缺什么报什么（顺序固定：模型 → Base URL → 密钥）。
 * 设置页拿它做行内提示，模型解析拿它抛错——同一句话，用户在哪看到都对得上。
 */
export function providerConfigProblems(config: ProviderConfig, hasKey: boolean): string[] {
  const problems: string[] = []
  if (config.model.trim().length === 0) problems.push('配置不完整：缺模型名')
  if (config.type === 'openai-compatible' && (config.baseUrl ?? '').trim().length === 0) {
    problems.push('配置不完整：缺 Base URL')
  }
  if (!hasKey) problems.push('配置不完整：缺 API 密钥')
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
