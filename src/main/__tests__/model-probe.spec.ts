// @vitest-environment node
/**
 * round 22 / 48 · 模型能力探测：
 *   ① 元数据（GET /models）：解析纯函数（三种数组形态 / 缺字段 / 异常形状）、抓取（URL / Bearer 头 /
 *      非 200 / 无 baseUrl 跳过）、落盘（键 = `<providerId>:<modelId>`，并入现有记录、别的 provider 不动）、
 *      静默失败（不抛、只 warn）、启动批量（逐个 provider）；
 *   ② 视觉（round 48，真发一条带图 chat）：结论分类（2xx=true / 明确拒图=false / 其余不写）、
 *      两种协议的请求形态（openai 兼容的 image_url data URL、Anthropic 的 base64 image block）、
 *      落盘只写 `vision`（不动元数据字段）、没有密钥跳过、同 provider 并发去重。
 * 全部注入式：不碰 electron、不碰真网络；密钥读取用假件（本测试里"密钥"就是一条常量）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyVisionProbe,
  fetchProviderModels,
  fetchVisionSupport,
  parseModelsPayload,
  probeConfiguredProvidersQuietly,
  probeProviderModels,
  probeProviderModelsQuietly,
  probeProviderVision,
  probeProviderVisionQuietly
} from '../model-probe'
import { readSettings, settingsPath, writeSettings } from '../settings'
import { defaultSettings } from '../../shared/settings'

/** 主控在官方端点上实测到的形状（脱敏转录；不含任何密钥字段） */
const DEEPSEEK_LIST = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'low' }
    }
  ]
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-probe-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('parseModelsPayload（纯函数）', () => {
  it('`{data:[...]}`（OpenAI/DeepSeek 形态）：id → 元数据，effort 拆成 efforts/defaultEffort', () => {
    expect(parseModelsPayload(DEEPSEEK_LIST)).toEqual({
      'deepseek-flash': {
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high'
      },
      'deepseek-v4-pro': {
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'low'
      }
    })
  })

  it('`{models:[...]}` / 顶层数组 / 单个对象：三种形态都认', () => {
    const one = { id: 'm', context_window: 1000 }
    expect(parseModelsPayload({ models: [one] })).toEqual({ m: { contextWindow: 1000 } })
    expect(parseModelsPayload([one])).toEqual({ m: { contextWindow: 1000 } })
    expect(parseModelsPayload(one)).toEqual({ m: { contextWindow: 1000 } })
  })

  it('缺字段：没有有效 context_window 的条目整条跳过；effort 缺省/坏形状 = 无挡位', () => {
    const payload = {
      data: [
        { id: 'no-context' },
        { id: 'bad-context', context_window: 0 },
        { id: 'ok', context_window: 200_000 },
        { id: 'effort-broken', context_window: 300_000, effort: 'high' },
        { id: '', context_window: 400_000 },
        { context_window: 500_000 }
      ]
    }
    expect(parseModelsPayload(payload)).toEqual({
      ok: { contextWindow: 200_000 },
      'effort-broken': { contextWindow: 300_000 }
    })
  })

  it('effort 细节：supported_levels 里的 default 剔除；default_level 必须在列表里才采信', () => {
    const parsed = parseModelsPayload({
      data: [
        {
          id: 'm',
          context_window: 1000,
          effort: { supported_levels: ['default', 'high'], default_level: 'bogus' }
        }
      ]
    })
    // 'default' 是本地"不传"语义，不进挡位表；default_level 不在 supported_levels 里 → 不采信
    expect(parsed.m).toEqual({ contextWindow: 1000, efforts: ['high'] })
  })

  it('异常形状：字符串 / null / 无数组 → 空表（不抛）', () => {
    expect(parseModelsPayload('nope')).toEqual({})
    expect(parseModelsPayload(null)).toEqual({})
    expect(parseModelsPayload({ nothing: true })).toEqual({})
    expect(parseModelsPayload({ data: 'nope' })).toEqual({})
  })
})

describe('fetchProviderModels（抓取）', () => {
  it('URL = baseUrl 去尾斜杠 + /models；Bearer 头；回包进解析', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DEEPSEEK_LIST))
    const models = await fetchProviderModels(
      { type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/' },
      'sk-test',
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/models')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test')
    expect(models['deepseek-flash']?.contextWindow).toBe(1_048_576)
  })

  it('非 200 → 抛（状态码进文案，不含密钥）；没有 baseUrl（Anthropic 官方域）→ 空表跳过', async () => {
    const failing = vi.fn(async () => jsonResponse({ error: 'nope' }, 401))
    await expect(
      fetchProviderModels(
        { type: 'openai-compatible', baseUrl: 'https://api.example.com' },
        'sk-secret-value',
        { fetchImpl: failing as unknown as typeof fetch }
      )
    ).rejects.toThrow(/401/)

    const never = vi.fn()
    expect(
      await fetchProviderModels({ type: 'anthropic', baseUrl: undefined }, 'sk-x', {
        fetchImpl: never as unknown as typeof fetch
      })
    ).toEqual({})
    expect(never).not.toHaveBeenCalled()
  })
})

describe('probeProviderModels（落盘）', () => {
  const file = (): string => settingsPath(dir)

  function seed(providers: { id: string; baseUrl?: string }[]): void {
    writeSettings(file(), {
      ...defaultSettings(),
      providers: providers.map((provider) => ({
        id: provider.id,
        type: 'openai-compatible' as const,
        baseUrl: provider.baseUrl ?? 'https://api.deepseek.com',
        model: 'deepseek-flash',
        isDefault: true
      })),
      // 预置一条别的 provider 的记录：探测不能碰它
      probedModels: {
        'other:kmodel': { contextWindow: 222_000, fetchedAt: '2026-10-01T00:00:00.000Z' }
      }
    })
  }

  it('抓取成功：并入 probedModels（键 = providerId:modelId、盖 fetchedAt），别的记录不动', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn(async () => jsonResponse(DEEPSEEK_LIST))

    const next = await probeProviderModels({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-10-11T12:00:00.000Z')
    })

    expect(next.probedModels['ds:deepseek-flash']).toEqual({
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      fetchedAt: '2026-10-11T12:00:00.000Z'
    })
    expect(next.probedModels['ds:deepseek-v4-pro']?.defaultEffort).toBe('low')
    expect(next.probedModels['other:kmodel']).toEqual({
      contextWindow: 222_000,
      fetchedAt: '2026-10-01T00:00:00.000Z'
    })
    // 真落盘（回读同一份）
    expect(readSettings(file()).probedModels['ds:deepseek-flash']?.contextWindow).toBe(1_048_576)
  })

  it('provider 不存在 / 没有密钥 / 没有 baseUrl：原样回当前设置，不发请求', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn()
    const deps = { file: file(), fetchImpl: fetchImpl as unknown as typeof fetch }

    expect(
      (await probeProviderModels({ ...deps, readKey: () => null, providerId: 'ds' })).probedModels
    ).toEqual({ 'other:kmodel': { contextWindow: 222_000, fetchedAt: '2026-10-01T00:00:00.000Z' } })
    expect(
      (await probeProviderModels({ ...deps, readKey: () => null, providerId: 'nope' })).providers
    ).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('静默版（组合入口）：两趟都失败只 warn、回当前设置（不抛）', async () => {
    seed([{ id: 'ds' }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500))

    const next = await probeProviderModelsQuietly({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    // 500 既不是"能"也不是"明确不能"：什么都没有写下来（元数据那趟抛、视觉那趟回 null）
    expect(next.probedModels['ds:deepseek-flash']).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('组合入口：元数据那趟挂了（404）也不耽误视觉那趟——结论照样写下来', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/models') ? jsonResponse({ error: 'nope' }, 404) : jsonResponse({})
    )

    const next = await probeProviderModelsQuietly({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(next.probedModels['ds:deepseek-flash']).toEqual({ vision: true })
  })

  it('组合入口：视觉那趟问不出结论（401）时，元数据那趟的成果原样保留', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/models')
        ? jsonResponse(DEEPSEEK_LIST)
        : jsonResponse({ error: { message: 'invalid api key' } }, 401)
    )

    const next = await probeProviderModelsQuietly({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-10-11T12:00:00.000Z')
    })

    expect(next.probedModels['ds:deepseek-flash']).toEqual({
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      fetchedAt: '2026-10-11T12:00:00.000Z'
    })
  })

  it('两趟互不覆盖：先写过视觉的模型，元数据那趟不该把它抹掉', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/models') ? jsonResponse(DEEPSEEK_LIST) : jsonResponse({})
    )
    const input = {
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch
    }

    await probeProviderVision(input) // 先只有视觉结论
    expect(readSettings(file()).probedModels['ds:deepseek-flash']).toEqual({ vision: true })

    const next = await probeProviderModels(input) // 再补元数据
    expect(next.probedModels['ds:deepseek-flash']).toMatchObject({
      contextWindow: 1_048_576,
      vision: true
    })
  })
})

describe('classifyVisionProbe（纯函数：什么才算"能 / 不能看图"）', () => {
  it('2xx → true（端点收下了这条带图请求）', () => {
    expect(classifyVisionProbe(200, '{"choices":[]}')).toBe(true)
    expect(classifyVisionProbe(201, '')).toBe(true)
  })

  it('400 / 415 / 422 且错误体点名图片 / 模态 → false（端点明确拒图）', () => {
    for (const body of [
      '{"error":{"message":"messages[0].content[1]: unknown variant `image_url`, expected `text`"}}',
      '{"detail":"model does not support image input"}',
      '{"error":"this model does not support vision"}',
      '{"error":{"message":"multimodal input is not available for this model"}}',
      'unsupported media type: image/png'
    ]) {
      expect(classifyVisionProbe(400, body), body).toBe(false)
    }
    expect(classifyVisionProbe(415, '{"error":"media type not supported"}')).toBe(false)
    expect(classifyVisionProbe(422, '{"detail":"modality image not accepted"}')).toBe(false)
  })

  it('别的 400（不点名图片）/ 认证 / 限流 / 5xx → null：不知道就别写，绝不误标', () => {
    // max_tokens、参数写法之类的错也有 400，但它跟"能不能看图"没关系
    expect(classifyVisionProbe(400, '{"error":{"message":"max_tokens must be >= 1"}}')).toBeNull()
    expect(classifyVisionProbe(422, '{"error":{"message":"invalid request"}}')).toBeNull()
    expect(classifyVisionProbe(401, '{"error":"image"}')).toBeNull()
    expect(classifyVisionProbe(403, 'forbidden')).toBeNull()
    expect(classifyVisionProbe(404, 'model not found')).toBeNull()
    expect(classifyVisionProbe(429, 'rate limit exceeded')).toBeNull()
    expect(classifyVisionProbe(500, 'internal error')).toBeNull()
    expect(classifyVisionProbe(503, 'image service down')).toBeNull()
  })

  it('"你这张图不合法"类的 400 → null（图的问题不是能力问题；这句在真端点上实测到过）', () => {
    // 2026-10-12 实测原样回包（DeepSeek 官方端点，收到的是一张结构不完整的 PNG）
    expect(
      classifyVisionProbe(
        400,
        '{"error":{"message":".messages[0].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif."}}'
      )
    ).toBeNull()
    expect(classifyVisionProbe(400, '{"error":"image is not valid"}')).toBeNull()
    expect(classifyVisionProbe(422, '{"detail":"image too large"}')).toBeNull()
  })
})

describe('fetchVisionSupport（真发一条带图请求）', () => {
  it('openai 兼容：POST /chat/completions；content 里是 image_url data URL（真 1×1 PNG）；Bearer 头', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }))
    const verdict = await fetchVisionSupport(
      {
        type: 'openai-compatible',
        model: 'my-vision-model',
        baseUrl: 'https://api.example.com/v1/'
      },
      'sk-test',
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(verdict).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test')

    const body = JSON.parse(String(init.body)) as {
      model: string
      max_tokens: number
      stream: boolean
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    expect(body.model).toBe('my-vision-model')
    expect(body.max_tokens).toBe(1)
    expect(body.stream).toBe(false)
    const image = body.messages[0]?.content[1] as {
      type: string
      image_url: { url: string }
    }
    expect(image.type).toBe('image_url')
    expect(image.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    // 真图（不是占位串）：解出来得是 PNG 签名 + 1×1 的 IHDR（端点会校验它）
    const bytes = Buffer.from(image.image_url.url.split(',')[1] ?? '', 'base64')
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(bytes.readUInt32BE(16)).toBe(1) // IHDR width
    expect(bytes.readUInt32BE(20)).toBe(1) // IHDR height
  })

  it('Anthropic：没有 baseUrl 走官方域 `/v1/messages`；x-api-key + 版本头；base64 image block', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: [] }))
    const verdict = await fetchVisionSupport(
      { type: 'anthropic', model: 'claude-sonnet-4-5' },
      'sk-ant',
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(verdict).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = new Headers(init.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')

    const body = JSON.parse(String(init.body)) as {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    expect(body.max_tokens).toBe(1)
    const image = body.messages[0]?.content[1] as {
      type: string
      source: { type: string; media_type: string; data: string }
    }
    expect(image.type).toBe('image')
    expect(image.source).toMatchObject({ type: 'base64', media_type: 'image/png' })
    expect(Buffer.from(image.source.data, 'base64').readUInt32BE(16)).toBe(1)
  })

  it('自定义 baseUrl 的 Anthropic 用它；没模型名 / openai 兼容没 baseUrl → 不发请求（null）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    await fetchVisionSupport(
      { type: 'anthropic', model: 'm', baseUrl: 'https://proxy.example.com/anthropic/' },
      'sk-x',
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined
    expect(call?.[0]).toBe('https://proxy.example.com/anthropic/messages')

    const never = vi.fn()
    expect(
      await fetchVisionSupport(
        { type: 'openai-compatible', model: '', baseUrl: 'https://a/v1' },
        'sk',
        {
          fetchImpl: never as unknown as typeof fetch
        }
      )
    ).toBeNull()
    expect(
      await fetchVisionSupport({ type: 'openai-compatible', model: 'm', baseUrl: '  ' }, 'sk', {
        fetchImpl: never as unknown as typeof fetch
      })
    ).toBeNull()
    expect(never).not.toHaveBeenCalled()
  })

  it('超时 / 网络错：抛给调用方（静默包装负责吞）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError')
    })
    await expect(
      fetchVisionSupport(
        { type: 'openai-compatible', model: 'm', baseUrl: 'https://a/v1' },
        'sk-secret-value',
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).rejects.toThrow()
  })
})

describe('probeProviderVision（落盘：结论写进 probedModels 的 vision）', () => {
  const file = (): string => settingsPath(dir)

  function seed(providers: { id: string; model?: string }[], probedModels = {}): void {
    writeSettings(file(), {
      ...defaultSettings(),
      providers: providers.map((provider) => ({
        id: provider.id,
        type: 'openai-compatible' as const,
        baseUrl: 'https://api.deepseek.com',
        model: provider.model ?? 'deepseek-flash',
        isDefault: true
      })),
      probedModels: {
        'other:kmodel': { contextWindow: 222_000, fetchedAt: '2026-10-01T00:00:00.000Z' },
        ...probedModels
      }
    })
  }

  it('2xx → vision: true，写进 `<providerId>:<model>`；别的记录不动；只探当前模型', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }))

    const next = await probeProviderVision({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(next.probedModels['ds:deepseek-flash']).toEqual({ vision: true })
    expect(next.probedModels['other:kmodel']).toEqual({
      contextWindow: 222_000,
      fetchedAt: '2026-10-01T00:00:00.000Z'
    })
    // 真落盘（回读同一份）
    expect(readSettings(file()).probedModels['ds:deepseek-flash']?.vision).toBe(true)
    // 只发一趟、只探当前模型（provider.model）
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined
    expect(call?.[0]).toBe('https://api.deepseek.com/chat/completions')
  })

  it('端点明确拒图（400 + image 特征）→ vision: false', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'unknown variant `image_url`' } }, 400)
    )

    const next = await probeProviderVision({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(next.probedModels['ds:deepseek-flash']).toEqual({ vision: false })
  })

  it('认证失败 / 限流 / 超时 → 不写（不知道就不标）', async () => {
    seed([{ id: 'ds' }])

    for (const failing of [
      vi.fn(async () => jsonResponse({ error: { message: 'invalid key' } }, 401)),
      vi.fn(async () => jsonResponse({ error: { message: 'rate limit' } }, 429)),
      vi.fn(async () => {
        throw new DOMException('The operation was aborted', 'TimeoutError')
      })
    ]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const next = await probeProviderVisionQuietly({
        file: file(),
        readKey: () => 'sk-test',
        providerId: 'ds',
        fetchImpl: failing as unknown as typeof fetch
      })
      expect(next.probedModels['ds:deepseek-flash']).toBeUndefined()
      warn.mockRestore()
    }
  })

  it('没有密钥 / provider 不存在 → 不发请求，原样回当前设置', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn()

    expect(
      (
        await probeProviderVision({
          file: file(),
          readKey: () => null,
          providerId: 'ds',
          fetchImpl: fetchImpl as unknown as typeof fetch
        })
      ).probedModels['ds:deepseek-flash']
    ).toBeUndefined()
    expect(
      (
        await probeProviderVision({
          file: file(),
          readKey: () => 'sk',
          providerId: 'nope',
          fetchImpl: fetchImpl as unknown as typeof fetch
        })
      ).providers
    ).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('同 provider 并发去重：同时两发只真发一趟带图请求（后来的搭车）', async () => {
    seed([{ id: 'ds' }])
    let release: () => void = () => {}
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ choices: [] }))
        })
    )
    const input = {
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch
    }

    const first = probeProviderVisionQuietly(input)
    const second = probeProviderVisionQuietly(input)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.probedModels['ds:deepseek-flash']?.vision).toBe(true)
    expect(b.probedModels['ds:deepseek-flash']?.vision).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('probeConfiguredProvidersQuietly（启动批量）', () => {
  it('逐个 provider 各探一次（元数据 + 视觉两趟；串行；失败的 provider 不拖累后面的）', async () => {
    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      providers: [
        {
          id: 'a',
          type: 'openai-compatible',
          baseUrl: 'https://a.example.com',
          model: 'm1',
          isDefault: true
        },
        {
          id: 'b',
          type: 'openai-compatible',
          baseUrl: 'https://b.example.com',
          model: 'm2',
          isDefault: false
        }
      ]
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://a.example.com')) throw new Error('a 挂了')
      return url.endsWith('/models')
        ? jsonResponse({ data: [{ id: 'm2', context_window: 64_000 }] })
        : jsonResponse({ choices: [] })
    })

    await probeConfiguredProvidersQuietly({
      file: settingsPath(dir),
      readKey: () => 'sk-test',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })

    // 两个 provider × 两趟（GET /models + POST 带图 chat）；a 那两趟都挂了，见下面的 warn
    const urls = fetchImpl.mock.calls.map((call) => String(call[0]))
    expect(urls.filter((url) => url.endsWith('/models'))).toHaveLength(2)
    expect(urls.filter((url) => url.endsWith('/chat/completions'))).toHaveLength(2)
    const probed = readSettings(settingsPath(dir)).probedModels
    expect(probed['b:m2']?.contextWindow).toBe(64_000)
    expect(probed['b:m2']?.vision).toBe(true)
    expect(Object.keys(probed)).toEqual(['b:m2'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
