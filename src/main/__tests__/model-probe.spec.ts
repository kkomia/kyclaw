// @vitest-environment node
/**
 * round 22 / 48 · 模型能力探测：
 *   ① 元数据（GET /models）：解析纯函数（三种数组形态 / 缺字段 / 异常形状）、抓取（URL / Bearer 头 /
 *      非 200 / 无 baseUrl 跳过）、**无密钥照发（本机服务那类；不带 Authorization 头）**、
 *      落盘（键 = `<providerId>:<modelId>`，并入现有记录、别的 provider 不动、问了就盖 fetchedAt）、
 *      静默失败（不抛、只 warn）、启动批量（逐个 provider）；
 *   ② 视觉（round 48，真发一条带图 chat）：结论分类（2xx=true / 明确拒图=false / 其余不写）、
 *      两种协议的请求形态（openai 兼容的 image_url data URL、Anthropic 的 base64 image block）、
 *      落盘只写 `vision`（不动元数据字段）、**没有密钥跳过**（唯一会真烧算力的一趟）、同 provider 并发去重；
 *   ③ 列清单（用户反馈 007）：已保存的走 `listProviderModels`（只读、空表兜底）；还没保存的走
 *      `discoverProviderModels`（地址/密钥现给，失败带原因、成功也可能是空清单；**密钥可留空**，
 *      那一路用真 HTTP 打本机假端点验"不带 Authorization 头也要能列"）。
 * 除了"无密钥"那一组（真 127.0.0.1 HTTP）外全部注入式：不碰 electron、不碰真网络；
 * 密钥读取用假件（本测试里"密钥"就是一条常量）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyVisionProbe,
  discoverProviderModels,
  fetchProviderModels,
  fetchVisionSupport,
  listProviderModels,
  parseModelIds,
  parseModelsPayload,
  probeConfiguredProvidersQuietly,
  probeProviderModels,
  probeProviderModelsQuietly,
  probeProviderVision,
  probeProviderVisionQuietly
} from '../model-probe'
import { isProbedFresh } from '../../shared/models'
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

describe('parseModelIds（用户反馈 006/007：列清单是另一件事，不要求有元数据）', () => {
  it('三种形态都认；没有 context_window / 坏字段的条目**照样列出来**（去重、保序、忽略空 id）', () => {
    expect(parseModelIds(DEEPSEEK_LIST)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(parseModelIds({ models: [{ id: 'm' }, { id: 'n', context_window: 1000 }] })).toEqual([
      'm',
      'n'
    ])
    expect(parseModelIds({ id: 'solo' })).toEqual(['solo'])
    // 重复 id 只留一个；空 id / 没有 id 的条目 / 非对象项不进清单
    expect(
      parseModelIds({ data: [{ id: 'a' }, { id: 'a' }, { id: '  ' }, { context_window: 1 }, 'x'] })
    ).toEqual(['a'])
    expect(parseModelIds('nope')).toEqual([])
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({ data: 'nope' })).toEqual([])
  })

  it('与 parseModelsPayload 的关系：清单能列出来的条目，元数据表里可能没有它（拿不到分母）', () => {
    const payload = { data: [{ id: 'no-context' }, { id: 'ok', context_window: 200_000 }] }
    expect(parseModelIds(payload)).toEqual(['no-context', 'ok'])
    expect(parseModelsPayload(payload)).toEqual({ ok: { contextWindow: 200_000 } })
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

  it('provider 不存在：原样回当前设置，不发请求', async () => {
    seed([{ id: 'ds' }])
    const fetchImpl = vi.fn()

    const missing = await probeProviderModels({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'nope',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(missing.providers).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('无密钥（本机服务那类）**照发** GET /models：不带 Authorization 头，并盖上 fetchedAt', async () => {
    seed([{ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }])
    // 端点列了模型但**不给 context_window**（LM Studio 实测就是这样）
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'deepseek-flash', object: 'model' }] })
    )

    const next = await probeProviderModels({
      file: file(),
      readKey: () => null,
      providerId: 'lmstudio',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-10-11T12:00:00.000Z')
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:1234/v1/models')
    // 空密钥**不带** Authorization（发 `Bearer ` 空串有些网关当无效凭据直接 401）
    expect(new Headers(init.headers).get('authorization')).toBeNull()

    // 问了就盖时间戳 → 24h 内菜单不再重探（"问过"与"问出元数据"是两件事）
    expect(next.probedModels['lmstudio:deepseek-flash']).toEqual({
      fetchedAt: '2026-10-11T12:00:00.000Z'
    })
    expect(
      isProbedFresh(
        next.probedModels['lmstudio:deepseek-flash'],
        Date.parse('2026-10-11T20:00:00.000Z')
      )
    ).toBe(true)
    // **不伪造上下文**：端点没给就不写 contextWindow（消费侧回落注册表，不是"128K 实测"）
    expect(next.probedModels['lmstudio:deepseek-flash']?.contextWindow).toBeUndefined()
    expect(readSettings(file()).probedModels['lmstudio:deepseek-flash']?.fetchedAt).toBe(
      '2026-10-11T12:00:00.000Z'
    )
  })

  it('无密钥但端点**给了** context_window：照样收下（vLLM / llama.cpp 那类会回元数据）', async () => {
    seed([{ id: 'local', baseUrl: 'http://127.0.0.1:8080/v1' }])

    const next = await probeProviderModels({
      file: file(),
      readKey: () => '',
      providerId: 'local',
      fetchImpl: (async () =>
        jsonResponse({
          data: [{ id: 'deepseek-flash', context_window: 32_768 }]
        })) as unknown as typeof fetch,
      now: () => new Date('2026-10-11T12:00:00.000Z')
    })

    expect(next.probedModels['local:deepseek-flash']).toEqual({
      contextWindow: 32_768,
      fetchedAt: '2026-10-11T12:00:00.000Z'
    })
  })

  it('无密钥时的**视觉**那趟仍然不发请求（那是唯一会真烧算力的一趟）', async () => {
    seed([{ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'deepseek-flash', object: 'model' }] })
    )
    const input = {
      file: file(),
      readKey: () => '',
      providerId: 'lmstudio',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-10-11T12:00:00.000Z')
    }

    // 组合入口：元数据那趟跑（第 1 条请求），视觉那趟直接跳过（没有第 2 条 chat 请求）
    const next = await probeProviderModelsQuietly(input)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain('/models')
    expect(next.probedModels['lmstudio:deepseek-flash']?.vision).toBeUndefined()
    // 单独调视觉那趟也一样：没有密钥就不发
    const visionOnly = vi.fn()
    await probeProviderVision({
      ...input,
      fetchImpl: visionOnly as unknown as typeof fetch
    })
    expect(visionOnly).not.toHaveBeenCalled()
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

  it('用户反馈 006：一条元数据都没解析出来也盖 fetchedAt（不然菜单每次打开都重探 + 再发一条付费请求）', async () => {
    seed([{ id: 'ds' }])
    // 端点列了这条模型，但没给 context_window —— 元数据表是空的
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] })
    )
    const now = (): Date => new Date('2026-10-11T12:00:00.000Z')

    const next = await probeProviderModels({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now
    })

    // 没有元数据，但"刚问过这个端点"这件事写下来了 → 24h 内不再重探（止住重复的带图请求）
    expect(next.probedModels['ds:deepseek-flash']).toEqual({
      fetchedAt: '2026-10-11T12:00:00.000Z'
    })
    expect(
      isProbedFresh(next.probedModels['ds:deepseek-flash'], Date.parse('2026-10-11T13:00:00.000Z'))
    ).toBe(true)
    expect(readSettings(file()).probedModels['ds:deepseek-flash']?.fetchedAt).toBe(
      '2026-10-11T12:00:00.000Z'
    )
    // 别的记录照旧不动
    expect(next.probedModels['other:kmodel']).toEqual({
      contextWindow: 222_000,
      fetchedAt: '2026-10-01T00:00:00.000Z'
    })
  })

  it('用户反馈 006：端点回空清单 / 当前模型不在清单里，也照样盖时间戳（"问过"与"问出东西"是两件事）', async () => {
    seed([{ id: 'ds' }])

    for (const payload of [{ data: [] }, { data: [{ id: '另一个模型', context_window: 1000 }] }]) {
      writeSettings(file(), {
        ...defaultSettings(),
        providers: [
          {
            id: 'ds',
            type: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            isDefault: true
          }
        ]
      })

      const next = await probeProviderModels({
        file: file(),
        readKey: () => 'sk-test',
        providerId: 'ds',
        fetchImpl: (async () => jsonResponse(payload)) as unknown as typeof fetch,
        now: () => new Date('2026-10-11T12:00:00.000Z')
      })

      expect(next.probedModels['ds:deepseek-flash']?.fetchedAt, JSON.stringify(payload)).toBe(
        '2026-10-11T12:00:00.000Z'
      )
    }
  })

  it('没有 baseUrl（Anthropic 官方域）这一轮不探：不写 fetchedAt、不发请求（与既有口径一致）', async () => {
    writeSettings(file(), {
      ...defaultSettings(),
      providers: [
        {
          id: 'claude',
          type: 'anthropic',
          model: 'claude-sonnet-4-5',
          isDefault: true
        }
      ]
    })
    const fetchImpl = vi.fn()

    const next = await probeProviderModels({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'claude',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(next.probedModels).toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('listProviderModels（用户反馈 007：只读列出端点上的可选模型）', () => {
  it('id + 有就给上下文长度；URL 与 Bearer 头同探测那一趟；**不落盘**（没有文件参数，结构上就是只读）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ id: 'deepseek-flash', context_window: 1_048_576 }, { id: 'deepseek-v4-pro' }]
      })
    )

    const list = await listProviderModels(
      { type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/' },
      'sk-test',
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(list).toEqual([
      { id: 'deepseek-flash', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-pro' }
    ])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/models')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test')
  })

  it('没有 baseUrl（Anthropic 官方域）→ 空表、不发请求；非 200 → 抛（由 IPC 那层吞成空表）', async () => {
    const never = vi.fn()
    expect(
      await listProviderModels({ type: 'anthropic', baseUrl: undefined }, 'sk-x', {
        fetchImpl: never as unknown as typeof fetch
      })
    ).toEqual([])
    expect(never).not.toHaveBeenCalled()

    await expect(
      listProviderModels(
        { type: 'openai-compatible', baseUrl: 'https://api.example.com' },
        'sk-secret-value',
        { fetchImpl: (async () => jsonResponse({ error: 'nope' }, 404)) as unknown as typeof fetch }
      )
    ).rejects.toThrow(/404/)
  })
})

describe('discoverProviderModels（007 补齐：拿刚填的地址与密钥发现，带原因回来）', () => {
  const listResponse = jsonResponse({
    data: [{ id: 'deepseek-flash', context_window: 1_048_576 }, { id: 'deepseek-v4-pro' }]
  })

  it('读到了：回 {ok:true, models}；URL 与 Bearer 头与探测那一趟同一形状', async () => {
    const fetchImpl = vi.fn(async () => listResponse)

    const result = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: 'https://api.example.com/' },
      'sk-user-typed-value',
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'deepseek-flash', contextWindow: 1_048_576 }, { id: 'deepseek-v4-pro' }]
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/models')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-user-typed-value')
  })

  it('端点回了空清单：是"读取成功但没内容"，不是失败（弹窗要分开说）', async () => {
    const result = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: 'https://api.example.com' },
      'sk-x-value',
      { fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch }
    )

    expect(result).toEqual({ ok: true, models: [] })
  })

  it('缺地址（含 Anthropic 没有 /models 这一路）：不发请求，回一句能照做的人话', async () => {
    const never = vi.fn()
    const deps = { fetchImpl: never as unknown as typeof fetch }

    const missingUrl = await discoverProviderModels(
      { type: 'openai-compatible' },
      'sk-x-value',
      deps
    )
    expect(missingUrl).toEqual({ ok: false, message: '先填 Base URL，再发现模型' })
    expect(await discoverProviderModels({ type: 'anthropic' }, 'sk-x-value', deps)).toEqual({
      ok: false,
      message: '这个渠道走官方端点，没有模型清单可读：直接手填模型名'
    })
    expect(never).not.toHaveBeenCalled()
  })

  it('认证失败 / 没有 /models / 网络错：各自回对应的原因，且**不含密钥**', async () => {
    const key = 'sk-discovery-9f2c-SECRET'

    const unauthorized = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: 'https://api.example.com' },
      key,
      { fetchImpl: (async () => jsonResponse({ error: key }, 401)) as unknown as typeof fetch }
    )
    expect(unauthorized).toEqual({
      ok: false,
      message: '认证失败（401）：换一把能访问这个端点的 API Key 再试'
    })

    const missing = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: 'https://api.example.com' },
      key,
      { fetchImpl: (async () => jsonResponse({}, 404)) as unknown as typeof fetch }
    )
    expect(missing).toEqual({
      ok: false,
      message: '这个端点没有模型清单（/models 不存在）：直接手填模型名'
    })

    const offline = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' },
      key,
      { timeoutMs: 300 }
    )
    expect(offline.ok).toBe(false)
    expect(JSON.stringify(offline)).not.toContain(key)
  })

  it('超时：回一句"读模型清单超时"，不把异常抛给调用方', async () => {
    const result = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: 'https://api.example.com' },
      'sk-timeout-value',
      {
        timeoutMs: 50,
        fetchImpl: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          })) as unknown as typeof fetch
      }
    )

    expect(result).toEqual({ ok: false, message: '读模型清单超时（50ms）：检查 Base URL 或网络' })
  })
})

/**
 * 无密钥的那条路（用户反馈 007 的补充）：LM Studio / llama.cpp / ollama 这类**本机服务**
 * 压根不要 API Key，前端"必须填密钥"的一刀切会把离线用法挡死。所以这里用**真 HTTP**
 * （127.0.0.1 随机端口）验两件事：空密钥也要真发请求、且**不带 Authorization 头**；
 * 要不要认证由服务自己回（401 时照它说"这个端点需要 API Key"）。
 */
describe('discoverProviderModels · 无密钥（本机服务那类）', () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

  /** 起一个只服务本用例的假 /models 端点，并记下每趟请求的 URL 与 Authorization 头 */
  async function fakeModelsEndpoint(
    handle: (request: IncomingMessage, response: ServerResponse) => void
  ): Promise<{ baseUrl: string; seen: Array<{ url?: string; authorization?: string }> }> {
    const seen: Array<{ url?: string; authorization?: string }> = []
    const server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization })
      handle(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    servers.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    })
    return { baseUrl: `http://127.0.0.1:${port}/v1`, seen }
  }

  it('空密钥也真发请求：**不带 Authorization 头**，本机服务回 200 就照常列清单', async () => {
    const endpoint = await fakeModelsEndpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'local-model' }, { id: 'qwen3-4b' }] }))
    })

    const result = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: endpoint.baseUrl },
      ''
    )

    expect(result).toEqual({ ok: true, models: [{ id: 'local-model' }, { id: 'qwen3-4b' }] })
    expect(endpoint.seen).toHaveLength(1)
    expect(endpoint.seen[0]?.url).toBe('/v1/models')
    // 空密钥不该发一个 `Bearer ` 空串（有些网关当"无效凭据"直接 401）——压根不带这个头
    expect(endpoint.seen[0]?.authorization).toBeUndefined()
  })

  it('空密钥 + 服务要求认证（401）→ 说"这个端点需要 API Key"，不是"先填密钥"', async () => {
    const endpoint = await fakeModelsEndpoint((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
    })

    const result = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: endpoint.baseUrl },
      '   '
    )

    expect(result).toEqual({
      ok: false,
      message: '这个端点需要 API Key（401）：填一把再试；本机服务通常不需要'
    })
  })

  it('填了密钥：照旧带 Bearer 头（有密钥就走认证那条路）', async () => {
    const endpoint = await fakeModelsEndpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'cloud-model' }] }))
    })

    const result = await discoverProviderModels(
      { type: 'openai-compatible', baseUrl: endpoint.baseUrl },
      'sk-local-typed'
    )

    expect(result).toEqual({ ok: true, models: [{ id: 'cloud-model' }] })
    expect(endpoint.seen[0]?.authorization).toBe('Bearer sk-local-typed')
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
