// @vitest-environment node
/**
 * round 22 · 模型元数据探测（GET /models）：
 *   解析纯函数（三种数组形态 / 缺字段 / 异常形状）、抓取（URL / Bearer 头 / 非 200 / 无 baseUrl 跳过）、
 *   落盘（键 = `<providerId>:<modelId>`，并入现有记录、别的 provider 不动）、静默失败（不抛、只 warn）、
 *   启动批量（逐个 provider）。
 * 全部注入式：不碰 electron、不碰真网络；密钥读取用假件（本测试里"密钥"就是一条常量）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchProviderModels,
  parseModelsPayload,
  probeConfiguredProvidersQuietly,
  probeProviderModels,
  probeProviderModelsQuietly
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

  it('静默版：请求失败只 warn、回当前设置（不抛）', async () => {
    seed([{ id: 'ds' }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500))

    const next = await probeProviderModelsQuietly({
      file: file(),
      readKey: () => 'sk-test',
      providerId: 'ds',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(next.probedModels['ds:deepseek-flash']).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('probeConfiguredProvidersQuietly（启动批量）', () => {
  it('逐个 provider 各探一次（串行；失败的 provider 不拖累后面的）', async () => {
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
      return jsonResponse({ data: [{ id: 'm2', context_window: 64_000 }] })
    })

    await probeConfiguredProvidersQuietly({
      file: settingsPath(dir),
      readKey: () => 'sk-test',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const probed = readSettings(settingsPath(dir)).probedModels
    expect(probed['b:m2']?.contextWindow).toBe(64_000)
    expect(Object.keys(probed)).toEqual(['b:m2'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
