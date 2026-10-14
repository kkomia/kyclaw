import { describe, expect, it } from 'vitest'
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  DEFAULT_REASONING_TRANSLATE,
  DEFAULT_SETTINGS,
  defaultSettings,
  effectiveReasoningTranslate,
  LANGFUSE_PRESET,
  REASONING_TRANSLATE_PRESET,
  SETTINGS_FILE
} from '../settings'

/**
 * 设置 schema（shared/settings.ts）：主进程落盘、IPC 入参、渲染端消费共用这一份。
 * 这里盯两件事：默认值就是文档写的那几个字段；非法取值一个都不放过。
 */
describe('AppSettings schema', () => {
  it('默认值：跟随系统 / 默认字号 / providers、workspaces、projects、mcpServers、插件与置顶/归档/探测字段为空 / 权限规则为空 / 默认工作区未指认 / Langfuse 未配置 / 语义召回默认开（本地）/ 思考翻译默认关 / 联网搜索默认免费档 / 更新源跟随内置 / PPT 模板自动', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'system',
      fontTier: 'default',
      globalRules: '',
      providers: [],
      workspaces: [],
      defaultWorkspace: null,
      defaultWorkspaceInitialized: false,
      projects: [],
      permissions: { rules: [] },
      mcpServers: [],
      pluginMarketplaces: [],
      installedPlugins: [],
      modelPrefs: {},
      probedModels: {},
      pinnedThreads: [],
      pinnedProjects: [],
      archivedThreads: [],
      archivedProjects: [],
      langfuse: { endpoint: LANGFUSE_PRESET.endpoint, proxyUrl: '' },
      semanticRecall: {
        enabled: true,
        source: 'remote',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'BAAI/bge-m3',
        idleMinutes: 5
      },
      reasoningTranslate: {
        enabled: false,
        mode: 'full',
        baseUrl: 'http://192.168.31.18:8235/v1',
        model: 'Index-Translate-2B',
        targetLanguage: '简体中文'
      },
      webSearch: {
        mode: 'free',
        provider: 'exa',
        exaEndpoint: 'https://mcp.exa.ai/mcp',
        readerEndpoint: 'https://r.jina.ai'
      },
      updateUrl: '',
      // round 75：「工作区之外」那一档缺省 = 每次询问（区外的操作要先过用户）
      outsideWorkspaceMode: 'ask',
      // round 73：fetch 的出站白名单缺省为空（本机/内网地址一个都不放行）
      network: { allowLocalHosts: [] }
    })
    expect(appSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })

  it('落盘文件名固定为 settings.json（与窗口状态的 window-state.json 分开）', () => {
    expect(SETTINGS_FILE).toBe('settings.json')
  })

  it('defaultSettings() 每次给新对象（含新数组），改返回值不污染模块级默认', () => {
    const first = defaultSettings()
    first.theme = 'dark'
    first.providers.push({ id: 'leaked', type: 'anthropic', model: 'm', isDefault: false })
    first.langfuse.endpoint = 'https://leaked.example'
    first.langfuse.proxyUrl = 'http://127.0.0.1:7890'

    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.providers).toEqual([])
    expect(DEFAULT_SETTINGS.langfuse).toEqual({ endpoint: LANGFUSE_PRESET.endpoint, proxyUrl: '' })
    // round 10 的两个新数组同样要新副本
    expect(first.pluginMarketplaces).not.toBe(DEFAULT_SETTINGS.pluginMarketplaces)
    expect(first.installedPlugins).not.toBe(DEFAULT_SETTINGS.installedPlugins)
    expect(defaultSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('主题只收 system / light / dark，字号只收 small / default / large', () => {
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: 'light' }).success).toBe(true)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: 'dark' }).success).toBe(true)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: 'small' }).success).toBe(
      true
    )
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: 'large' }).success).toBe(
      true
    )

    for (const bad of ['blue', 'System', '', 'darkk']) {
      expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: bad }).success, bad).toBe(
        false
      )
    }
    for (const bad of ['huge', 'big', 'Default', 1]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: bad }).success,
        String(bad)
      ).toBe(false)
    }
  })

  it('providers / workspaces 必须是数组（对象与字符串都不合法）', () => {
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, providers: {} }).success).toBe(false)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, workspaces: 'D:/x' }).success).toBe(
      false
    )
  })

  it('providers 元素过不了 provider schema（错 type / 缺 id / 夹带明文 apiKey）→ 整份设置按坏文件处理', () => {
    for (const bad of [
      [{ id: 'x', type: 'gemini', model: 'm', isDefault: false }],
      [{ type: 'anthropic', model: 'm', isDefault: false }],
      [{ id: 'x', type: 'anthropic', model: 'm', isDefault: false, apiKey: 'sk-leaked' }]
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, providers: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('缺键与多键都不合法（strict：落盘文件的字段集合就是 schema 的字段集合）', () => {
    expect(appSettingsSchema.safeParse({ theme: 'system' }).success).toBe(false)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: undefined }).success).toBe(
      false
    )
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, extra: 1 }).success).toBe(false)
    expect(appSettingsSchema.safeParse(null).success).toBe(false)
  })
})

describe('工作区 schema（T10：授权目录 = path + mode）', () => {
  it('元素必须是 {path, mode}，mode 只收 ask / full', () => {
    for (const mode of ['ask', 'full'] as const) {
      const workspaces = [{ path: 'D:\\项目\\demo', mode }]
      expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, workspaces }).success, mode).toBe(
        true
      )
    }

    for (const bad of [
      [{ path: 'D:\\ws' }], // 缺 mode
      [{ mode: 'ask' }], // 缺 path
      [{ path: '', mode: 'ask' }], // 空路径
      [{ path: 'D:\\ws', mode: 'always' }], // 非法模式
      [{ path: 'D:\\ws', mode: 'ask', extra: 1 }] // 多键
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, workspaces: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('补丁 schema 里没有 workspaces：授权目录只能走 workspace:* 通道改（路径要在主进程过原生选择器与校验）', () => {
    expect(appSettingsPatchSchema.safeParse({ workspaces: [] }).success).toBe(false)
    expect(
      appSettingsPatchSchema.safeParse({ workspaces: [{ path: 'D:\\ws', mode: 'full' }] }).success
    ).toBe(false)
    expect(appSettingsPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
  })
})

describe('默认工作区与项目 schema（T18）', () => {
  it('defaultWorkspace 只收 null 或非空字符串；projects 元素必须是 {id, name, path, createdAt}', () => {
    expect(
      appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, defaultWorkspace: 'D:\\ws' }).success
    ).toBe(true)
    expect(
      appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, defaultWorkspace: null }).success
    ).toBe(true)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, defaultWorkspace: '' }).success).toBe(
      false
    )
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, defaultWorkspace: 1 }).success).toBe(
      false
    )

    const project = {
      id: 'p1',
      name: '插件',
      path: 'D:\\ws\\插件',
      createdAt: '2026-10-11T00:00:00.000Z'
    }
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, projects: [project] }).success).toBe(
      true
    )

    for (const bad of [
      [{ name: 'x', path: 'D:\\ws', createdAt: 'x' }], // 缺 id
      [{ ...project, name: '' }], // 空名字
      [{ ...project, path: '' }], // 空路径
      [{ ...project, extra: 1 }], // 多键
      'D:\\ws' // 不是数组
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, projects: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('补丁 schema 里没有 defaultWorkspace / projects：两者都要过主进程的路径校验，各走专用通道', () => {
    expect(appSettingsPatchSchema.safeParse({ defaultWorkspace: 'D:\\ws' }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ defaultWorkspace: null }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ defaultWorkspaceInitialized: true }).success).toBe(
      false
    )
    expect(appSettingsPatchSchema.safeParse({ projects: [] }).success).toBe(false)
    expect(
      appSettingsPatchSchema.safeParse({
        projects: [{ id: 'p', name: 'x', path: 'D:\\ws', createdAt: '2026-10-11T00:00:00.000Z' }]
      }).success
    ).toBe(false)
    // 别的字段照旧可以打补丁
    expect(appSettingsPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
  })
})

describe('插件字段与补丁 schema（round 10）', () => {
  it('补丁 schema 里没有 pluginMarketplaces / installedPlugins：市场与安装记录只能走 plugins:* 通道', () => {
    // 有的话，渲染端就能塞市场 path / 插件 installDir，再借 removeMarketplace / uninstall 删任意目录
    expect(appSettingsPatchSchema.safeParse({ pluginMarketplaces: [] }).success).toBe(false)
    expect(
      appSettingsPatchSchema.safeParse({
        pluginMarketplaces: [
          { id: 'm', name: 'm', source: 'x', kind: 'git', path: 'C:\\任意目录', addedAt: 'x' }
        ]
      }).success
    ).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ installedPlugins: [] }).success).toBe(false)
    expect(
      appSettingsPatchSchema.safeParse({
        installedPlugins: [
          {
            id: 'p',
            marketplaceId: 'm',
            name: 'p',
            installedAt: 'x',
            mcpServerIds: [],
            skillDirs: [],
            installDir: 'C:\\任意目录'
          }
        ]
      }).success
    ).toBe(false)
    // 别的字段照旧可以打补丁
    expect(appSettingsPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
  })
})

describe('权限规则 schema（T13：审批记忆的"永久允许"）', () => {
  it('元素必须是 {tool, workspace, mode:"allow"}，粒度 = 工具 + 工作区', () => {
    const rules = [{ tool: 'write', workspace: 'D:\\项目\\demo', mode: 'allow' }]
    expect(
      appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, permissions: { rules } }).success
    ).toBe(true)

    for (const bad of [
      { rules: [{ tool: 'write', workspace: 'D:\\ws' }] }, // 缺 mode
      { rules: [{ tool: '', workspace: 'D:\\ws', mode: 'allow' }] }, // 空工具名
      { rules: [{ tool: 'write', workspace: '', mode: 'allow' }] }, // 空工作区
      { rules: [{ tool: 'write', workspace: 'D:\\ws', mode: 'deny' }] }, // 只有 allow 会落盘
      { rules: [{ tool: 'write', workspace: 'D:\\ws', mode: 'allow', extra: 1 }] }, // 多键
      { rules: 'D:\\ws' }, // 不是数组
      {} // 缺 rules
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, permissions: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('补丁可以整表替换规则（审批卡的"永久允许"走这条路），但形状必须合法', () => {
    const permissions = { rules: [{ tool: 'edit', workspace: 'D:\\ws', mode: 'allow' }] }
    expect(appSettingsPatchSchema.parse({ permissions })).toEqual({ permissions })
    expect(
      appSettingsPatchSchema.safeParse({ permissions: { rules: [{ tool: 'edit' }] } }).success
    ).toBe(false)
  })
})

describe('Langfuse 设置 schema（T17 / round 67：地址 + 代理，密钥不在这里）', () => {
  it('langfuse 必须是 { endpoint, proxyUrl }（空串 = 没配）；密钥字段一律不收（strict）', () => {
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        langfuse: { endpoint: '', proxyUrl: '' }
      }).success
    ).toBe(true)
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        langfuse: { endpoint: 'https://cloud.langfuse.com', proxyUrl: 'http://127.0.0.1:7890' }
      }).success
    ).toBe(true)

    for (const bad of [
      {},
      { endpoint: 1 },
      { endpoint: '', secretKey: 'sk-leaked' },
      { endpoint: '', proxyUrl: '', extra: 1 },
      'https://cloud.langfuse.com'
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, langfuse: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('缺 proxyUrl（T17 那版落盘的文件）进 schema 不合法——读盘前由 main/settings.ts 补空串', () => {
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        langfuse: { endpoint: 'https://cloud.langfuse.com' }
      }).success
    ).toBe(false)
  })

  it('补丁可以改地址与代理（设置页「追踪」栏走这条路）：整节给全（partial 只放顶层，嵌套仍要完整）', () => {
    expect(
      appSettingsPatchSchema.parse({
        langfuse: { endpoint: 'https://cloud.langfuse.com', proxyUrl: 'http://127.0.0.1:7890' }
      })
    ).toEqual({
      langfuse: { endpoint: 'https://cloud.langfuse.com', proxyUrl: 'http://127.0.0.1:7890' }
    })
    // 只给一半（T17 那版客户端的写法）不再合法：设置页的 saveLangfuse 会先与落盘值合并再写
    expect(
      appSettingsPatchSchema.safeParse({ langfuse: { endpoint: 'https://cloud.langfuse.com' } })
        .success
    ).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ langfuse: { endpoint: 1 } }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ langfuse: { endpoint: '', extra: 1 } }).success).toBe(
      false
    )
  })
})

describe('思考翻译设置 schema（round 32：开关 + 模式 + 服务三项 + 目标语言）', () => {
  it('形状锁死：mode 只收 full / button，五项一个都不能少（strict）', () => {
    const good = {
      enabled: true,
      mode: 'button' as const,
      baseUrl: 'http://192.168.31.18:8235/v1',
      model: 'Index-Translate-2B',
      targetLanguage: '简体中文'
    }
    expect(
      appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, reasoningTranslate: good }).success
    ).toBe(true)

    for (const bad of [
      { ...good, mode: 'auto' },
      { ...good, enabled: 'yes' },
      { ...good, extra: 1 },
      { enabled: true, mode: 'full', baseUrl: '', model: '' }, // 缺 targetLanguage
      'Index-Translate-2B'
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, reasoningTranslate: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('补丁可以改这一组（设置页「思考翻译」组走这条路；密钥不在设置里）', () => {
    const patch = { reasoningTranslate: { ...DEFAULT_REASONING_TRANSLATE, enabled: true } }
    expect(appSettingsPatchSchema.parse(patch)).toEqual(patch)
    expect(
      appSettingsPatchSchema.safeParse({
        reasoningTranslate: { ...DEFAULT_REASONING_TRANSLATE, mode: 'auto' }
      }).success
    ).toBe(false)
  })

  it('预置与生效值：落盘为空串时按预置填（表单与主进程同一份兜底），不回头改写落盘值', () => {
    // 缺省就是预置（用户打开开关即可用）
    expect(effectiveReasoningTranslate(DEFAULT_REASONING_TRANSLATE)).toEqual({
      baseUrl: REASONING_TRANSLATE_PRESET.baseUrl,
      model: REASONING_TRANSLATE_PRESET.model,
      targetLanguage: REASONING_TRANSLATE_PRESET.targetLanguage
    })
    // 用户清空保存 = 空串；本次使用按预置兜底，但落盘值仍是空串（读盘不静默改写）
    const cleared = { ...DEFAULT_REASONING_TRANSLATE, baseUrl: '', model: '', targetLanguage: '' }
    expect(effectiveReasoningTranslate(cleared)).toEqual({
      baseUrl: REASONING_TRANSLATE_PRESET.baseUrl,
      model: REASONING_TRANSLATE_PRESET.model,
      targetLanguage: REASONING_TRANSLATE_PRESET.targetLanguage
    })
    expect(cleared.baseUrl).toBe('')
    // 用户改过的取值原样生效（trim 后）
    expect(
      effectiveReasoningTranslate({
        ...DEFAULT_REASONING_TRANSLATE,
        baseUrl: ' https://api.example.com/v1 ',
        model: ' my-translate ',
        targetLanguage: ' English '
      })
    ).toEqual({
      baseUrl: 'https://api.example.com/v1',
      model: 'my-translate',
      targetLanguage: 'English'
    })
  })
})

describe('模型实测记录（round 22 元数据 + round 48 视觉）', () => {
  it('形状：上下文/挡位/视觉都可选（两趟探测各写各的），取值随键走（不归一模型名）', () => {
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        probedModels: {
          'p1:m': { contextWindow: 1_048_576, efforts: ['low'], vision: true, fetchedAt: 'x' },
          // 只探出视觉（元数据那趟没成）：合法
          'p1:vision-only': { vision: false },
          // 只探出元数据（还没探视觉）：合法
          'p1:meta-only': { contextWindow: 128_000, fetchedAt: 'x' }
        }
      }).success
    ).toBe(true)
    // vision 不是布尔 / 多一个键 → 不收
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        probedModels: { m: { vision: 'yes' } }
      }).success
    ).toBe(false)
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        probedModels: { m: { contextWindow: 1, audio: true } }
      }).success
    ).toBe(false)
    // 上下文必须是正整数
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        probedModels: { m: { contextWindow: 0 } }
      }).success
    ).toBe(false)
  })

  it('补丁可以整表替换（探测落盘走的这条路）', () => {
    expect(appSettingsPatchSchema.parse({ probedModels: { 'p1:m': { vision: true } } })).toEqual({
      probedModels: { 'p1:m': { vision: true } }
    })
    expect(appSettingsPatchSchema.safeParse({ probedModels: { m: 'yes' } }).success).toBe(false)
  })
})

describe('AppSettings 补丁 schema（settings:update 的入参）', () => {
  it('只给要改的字段就是合法补丁（空补丁也合法，等于不改）', () => {
    expect(appSettingsPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(appSettingsPatchSchema.parse({})).toEqual({})
    expect(appSettingsPatchSchema.parse({ fontTier: 'large', providers: [] })).toEqual({
      fontTier: 'large',
      providers: []
    })
  })

  it('非法取值 / 多余键 / 非对象都拒绝', () => {
    expect(appSettingsPatchSchema.safeParse({ theme: 'blue' }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ fontTier: 'huge' }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ evil: 1 }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse('dark').success).toBe(false)
    expect(appSettingsPatchSchema.safeParse(null).success).toBe(false)
  })
})
