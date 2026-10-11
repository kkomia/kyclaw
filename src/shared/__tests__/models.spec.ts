import { describe, expect, it } from 'vitest'
import {
  contextTokensFor,
  contextWindowOf,
  DEFAULT_CONTEXT_WINDOW,
  effectiveEffortId,
  formatTokens,
  modelSpecOf,
  requestProviderOptions,
  thinkingEffortsOf
} from '../models'
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
