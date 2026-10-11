import { describe, expect, it } from 'vitest'
import {
  contextTokensFor,
  contextWindowOf,
  DEFAULT_CONTEXT_WINDOW,
  effectiveEffortId,
  formatTokens,
  isProbedFresh,
  modelSpecOf,
  probedKeyOf,
  requestProviderOptions,
  thinkingEffortsOf,
  visionOf
} from '../models'
import type { ProbedModelSpec } from '../models'
import type { ProviderConfig } from '../providers'

/**
 * 模型注册表（round 18）：上下文长度 / 思考挡位 / 透传判定。
 * 已知项按注册表；未知模型给保守默认；挡位 id 无效回落 `default`。
 */
describe('模型注册表：匹配与默认', () => {
  it('DeepSeek V4 家族：Pro 是 1M 档、四挡思考（low/high/max 是真值）；名字大小写与 provider/ 前缀都归一', () => {
    expect(contextWindowOf('deepseek-v4-pro')).toBe(1_000_000)
    expect(contextWindowOf('DeepSeek-V4-Pro')).toBe(1_000_000)
    expect(contextWindowOf('deepseek/deepseek-v4-pro')).toBe(1_000_000)
    expect(thinkingEffortsOf('deepseek-v4-pro').map((effort) => effort.id)).toEqual([
      'default',
      'low',
      'high',
      'max'
    ])

    expect(contextWindowOf('deepseek-v4-flash-vision-exp')).toBe(128_000)
    expect(thinkingEffortsOf('deepseek-flash').map((effort) => effort.id)).toEqual([
      'default',
      'low',
      'high',
      'max'
    ])
  })

  it('上一代与未知模型：如实「默认」单档；未知上下文长度用保守默认', () => {
    expect(thinkingEffortsOf('deepseek-reasoner')).toEqual([{ id: 'default', label: '默认' }])
    expect(contextWindowOf('deepseek-chat')).toBe(128_000)
    expect(contextWindowOf('kimi-k3')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(thinkingEffortsOf('kimi-k3').map((effort) => effort.id)).toEqual(['default'])
    expect(modelSpecOf(undefined).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('对话长度百分比：夹到 10–100，tokens = 官方长度 × pct/100', () => {
    expect(contextTokensFor('deepseek-v4-pro', 100)).toBe(1_000_000)
    expect(contextTokensFor('deepseek-v4-pro', 40)).toBe(400_000)
    expect(contextTokensFor('deepseek-v4-pro', 5)).toBe(100_000) // 下限 10%
    expect(contextTokensFor('deepseek-v4-pro', 500)).toBe(1_000_000) // 上限 100%
    expect(contextTokensFor('deepseek-v4-pro', undefined)).toBe(1_000_000) // 缺省 = 100%
    expect(contextTokensFor('deepseek-v4-flash', 50)).toBe(64_000)
  })

  it('挡位回落：不在该模型的列表里 → default', () => {
    expect(effectiveEffortId('deepseek-v4-pro', 'max')).toBe('max')
    expect(effectiveEffortId('deepseek-reasoner', 'max')).toBe('default') // 上一代没有多档
    expect(effectiveEffortId('deepseek-v4-pro', 'bogus')).toBe('default')
    expect(effectiveEffortId('deepseek-v4-pro', undefined)).toBe('default')
  })

  it('token 人话：K / M 两档', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(512)).toBe('512')
    expect(formatTokens(51_200)).toBe('51K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(471_000)).toBe('471K')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })
})

describe('思考挡位透传（requestProviderOptions）', () => {
  const deepseekProvider: ProviderConfig = {
    id: 'ds',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    isDefault: true
  }

  it('DeepSeek 官方端点：providerOptions.deepseek.reasoningEffort（low|high|max）', () => {
    expect(requestProviderOptions(deepseekProvider, 'high')).toEqual({
      deepseek: { reasoningEffort: 'high' }
    })
  })

  it('其它 openai 兼容端点：providerOptions 用兼容层名（字符串原样交端点）', () => {
    expect(
      requestProviderOptions(
        { ...deepseekProvider, baseUrl: 'https://proxy.example.com/v1' },
        'max'
      )
    ).toEqual({ 'kyclaw-openai-compatible': { reasoningEffort: 'max' } })
  })

  it('默认挡 / 无效挡 / anthropic / 不支持的模型：不传（如实只保存与显示）', () => {
    expect(requestProviderOptions(deepseekProvider, 'default')).toBeNull()
    expect(requestProviderOptions(deepseekProvider, undefined)).toBeNull()
    expect(requestProviderOptions(deepseekProvider, 'bogus')).toBeNull()
    expect(requestProviderOptions({ ...deepseekProvider, type: 'anthropic' }, 'high')).toBeNull()
    expect(
      requestProviderOptions({ ...deepseekProvider, model: 'deepseek-reasoner' }, 'high')
    ).toBeNull()
  })
})

describe('round 22 · probed 实测优先（GET /models 的真实元数据盖过注册表）', () => {
  /** 实测样本：deepseek-flash = 1M、low|high|max、默认 high（主控在官方端点上抓到的形状） */
  const PROBED: ProbedModelSpec = {
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    fetchedAt: '2026-10-11T00:00:00.000Z'
  }

  it('上下文长度：probed 盖过注册表的 128K（用户点名的纠错）；没 probed 仍走注册表', () => {
    expect(contextWindowOf('deepseek-flash', PROBED)).toBe(1_048_576)
    expect(contextTokensFor('deepseek-flash', 100, PROBED)).toBe(1_048_576)
    expect(contextTokensFor('deepseek-flash', 25, PROBED)).toBe(262_144)
    expect(contextWindowOf('deepseek-flash')).toBe(128_000)
  })

  it('思考挡位：probed 的 supported_levels 原样成列（标签用既有映射），default_level 回落初始档', () => {
    expect(
      thinkingEffortsOf('deepseek-flash', PROBED).map((effort) => [effort.id, effort.label])
    ).toEqual([
      ['default', '默认'],
      ['low', '低'],
      ['high', '高'],
      ['max', '最高']
    ])
    expect(effectiveEffortId('deepseek-flash', undefined, PROBED)).toBe('high')
    expect(effectiveEffortId('deepseek-flash', 'low', PROBED)).toBe('low')
    // 显式选了不存在的挡 → 回落端点默认档（不是硬编码 default）
    expect(effectiveEffortId('deepseek-flash', 'bogus', PROBED)).toBe('high')
  })

  it('未知挡位原样显示（标签 = 值，如实）；default_level 不在列表里不采信', () => {
    const odd: ProbedModelSpec = { ...PROBED, efforts: ['medium'], defaultEffort: 'high' }
    expect(thinkingEffortsOf('deepseek-flash', odd).map((effort) => effort.id)).toEqual([
      'default',
      'medium'
    ])
    expect(thinkingEffortsOf('deepseek-flash', odd).map((effort) => effort.label)).toEqual([
      '默认',
      'medium'
    ])
    expect(effectiveEffortId('deepseek-flash', undefined, odd)).toBe('default')
  })

  it('probed 只给了上下文长度 → 挡位回落注册表；probed 值非法（0）→ 该字段回落', () => {
    const partial: ProbedModelSpec = { contextWindow: 1_048_576, fetchedAt: PROBED.fetchedAt }
    expect(contextWindowOf('deepseek-flash', partial)).toBe(1_048_576)
    expect(thinkingEffortsOf('deepseek-flash', partial).map((effort) => effort.id)).toEqual([
      'default',
      'low',
      'high',
      'max'
    ])

    const broken: ProbedModelSpec = { ...PROBED, contextWindow: 0 }
    expect(contextWindowOf('deepseek-flash', broken)).toBe(128_000)
  })

  it('透传：probed 的默认档照常进 providerOptions（显示与发送同值）', () => {
    const provider: ProviderConfig = {
      id: 'ds',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      isDefault: true
    }
    expect(requestProviderOptions(provider, undefined, PROBED)).toEqual({
      deepseek: { reasoningEffort: 'high' }
    })
    expect(requestProviderOptions(provider, 'default', PROBED)).toBeNull()
  })

  it('过期判定（isProbedFresh）：24h 内新鲜；没有记录 / 时间戳坏了 / 超期 → 过期', () => {
    const now = Date.parse('2026-10-11T12:00:00.000Z')
    expect(isProbedFresh(PROBED, now)).toBe(true)
    expect(isProbedFresh({ ...PROBED, fetchedAt: '2026-10-11T11:00:00.000Z' }, now)).toBe(true)
    expect(isProbedFresh({ ...PROBED, fetchedAt: '2026-10-09T00:00:00.000Z' }, now)).toBe(false)
    expect(isProbedFresh(undefined, now)).toBe(false)
    expect(isProbedFresh({ ...PROBED, fetchedAt: '坏时间' }, now)).toBe(false)
  })

  it('探测键：`<providerId>:<modelId>`（模型名原文，不归一）', () => {
    expect(probedKeyOf('deepseek', 'deepseek-flash')).toBe('deepseek:deepseek-flash')
    expect(probedKeyOf('p1', 'DeepSeek-V4-Pro')).toBe('p1:DeepSeek-V4-Pro')
  })
})

describe('视觉能力（模块 2：用户覆盖 > 注册表 > false）', () => {
  it('注册表：deepseek 全系没有视觉（如实标 false）；未知模型保守 false', () => {
    for (const model of [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-flash',
      'deepseek-chat',
      'deepseek-reasoner'
    ]) {
      expect(visionOf(model), model).toBe(false)
    }
    expect(visionOf('kimi-k3')).toBe(false)
    expect(visionOf(undefined)).toBe(false)
    expect(visionOf('')).toBe(false)
    // 名字归一（大小写 / provider 前缀）与注册表匹配同口径
    expect(visionOf('DeepSeek-V4-Pro')).toBe(false)
  })

  it('用户覆盖压过注册表：true 覆盖 false，false 覆盖"注册表没写"的保守值', () => {
    expect(visionOf('deepseek-chat', { vision: true })).toBe(true)
    expect(visionOf('gpt-4o', { vision: true })).toBe(true)
    expect(visionOf('gpt-4o', { vision: false })).toBe(false)
    // 覆盖对象在但没写 vision = 没覆盖（回落注册表）
    expect(visionOf('gpt-4o', {})).toBe(false)
    expect(visionOf('gpt-4o', undefined)).toBe(false)
  })

  it('modelSpecOf 带上 vision（probed 覆盖上下文/挡位时也不丢）', () => {
    expect(modelSpecOf('deepseek-flash').vision).toBe(false)
    expect(
      modelSpecOf('deepseek-flash', {
        contextWindow: 1_000_000,
        efforts: ['low'],
        fetchedAt: '2026-10-11T00:00:00.000Z'
      }).vision
    ).toBe(false)
  })
})
