/**
 * resolveModel：把 settings.providers + 密钥翻译成模型。本文件盯四件事（全部假 key、零真实网络）：
 *   1. mock **只有两个入口**（KYCLAW_FORCE_MOCK=1 / 一条 provider 都没配）；
 *   2. 选哪条配置（默认标记优先，没有默认就是第一条）；
 *   3. 配齐了走哪个 SDK（openai-compatible / DeepSeek 官方包 / anthropic 的 provider 名）；
 *   4. **半截配置必须显式报错**（"配置不完整：缺 X"），绝不静默回落 mock。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../shared/providers'
import {
  MOCK_REPLY_CHUNKS,
  MOCK_WRITE_CONTENT,
  mockWriteTarget,
  resolveModel,
  ProviderConfigError,
  selectProviderConfig
} from '../model'

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

describe('内置 mock · 写文件口令（T16 E2E 的审批冒烟入口）', () => {
  /** 跑一遍 mock 的 doStream，把流里的 part 收成数组（真身是什么就断言什么） */
  async function streamParts(prompt: unknown): Promise<Array<Record<string, unknown>>> {
    const resolved = await resolveModel([], keyReader(), {})
    const mock = resolved.model as unknown as {
      doStream: (options: unknown) => Promise<{
        stream: ReadableStream<Record<string, unknown>>
      }>
    }
    const { stream } = await mock.doStream({ prompt })
    const parts: Array<Record<string, unknown>> = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    return parts
  }

  interface PromptMessage {
    role: string
    content: Array<{ type: string; text: string }>
  }

  function userText(text: string): PromptMessage[] {
    return [{ role: 'user', content: [{ type: 'text', text }] }]
  }

  it('末条 user 消息带 [[write:路径]] → 吐一次 write 工具调用（路径 + 固定内容）', async () => {
    const parts = await streamParts(userText('帮我写个文件 [[write:demo.txt]]'))

    const call = parts.find((part) => part.type === 'tool-call')
    expect(call).toMatchObject({ toolName: 'write' })
    expect(JSON.parse(String(call?.input))).toEqual({
      path: 'demo.txt',
      content: MOCK_WRITE_CONTENT
    })
    // 收尾是 tool-calls（不是 stop）：Mastra 据此去执行工具、再续跑一轮
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'tool-calls' } })
  })

  it('续跑（末条是 tool 消息）不再吐工具调用：只回离线文本，不自己咬尾巴', async () => {
    const parts = await streamParts([
      { role: 'user', content: [{ type: 'text', text: '帮我写个文件 [[write:demo.txt]]' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好，我来创建这个文件。' }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'mock-write', toolName: 'write', output: '已创建' }
        ]
      }
    ])

    expect(parts.some((part) => part.type === 'tool-call')).toBe(false)
    expect(
      parts
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.delta)
        .join('')
    ).toBe(MOCK_REPLY_CHUNKS.join(''))
  })

  it('普通正文（没有口令）→ 还是那三段离线文本', async () => {
    const parts = await streamParts(userText('你好'))

    expect(parts.some((part) => part.type === 'tool-call')).toBe(false)
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'stop' } })
  })

  it('口令解析：只认末条 user 消息、路径到 ] 或换行为止', () => {
    expect(mockWriteTarget(userText('[[write:a/b.txt]] 麻烦你了'))).toBe('a/b.txt')
    expect(mockWriteTarget(userText('第一行\n[[write:c.txt]]\n第三行'))).toBe('c.txt')
    expect(
      mockWriteTarget([{ role: 'assistant', content: [{ type: 'text', text: '[[write:x]]' }] }])
    ).toBeNull()
    expect(mockWriteTarget(userText('没有口令'))).toBeNull()
  })
})

describe('resolveModel · 半截配置显式报错（不静默回落 mock）', () => {
  it('openai 兼容族**没有 key 也照解析**（本机 / 自建端点那类；不再被"缺 API 密钥"拦住）', async () => {
    const local: ProviderConfig = {
      ...DEEPSEEK,
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model'
    }

    const resolved = await resolveModel([local], keyReader(), {})

    expect(resolved.source).toBe('openai-compatible')
    expect(modelInfo(resolved.model).provider).toBe('kyclaw-openai-compatible.chat')
  })

  it('anthropic 没有 key → "配置不完整：缺 API 密钥"（官方 SDK 必填）', async () => {
    const anthropic: ProviderConfig = {
      id: 'anthropic',
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      isDefault: true
    }

    await expect(resolveModel([anthropic], keyReader(), {})).rejects.toThrow(ProviderConfigError)
    await expect(resolveModel([anthropic], keyReader(), {})).rejects.toThrow(
      /配置不完整：缺 API 密钥/
    )
  })

  it('openai-compatible 缺 baseUrl → "缺 Base URL"', async () => {
    const noBase: ProviderConfig = { ...DEEPSEEK, baseUrl: undefined }

    await expect(resolveModel([noBase], WITH_KEY, {})).rejects.toThrow(/配置不完整：缺 Base URL/)
  })

  it('模型名为空 → "缺模型名"；多项缺失按 模型 → Base URL 报全', async () => {
    const empty: ProviderConfig = { ...DEEPSEEK, model: '  ', baseUrl: undefined }

    await expect(resolveModel([empty], keyReader(), {})).rejects.toThrow(
      /配置不完整：缺模型名；配置不完整：缺 Base URL/
    )
  })

  it('错误里带 provider id（设置页能指到是哪条配置）', async () => {
    const noBase: ProviderConfig = { ...DEEPSEEK, baseUrl: undefined }

    await expect(resolveModel([noBase], keyReader(), {})).rejects.toThrow(/deepseek/)
  })
})
