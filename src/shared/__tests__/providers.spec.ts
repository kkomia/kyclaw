import { describe, expect, it } from 'vitest'
import {
  newCustomProvider,
  providerConfigProblems,
  providerConfigSchema,
  providerFromPreset,
  providerLabel,
  providerPreset,
  PROVIDER_PRESETS,
  withDefaultProvider,
  type ProviderConfig
} from '../providers'

/** 一条"能直接用"的 openai-compatible 配置（有 key、有 baseUrl、有 model） */
function complete(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'custom-1',
    type: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    model: 'some-model',
    isDefault: true,
    ...overrides
  }
}

describe('ProviderConfig schema（落盘 / IPC / 渲染端共用）', () => {
  it('两条 type：openai-compatible / anthropic；其余一律拒绝', () => {
    expect(providerConfigSchema.safeParse(complete()).success).toBe(true)
    expect(
      providerConfigSchema.safeParse({
        id: 'anthropic',
        type: 'anthropic',
        model: 'claude-sonnet-4-5',
        isDefault: false
      }).success
    ).toBe(true)

    for (const type of ['openai', 'gemini', 'OPENAI-COMPATIBLE', '', null]) {
      expect(providerConfigSchema.safeParse(complete({ type: type as never })).success, type).toBe(
        false
      )
    }
  })

  it('半截配置是"合法存档、非法可用"：能落盘（不然读设置会把整份文件丢弃回默认），缺什么由 problems 报', () => {
    // 缺 baseUrl / 空 model 的条目必须能通过 schema（手工改坏、录到一半都属这种）
    expect(
      providerConfigSchema.safeParse({
        id: 'custom-1',
        type: 'openai-compatible',
        model: '',
        isDefault: false
      }).success
    ).toBe(true)

    // 但 id / isDefault 缺了就不是一条 provider
    expect(providerConfigSchema.safeParse({ type: 'anthropic', model: 'm' }).success).toBe(false)
    expect(providerConfigSchema.safeParse({ id: 'x', type: 'anthropic', model: 'm' }).success).toBe(
      false
    )
  })

  it('strict：多余字段/错型都不收（文件结构就是 schema 结构）', () => {
    expect(providerConfigSchema.safeParse({ ...complete(), apiKey: 'sk-leaked' }).success).toBe(
      false
    )
    expect(providerConfigSchema.safeParse(complete({ isDefault: 'yes' as never })).success).toBe(
      false
    )
    expect(providerConfigSchema.safeParse(complete({ baseUrl: 1 as never })).success).toBe(false)
    // IPC（structured clone）与 JSON 往返里，optional 字段可能是"显式的 undefined"
    expect(providerConfigSchema.safeParse(complete({ baseUrl: undefined })).success).toBe(true)
  })
})

describe('providerConfigProblems：缺什么就报什么（设置页与模型解析共用同一句话）', () => {
  it('配齐了（有 key）→ 没有任何问题', () => {
    expect(providerConfigProblems(complete(), true)).toEqual([])
    expect(
      providerConfigProblems(
        { id: 'anthropic', type: 'anthropic', model: 'claude-sonnet-4-5', isDefault: true },
        true
      )
    ).toEqual([])
  })

  it('type/model 有了但没有 key → 缺 API 密钥（不得静默回落 mock）', () => {
    expect(providerConfigProblems(complete(), false)).toEqual(['配置不完整：缺 API 密钥'])
  })

  it('openai-compatible 缺 baseUrl → 缺 Base URL（anthropic 用官方端点，不算缺）', () => {
    const noBase = complete({ baseUrl: undefined })
    expect(providerConfigProblems(noBase, true)).toEqual(['配置不完整：缺 Base URL'])

    const anthropic: ProviderConfig = {
      id: 'anthropic',
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      isDefault: false
    }
    expect(providerConfigProblems(anthropic, true)).toEqual([])
    expect(providerConfigProblems({ ...noBase, baseUrl: '   ' }, true)).toEqual([
      '配置不完整：缺 Base URL'
    ])
  })

  it('模型名为空/全空白 → 缺模型名；多项缺失按 模型 → Base URL → 密钥 顺序报全', () => {
    expect(providerConfigProblems(complete({ model: '' }), true)).toEqual(['配置不完整：缺模型名'])
    expect(
      providerConfigProblems(
        { id: 'custom-1', type: 'openai-compatible', model: '  ', isDefault: false },
        false
      )
    ).toEqual(['配置不完整：缺模型名', '配置不完整：缺 Base URL', '配置不完整：缺 API 密钥'])
  })
})

describe('预置 provider（设置页的一键添加）', () => {
  it('预设齐了：DeepSeek / Moonshot Kimi / OpenAI / Anthropic 各一条，id 唯一', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(ids).toEqual(['deepseek', 'moonshot', 'openai', 'anthropic'])
    expect(new Set(ids).size).toBe(ids.length)

    for (const preset of PROVIDER_PRESETS) {
      expect(preset.label.length, preset.id).toBeGreaterThan(0)
      expect(preset.defaultModel.length, preset.id).toBeGreaterThan(0)
      // openai-compatible 的预设必须带 baseUrl（anthropic 走官方端点）
      if (preset.type === 'openai-compatible') {
        expect(preset.baseUrl, preset.id).toMatch(/^https:\/\//)
      }
    }
  })

  it('DeepSeek 的 base 就是官方端点（本任务裁决），缺省模型 deepseek-flash', () => {
    const deepseek = providerPreset('deepseek')
    expect(deepseek).toMatchObject({
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-flash'
    })
  })

  it('providerLabel：预设用中文/官方名，自定义用序号，手工写的 id 原样显示', () => {
    expect(providerLabel(complete({ id: 'deepseek' }))).toBe('DeepSeek')
    expect(providerLabel(complete({ id: 'custom-3' }))).toBe('自定义 3')
    expect(providerLabel(complete({ id: 'my-gateway' }))).toBe('my-gateway')
  })
})

describe('providerFromPreset / newCustomProvider / withDefaultProvider（设置页的装配件）', () => {
  it('从预设新建：字段来自预设，第一条自动成为默认', () => {
    const first = providerFromPreset(providerPreset('deepseek')!, [])
    expect(first).toEqual({
      id: 'deepseek',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      isDefault: true
    })

    const second = providerFromPreset(providerPreset('anthropic')!, [first])
    expect(second.isDefault).toBe(false)
    expect(second.baseUrl).toBeUndefined()
  })

  it('自定义 provider：id 递增（custom-1、custom-2），model 先空着等用户填', () => {
    const first = newCustomProvider([], 'openai-compatible')
    expect(first).toEqual({
      id: 'custom-1',
      type: 'openai-compatible',
      model: '',
      isDefault: true
    })

    const existing = [first, providerFromPreset(providerPreset('openai')!, [first])]
    const next = newCustomProvider(existing, 'anthropic')
    expect(next).toMatchObject({ id: 'custom-2', type: 'anthropic', model: '', isDefault: false })
  })

  it('withDefaultProvider：默认标记只落在选中的那一条上，顺序不变', () => {
    const providers = [
      providerFromPreset(providerPreset('deepseek')!, []),
      providerFromPreset(providerPreset('openai')!, [])
    ]

    const next = withDefaultProvider(providers, 'openai')

    expect(next.map((p) => [p.id, p.isDefault])).toEqual([
      ['deepseek', false],
      ['openai', true]
    ])
  })
})
