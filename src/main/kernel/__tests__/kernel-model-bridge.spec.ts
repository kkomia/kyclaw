// @vitest-environment node
/**
 * 0.2.2 模型桥（纯函数部分）：kyclaw providers + 密钥 → 内核 settings/credentials 写计划。
 *
 * 背景：0.2.x 对话走 DSH 内核，内核只认它自己的 `llm-deepseek` / `llm-pi-ai` / `agent-default-model`
 * 与 credential store；kyclaw 设置里的 providers 从没桥过去 → 「测试连接成功、发消息却报模型密钥缺失」。
 * 这里钉住映射口径（官方 DeepSeek 走内核自带路由、其它端点走 pi-ai 自定义路由、没可用配置就什么都不写）
 * 与 RPC 落地顺序（凭证 → 路由 → 默认模型）。
 */
import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '../../../shared/providers'
import type { ProbedModel } from '../../../shared/settings'
import {
  buildKernelModelPlan,
  deepseekMessagesBaseUrl,
  deepseekModelsPatch,
  kernelModelSnapshot,
  piAiKeyRef,
  piAiRouteId,
  syncKernelModel,
  usesDeepSeekOfficial,
  activeProviderOf,
  KERNEL_DEEPSEEK_KEY_REF,
  KERNEL_DEEPSEEK_PROVIDER
} from '../kernel-model-bridge'

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'deepseek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    isDefault: true,
    ...overrides
  }
}

function keysOf(map: Record<string, string>): (id: string) => string | null {
  return (id) => map[id] ?? null
}

describe('端点/命名映射', () => {
  it('官方 DeepSeek 的 OpenAI 兼容地址映射到 Messages 端点（/anthropic）', () => {
    expect(deepseekMessagesBaseUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/anthropic'
    )
    expect(deepseekMessagesBaseUrl('https://api.deepseek.com/v1/')).toBe(
      'https://api.deepseek.com/anthropic'
    )
    // 已经写了 /anthropic：原样保留，不叠第二层
    expect(deepseekMessagesBaseUrl('https://api.deepseek.com/anthropic')).toBe(
      'https://api.deepseek.com/anthropic'
    )
    expect(deepseekMessagesBaseUrl(undefined)).toBe('https://api.deepseek.com/anthropic')
  })

  it('pi-ai 路由名/凭证引用名：设置页 id 归一成内核认的形状', () => {
    expect(piAiRouteId('deepseek')).toBe('kyclaw-deepseek')
    expect(piAiRouteId('Custom 1')).toBe('kyclaw-custom-1')
    expect(piAiRouteId('网关')).toBe('kyclaw-provider')
    expect(piAiKeyRef('custom-1')).toBe('KYCLAW_CUSTOM_1_API_KEY')
    expect(piAiKeyRef('网关')).toBe('KYCLAW_PROVIDER_API_KEY')
  })

  it('只有官方 DeepSeek 端点走内核自带路由（anthropic 类型不算）', () => {
    expect(usesDeepSeekOfficial(provider())).toBe(true)
    expect(usesDeepSeekOfficial(provider({ type: 'anthropic' }))).toBe(false)
    expect(usesDeepSeekOfficial(provider({ baseUrl: 'https://api.deepseek.com/anthropic' }))).toBe(
      true
    )
    expect(usesDeepSeekOfficial(provider({ baseUrl: 'https://gw.example.com/v1' }))).toBe(false)
  })
})

describe('生效 provider 选择', () => {
  it('isDefault 优先；模型名为空的半截配置不选', () => {
    const first = provider({ id: 'a', isDefault: false })
    const second = provider({ id: 'b', isDefault: true })
    expect(activeProviderOf([first, second])?.id).toBe('b')
    expect(activeProviderOf([provider({ id: 'x', model: '', isDefault: true })])).toBeUndefined()
    expect(activeProviderOf([])).toBeUndefined()
  })
})

describe('官方 DeepSeek 路由的计划', () => {
  it('写 baseURL + apiKeyEnv + DEEPSEEK_API_KEY；模型已在目录里就不动 models', () => {
    const plan = buildKernelModelPlan({
      providers: [provider()],
      readKey: keysOf({ deepseek: 'sk-test' }),
      deepseekModels: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }
      ]
    })
    expect(plan).not.toBeNull()
    expect(plan?.mode).toBe('deepseek-official')
    expect(plan?.credentials).toEqual([{ ref: KERNEL_DEEPSEEK_KEY_REF, value: 'sk-test' }])
    expect(plan?.defaultModel).toEqual({
      provider: KERNEL_DEEPSEEK_PROVIDER,
      model: 'deepseek-flash'
    })
    const ops = plan?.mutations[0]?.ops ?? []
    expect(plan?.mutations[0]?.ns).toBe('llm-deepseek')
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: 'set', path: ['baseURL'], value: 'https://api.deepseek.com/anthropic' },
        { op: 'set', path: ['apiKeyEnv'], value: KERNEL_DEEPSEEK_KEY_REF }
      ])
    )
    // 模型目录里已有 deepseek-flash：不重写 models（保住内核自带的上下文窗口/图片模态等元数据）
    expect(ops.some((op) => op.op === 'set' && op.path[0] === 'models')).toBe(false)
  })

  it('当前模型不在内核目录里：把「目录 + 缺的条目」一起写回去（不丢已有元数据）', () => {
    const plan = buildKernelModelPlan({
      providers: [provider({ model: 'deepseek-lite' })],
      readKey: keysOf({ deepseek: 'sk-test' }),
      deepseekModels: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
      probedModels: { 'deepseek:deepseek-lite': { contextWindow: 65536 } }
    })
    const modelsOp = plan?.mutations[0]?.ops.find(
      (op): op is { op: 'set'; path: string[]; value: unknown } =>
        op.op === 'set' && op.path[0] === 'models'
    )
    expect(modelsOp?.value).toEqual([
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-lite', contextWindow: 65536 }
    ])
  })

  it('没密钥：不写（官方端点没 key 指过去只会每轮报缺凭证）', () => {
    expect(buildKernelModelPlan({ providers: [provider()], readKey: keysOf({}) })).toBeNull()
  })

  it('从 pi-ai 切回官方路由时，清理我们写过的 kyclaw- 路由（只碰自己的前缀）', () => {
    const plan = buildKernelModelPlan({
      providers: [provider()],
      readKey: keysOf({ deepseek: 'sk-test' }),
      piRoutes: ['kyclaw-custom-1', 'user-own-route'],
      deepseekModels: [{ id: 'deepseek-flash' }]
    })
    const piMutation = plan?.mutations.find((mutation) => mutation.ns === 'llm-pi-ai')
    expect(piMutation?.ops).toEqual([{ op: 'unset', path: ['providers', 'kyclaw-custom-1'] }])
  })
})

describe('pi-ai 自定义路由的计划', () => {
  const custom = provider({
    id: 'custom-1',
    baseUrl: 'https://gw.example.com/v1',
    model: 'gpt-x',
    models: ['gpt-x', 'gpt-y']
  })

  it('openai-compatible：openai-completions + 自带 models（实测元数据带上）', () => {
    const probed: Record<string, ProbedModel> = {
      'custom-1:gpt-x': { contextWindow: 200_000, maxOutputTokens: 8_000, vision: true },
      'custom-1:gpt-y': { contextWindow: 128_000 }
    }
    const plan = buildKernelModelPlan({
      providers: [custom],
      readKey: keysOf({ 'custom-1': 'sk-gw' }),
      probedModels: probed
    })
    expect(plan?.mode).toBe('pi-ai')
    expect(plan?.credentials).toEqual([{ ref: 'KYCLAW_CUSTOM_1_API_KEY', value: 'sk-gw' }])
    expect(plan?.defaultModel).toEqual({ provider: 'kyclaw-custom-1', model: 'gpt-x' })
    expect(plan?.mutations).toHaveLength(1)
    const op = plan?.mutations[0]?.ops[0]
    expect(op?.op).toBe('set')
    if (op?.op !== 'set') throw new Error('expected set op')
    expect(op.path).toEqual(['providers', 'kyclaw-custom-1'])
    expect(op.value).toMatchObject({
      displayName: '自定义 1',
      api: 'openai-completions',
      baseURL: 'https://gw.example.com/v1',
      apiKeyEnv: 'KYCLAW_CUSTOM_1_API_KEY',
      models: [
        { id: 'gpt-x', contextWindow: 200_000, maxTokens: 8_000, input: ['text', 'image'] },
        { id: 'gpt-y', contextWindow: 128_000 }
      ]
    })
  })

  it('anthropic：anthropic-messages + 官方缺省端点；旧 kyclaw 路由被清掉', () => {
    const plan = buildKernelModelPlan({
      providers: [provider({ id: 'anthropic', type: 'anthropic', baseUrl: '', model: 'claude-x' })],
      readKey: keysOf({ anthropic: 'sk-ant' }),
      piRoutes: ['kyclaw-custom-1']
    })
    const llm = plan?.mutations.find((mutation) => mutation.ns === 'llm-pi-ai')
    const setOp = llm?.ops[0]
    expect(setOp?.op).toBe('set')
    if (setOp?.op !== 'set') throw new Error('expected set op')
    expect(setOp.value).toMatchObject({
      api: 'anthropic-messages',
      baseURL: 'https://api.anthropic.com',
      apiKeyEnv: 'KYCLAW_ANTHROPIC_API_KEY'
    })
    expect(llm?.ops.slice(1)).toEqual([{ op: 'unset', path: ['providers', 'kyclaw-custom-1'] }])
  })

  it('本机/内网端点没密钥：只写路由、不写凭证、不带 apiKeyEnv（内核不发 Authorization 头）', () => {
    const plan = buildKernelModelPlan({
      providers: [
        provider({ id: 'custom-2', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local' })
      ],
      readKey: keysOf({})
    })
    expect(plan?.credentials).toEqual([])
    const op = plan?.mutations[0]?.ops[0]
    if (op?.op !== 'set') throw new Error('expected set op')
    expect(op.value).not.toHaveProperty('apiKeyEnv')
  })

  it('半截配置（openai-compatible 缺 Base URL）：不写', () => {
    expect(
      buildKernelModelPlan({
        providers: [provider({ id: 'custom-3', baseUrl: '', model: 'x' })],
        readKey: keysOf({ 'custom-3': 'k' })
      })
    ).toBeNull()
  })
})

describe('内核现况解析（settings/describe 的容错）', () => {
  it('取 llm-deepseek 的模型目录与 llm-pi-ai 已存在的路由名；坏形状一律当空', () => {
    expect(
      kernelModelSnapshot({
        namespaces: [
          {
            ns: 'llm-deepseek',
            value: { models: [{ id: 'deepseek-flash' }, 'bad', { noId: true }] }
          },
          { ns: 'llm-pi-ai', user: { providers: { 'kyclaw-custom-1': {}, x: {} } } }
        ]
      })
    ).toEqual({
      deepseekModels: [{ id: 'deepseek-flash' }, { noId: true }],
      piRoutes: ['kyclaw-custom-1', 'x']
    })
    expect(kernelModelSnapshot(null)).toEqual({ deepseekModels: [], piRoutes: [] })
    expect(kernelModelSnapshot({ namespaces: 'nope' })).toEqual({
      deepseekModels: [],
      piRoutes: []
    })
  })

  it('deepseekModelsPatch 只补缺的条目（已有的原样保留）', () => {
    expect(
      deepseekModelsPatch(
        provider({ model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-extra'] }),
        [{ id: 'deepseek-flash', name: 'F', contextWindow: 1_000_000 }],
        {}
      )
    ).toEqual([
      { id: 'deepseek-flash', name: 'F', contextWindow: 1_000_000 },
      { id: 'deepseek-extra' }
    ])
  })
})

describe('syncKernelModel：RPC 顺序与失败口径', () => {
  it('先写凭证、再写路由、最后指默认模型；返回 applied', async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> | undefined }> = []
    const result = await syncKernelModel(
      async (method, args) => {
        calls.push({ method, args })
        if (method === 'settings/describe') {
          return {
            writable: true,
            hasDocument: true,
            namespaces: [
              {
                ns: 'llm-deepseek',
                value: { models: [{ id: 'deepseek-flash' }] }
              }
            ]
          }
        }
        return undefined
      },
      {
        providers: [provider()],
        readKey: keysOf({ deepseek: 'sk-test' })
      }
    )
    expect(result).toMatchObject({
      applied: true,
      mode: 'deepseek-official',
      route: KERNEL_DEEPSEEK_PROVIDER,
      model: 'deepseek-flash'
    })
    expect(calls.map((call) => call.method)).toEqual([
      'settings/describe',
      'credentials/set',
      'settings/mutate',
      'settings/mutate'
    ])
    expect(calls[1]?.args).toEqual({ ref: KERNEL_DEEPSEEK_KEY_REF, value: 'sk-test' })
    expect(calls[2]?.args).toMatchObject({ ns: 'llm-deepseek' })
    expect(calls[3]?.args).toMatchObject({
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: KERNEL_DEEPSEEK_PROVIDER },
        { op: 'set', path: ['model'], value: 'deepseek-flash' }
      ]
    })
  })

  it('没有可用 provider：只读一次 describe，什么都不写', async () => {
    const calls: string[] = []
    const result = await syncKernelModel(
      async (method) => {
        calls.push(method)
        return { namespaces: [] }
      },
      { providers: [], readKey: keysOf({}) }
    )
    expect(result).toEqual({ applied: false, reason: 'no-usable-provider' })
    expect(calls).toEqual(['settings/describe'])
  })
})
