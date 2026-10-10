/**
 * resolveModel：把 settings.providers + 密钥翻译成模型。本文件盯四件事（全部假 key、零真实网络）：
 *   1. mock **只有两个入口**（KYCLAW_FORCE_MOCK=1 / 一条 provider 都没配）；
 *   2. 选哪条配置（默认标记优先，没有默认就是第一条）；
 *   3. 配齐了走哪个 SDK（openai-compatible / DeepSeek 官方包 / anthropic 的 provider 名）；
 *   4. **半截配置必须显式报错**（"配置不完整：缺 X"），绝不静默回落 mock。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../shared/providers'
import { resolveModel, ProviderConfigError, selectProviderConfig } from '../model'

/** 模型对象各家 SDK 的类实例，这里只取断言要看的几个字段 */
function modelInfo(model: unknown): {
  provider?: string
  modelId?: string
  specificationVersion?: string
} {
  return model as { provider?: string; modelId?: string; specificationVersion?: string }
}

const KEY = 'sk-test-fake-key-1234'

const DEEPSEEK: ProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  isDefault: true
}

/** 假密钥读取器：只认传进来的这几条 id */
function keyReader(keys: Record<string, string> = {}): (id: string) => string | null {
  return (id) => keys[id] ?? null
}

const WITH_KEY = keyReader({ deepseek: KEY, openai: KEY, anthropic: KEY, 'custom-1': KEY })

describe('resolveModel · mock 只有两个入口', () => {
  it('一条 provider 都没配 → 内置 mock（unconfigured）', async () => {
    for (const providers of [undefined, [] as ProviderConfig[]]) {
      const resolved = await resolveModel(providers, keyReader(), {})

      expect(resolved.source).toBe('mock')
      expect(resolved.mockReason).toBe('unconfigured')
      expect(modelInfo(resolved.model).provider).toBe('kyclaw-mock')
      expect(modelInfo(resolved.model).specificationVersion).toBe('v4')
    }
  })

  it('KYCLAW_FORCE_MOCK=1 → mock（forced），即便配了完整 provider（连密钥都不读）', async () => {
    const readKey = vi.fn(keyReader({ deepseek: KEY }))

    const resolved = await resolveModel([DEEPSEEK], readKey, { KYCLAW_FORCE_MOCK: '1' })

    expect(resolved.source).toBe('mock')
    expect(resolved.mockReason).toBe('forced')
    expect(readKey).not.toHaveBeenCalled()
  })

  it('KYCLAW_FORCE_MOCK 是字符串 "0" 时不生效（避免 0 被当真的陷阱）', async () => {
    const resolved = await resolveModel([DEEPSEEK], WITH_KEY, { KYCLAW_FORCE_MOCK: '0' })

    expect(resolved.source).toBe('openai-compatible')
  })
})

describe('selectProviderConfig · 默认标记优先', () => {
  it('有默认标记就选它（即便它不是第一条）；没有默认就是第一条', () => {
    const openai: ProviderConfig = { ...DEEPSEEK, id: 'openai', isDefault: false }
    const anthropic: ProviderConfig = {
      id: 'anthropic',
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      isDefault: false
    }

    expect(selectProviderConfig([openai, DEEPSEEK])?.id).toBe('deepseek')
    expect(selectProviderConfig([openai, anthropic])?.id).toBe('openai')
    expect(selectProviderConfig([])).toBeUndefined()
  })

  it('resolveModel 按默认标记取密钥（用的是选中那条的 id）', async () => {
    const openai: ProviderConfig = { ...DEEPSEEK, id: 'openai', isDefault: false }
    const readKey = vi.fn(keyReader({ deepseek: KEY }))

    const resolved = await resolveModel([openai, DEEPSEEK], readKey, {})

    expect(readKey).toHaveBeenCalledWith('deepseek')
    expect(resolved.source).toBe('openai-compatible')
    expect(modelInfo(resolved.model).modelId).toBe('deepseek-flash')
  })
})

describe('resolveModel · 配齐了就是真模型', () => {
  it('openai-compatible（非 DeepSeek 端点）→ 通用兼容层，baseUrl/model 透传', async () => {
    const local: ProviderConfig = {
      ...DEEPSEEK,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:8b',
      isDefault: false
    }

    const resolved = await resolveModel([local], WITH_KEY, {})

    expect(resolved.source).toBe('openai-compatible')
    expect(resolved.mockReason).toBeUndefined()
    expect(modelInfo(resolved.model).provider).toBe('kyclaw-openai-compatible.chat')
    expect(modelInfo(resolved.model).modelId).toBe('qwen3:8b')
  })

  it('DeepSeek 官方端点 → @ai-sdk/deepseek（reasoning 等自家协议能力贴着官方包）', async () => {
    const resolved = await resolveModel([DEEPSEEK], WITH_KEY, {})

    expect(resolved.source).toBe('openai-compatible')
    expect(modelInfo(resolved.model).provider).toBe('deepseek.chat')
    expect(modelInfo(resolved.model).modelId).toBe('deepseek-flash')
  })

  it('DeepSeek 官方端点带 /v1 也认（用户照官方文档写得更多样）', async () => {
    const withV1: ProviderConfig = { ...DEEPSEEK, baseUrl: 'https://api.deepseek.com/v1' }

    const resolved = await resolveModel([withV1], WITH_KEY, {})

    expect(modelInfo(resolved.model).provider).toBe('deepseek.chat')
  })

  it('anthropic → anthropic.messages（走官方端点，不需要 baseUrl）', async () => {
    const anthropic: ProviderConfig = {
      id: 'anthropic',
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      isDefault: true
    }

    const resolved = await resolveModel([anthropic], WITH_KEY, {})

    expect(resolved.source).toBe('anthropic')
    expect(modelInfo(resolved.model).provider).toBe('anthropic.messages')
    expect(modelInfo(resolved.model).modelId).toBe('claude-sonnet-4-5')
  })
})

describe('resolveModel · 半截配置显式报错（不静默回落 mock）', () => {
  it('有 type/model/baseUrl 但没有 key → "配置不完整：缺 API 密钥"', async () => {
    const promise = resolveModel([DEEPSEEK], keyReader(), {})

    await expect(promise).rejects.toThrow(ProviderConfigError)
    await expect(promise).rejects.toThrow(/配置不完整：缺 API 密钥/)
  })

  it('openai-compatible 缺 baseUrl → "缺 Base URL"', async () => {
    const noBase: ProviderConfig = { ...DEEPSEEK, baseUrl: undefined }

    await expect(resolveModel([noBase], WITH_KEY, {})).rejects.toThrow(/配置不完整：缺 Base URL/)
  })

  it('模型名为空 → "缺模型名"；多项缺失按 模型 → Base URL → 密钥 报全', async () => {
    const empty: ProviderConfig = { ...DEEPSEEK, model: '  ', baseUrl: undefined }

    await expect(resolveModel([empty], keyReader(), {})).rejects.toThrow(
      /配置不完整：缺模型名；配置不完整：缺 Base URL；配置不完整：缺 API 密钥/
    )
  })

  it('错误里带 provider id（设置页能指到是哪条配置）', async () => {
    await expect(resolveModel([DEEPSEEK], keyReader(), {})).rejects.toThrow(/deepseek/)
  })
})
