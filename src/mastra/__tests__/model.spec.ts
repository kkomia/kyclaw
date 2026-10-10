/**
 * resolveModel：三种 provider 配置的解析（全部假 key，零真实网络）+ mock 口径（R3 离线兜底）。
 * 只断言"选了哪种模型、透传了什么"，不断言模型内部实现——那是各 SDK 自己的事。
 */
import { describe, expect, it } from 'vitest'
import { resolveModel } from '../model'

/** 模型对象各家 SDK 的类实例，这里只取断言要看的几个字段 */
function modelInfo(model: unknown): {
  provider?: string
  modelId?: string
  specificationVersion?: string
} {
  return model as { provider?: string; modelId?: string; specificationVersion?: string }
}

describe('resolveModel', () => {
  it('未配置任何 provider → 内置 mock（离线兜底，reason=unconfigured）', async () => {
    for (const providers of [undefined, [] as unknown[]]) {
      const resolved = await resolveModel(providers, {})

      expect(resolved.source).toBe('mock')
      expect(resolved.mockReason).toBe('unconfigured')
      expect(modelInfo(resolved.model).provider).toBe('kyclaw-mock')
      expect(modelInfo(resolved.model).specificationVersion).toBe('v4')
    }
  })

  it('KYCLAW_FORCE_MOCK=1 → mock（reason=forced），即便配了真 provider', async () => {
    const provider = {
      kind: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'fake-key',
      model: 'some-model'
    }

    const resolved = await resolveModel([provider], { KYCLAW_FORCE_MOCK: '1' })

    expect(resolved.source).toBe('mock')
    expect(resolved.mockReason).toBe('forced')
  })

  it('openai-compatible 配置 → 透传 baseUrl/apiKey/model 的 openai-compatible 模型', async () => {
    const resolved = await resolveModel(
      [
        {
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKey: 'fake-key',
          model: 'qwen3:8b'
        }
      ],
      {}
    )

    expect(resolved.source).toBe('openai-compatible')
    expect(resolved.mockReason).toBeUndefined()
    expect(modelInfo(resolved.model).provider).toBe('kyclaw-openai-compatible.chat')
    expect(modelInfo(resolved.model).modelId).toBe('qwen3:8b')
  })

  it('anthropic 配置 → anthropic 模型（model 透传）', async () => {
    const resolved = await resolveModel(
      [{ kind: 'anthropic', apiKey: 'fake-key', model: 'claude-sonnet-4-5' }],
      {}
    )

    expect(resolved.source).toBe('anthropic')
    expect(modelInfo(resolved.model).provider).toBe('anthropic.messages')
    expect(modelInfo(resolved.model).modelId).toBe('claude-sonnet-4-5')
  })

  it('provider 列表里没有一条能过 schema → 当"没配"，回落 mock（不抛）', async () => {
    const resolved = await resolveModel(
      [{ kind: 'openai-compatible' }, { kind: 'anthropic', apiKey: '' }, null, 'garbage'],
      {}
    )

    expect(resolved.source).toBe('mock')
    expect(resolved.mockReason).toBe('unconfigured')
  })
})
