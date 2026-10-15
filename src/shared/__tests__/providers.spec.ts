import { describe, expect, it } from 'vitest'
import {
  newCustomProvider,
  providerConfigProblems,
  providerConfigSchema,
  providerFromPreset,
  providerKeyOptional,
  providerLabel,
  providerPreset,
  providerWithBaseUrl,
  PROVIDER_PRESETS,
  registeredModelsOf,
  withDefaultProvider,
  withRegisteredModel,
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

  it('001/002 新增的两个字段都是**可选**的：老落盘文件（没有它们）照样合法，补了也收', () => {
    // 老文件：连键都没有
    expect(providerConfigSchema.safeParse(complete()).success).toBe(true)
    expect(providerConfigSchema.safeParse(complete({ name: undefined })).success).toBe(true)
    expect(providerConfigSchema.safeParse(complete({ models: undefined })).success).toBe(true)

    // 补上：渠道名 + 这条端点注册的模型清单
    const parsed = providerConfigSchema.safeParse(
      complete({ name: '主力端点', models: ['deepseek-flash', 'deepseek-v4-pro'] })
    )
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.models).toEqual(['deepseek-flash', 'deepseek-v4-pro'])

    // 错型照旧拒（名字不是字符串 / 清单里有非字符串）
    expect(providerConfigSchema.safeParse(complete({ name: 1 as never })).success).toBe(false)
    expect(providerConfigSchema.safeParse(complete({ models: ['ok', 1] as never })).success).toBe(
      false
    )
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

  it('openai 兼容的非云主机端点没有 key 也能用（本机服务那类）→ 不报缺项', () => {
    // complete() 的地址是 https://example.invalid/v1（不在预置云主机表里）
    expect(providerConfigProblems(complete(), false)).toEqual([])
    expect(
      providerConfigProblems(complete({ baseUrl: 'http://127.0.0.1:1234/v1' }), false)
    ).toEqual([])
  })

  it('anthropic 没有 key → 缺 API 密钥（官方 SDK 的 x-api-key 必填，不得静默回落 mock）', () => {
    expect(
      providerConfigProblems(
        { id: 'anthropic', type: 'anthropic', model: 'claude-sonnet-4-5', isDefault: true },
        false
      )
    ).toEqual(['配置不完整：缺 API 密钥'])
  })

  it('providerKeyOptional：本机 / 自建端点可以没有密钥，官方云主机与 anthropic 照旧要', () => {
    expect(
      providerKeyOptional({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' })
    ).toBe(true)
    expect(
      providerKeyOptional({ type: 'openai-compatible', baseUrl: 'http://192.168.31.18:8080/v1' })
    ).toBe(true)
    // 预置表里那三个官方云主机：没有密钥就是没填完
    expect(
      providerKeyOptional({ type: 'openai-compatible', baseUrl: 'https://api.deepseek.com' })
    ).toBe(false)
    expect(
      providerKeyOptional({ type: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1' })
    ).toBe(false)
    expect(
      providerKeyOptional({ type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
    ).toBe(false)
    expect(providerKeyOptional({ type: 'anthropic' })).toBe(false)
  })

  it('官方云主机没密钥 → 照旧报缺 API 密钥（原口径）；别的地址不报', () => {
    const deepseek: ProviderConfig = {
      id: 'deepseek',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      isDefault: true
    }
    expect(providerConfigProblems(deepseek, false)).toEqual(['配置不完整：缺 API 密钥'])
    expect(providerConfigProblems(deepseek, true)).toEqual([])
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

  it('模型名为空/全空白 → 缺模型名；openai 兼容族按 模型 → Base URL 顺序报（密钥不在其中）', () => {
    expect(providerConfigProblems(complete({ model: '' }), true)).toEqual(['配置不完整：缺模型名'])
    expect(
      providerConfigProblems(
        { id: 'custom-1', type: 'openai-compatible', model: '  ', isDefault: false },
        false
      )
    ).toEqual(['配置不完整：缺模型名', '配置不完整：缺 Base URL'])
    // 必须密钥的渠道（anthropic，没有 baseUrl 这一项）→ 模型 + 密钥
    expect(
      providerConfigProblems(
        { id: 'anthropic', type: 'anthropic', model: '  ', isDefault: false },
        false
      )
    ).toEqual(['配置不完整：缺模型名', '配置不完整：缺 API 密钥'])
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

  it('002：手填的渠道名优先（预设名也能被盖掉）；空白 = 没填，回落原来的猜法', () => {
    expect(providerLabel(complete({ id: 'deepseek', name: '公司网关' }))).toBe('公司网关')
    expect(providerLabel(complete({ id: 'custom-3', name: '内网 vLLM' }))).toBe('内网 vLLM')
    expect(providerLabel(complete({ id: 'custom-3', name: '   ' }))).toBe('自定义 3')
    expect(providerLabel(complete({ id: 'custom-3', name: '' }))).toBe('自定义 3')
  })
})

describe('001 · 同一条端点的模型清单（registeredModelsOf / withRegisteredModel / providerWithBaseUrl）', () => {
  it('registeredModelsOf：缺字段 = 只有 model 这一个（老配置与单模型通道都是这样）', () => {
    expect(registeredModelsOf(complete({ model: 'deepseek-flash' }))).toEqual(['deepseek-flash'])
    expect(registeredModelsOf(complete({ model: 'deepseek-flash', models: [] }))).toEqual([
      'deepseek-flash'
    ])
  })

  it('registeredModelsOf：显式清单按清单来（去重去空），当前选中的那个一定在内', () => {
    expect(
      registeredModelsOf(complete({ model: 'b', models: ['a', 'b', 'a', '  ', 'c'] }))
    ).toEqual(['a', 'b', 'c'])
    // 当前选中的模型刚被手改过、还没并进清单：把它排在最前（它必须可选/可见）
    expect(registeredModelsOf(complete({ model: 'd', models: ['a', 'b'] }))).toEqual([
      'd',
      'a',
      'b'
    ])
    // 半截配置（模型名空、清单也空）：回空串一条，调用方按通道名兜底显示
    expect(registeredModelsOf(complete({ model: '' }))).toEqual([''])
  })

  it('withRegisteredModel：清单去重追加 + `model` 选中新模型；`isDefault` 不动', () => {
    const single = complete({ model: 'deepseek-flash', isDefault: true })
    const added = withRegisteredModel(single, ' deepseek-v4-pro ')
    expect(added).toEqual({
      ...single,
      model: 'deepseek-v4-pro',
      models: ['deepseek-flash', 'deepseek-v4-pro']
    })
    // 已经注册过：选中它，不重复追加
    expect(withRegisteredModel(added, 'deepseek-flash').models).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro'
    ])
    // 空名 = 不改（弹窗那边已经拦过，这里兜底）
    expect(withRegisteredModel(added, '   ')).toEqual(added)
    // 默认标记属于"哪条通道"，加模型不碰它
    expect(withRegisteredModel({ ...single, isDefault: false }, 'x').isDefault).toBe(false)
  })

  it('providerWithBaseUrl：同一条 baseUrl（尾斜杠/大小写/空白不算差别）就是同一条端点', () => {
    const providers = [
      complete({ id: 'ds', baseUrl: 'https://api.deepseek.com/v1/' }),
      complete({ id: 'custom-1', baseUrl: undefined })
    ]

    expect(providerWithBaseUrl(providers, 'https://API.DeepSeek.com/v1')?.id).toBe('ds')
    expect(providerWithBaseUrl(providers, '  https://api.deepseek.com/v1/  ')?.id).toBe('ds')
    expect(providerWithBaseUrl(providers, 'https://api.openai.com/v1')).toBeUndefined()
    // 空 / 空白 baseUrl 不算"某条端点"（半截配置不该被认领）
    expect(providerWithBaseUrl(providers, '')).toBeUndefined()
    expect(providerWithBaseUrl(providers, '   ')).toBeUndefined()
    // 只认 openai-compatible：anthropic 没有 baseUrl 比较这回事
    expect(
      providerWithBaseUrl(
        [{ id: 'a', type: 'anthropic', baseUrl: 'https://x/v1', model: 'm', isDefault: true }],
        'https://x/v1'
      )
    ).toBeUndefined()
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
