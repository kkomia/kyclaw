import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_REASONING_TRANSLATE,
  DEFAULT_SETTINGS,
  LANGFUSE_PRESET
} from '../../shared/settings'
import {
  initializeDefaultWorkspace,
  readSettings,
  settingsPath,
  updateSettings,
  writeSettings
} from '../settings'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('设置存储（userData 下的 settings.json）', () => {
  it('往返：写进去什么就读出来什么', () => {
    const file = settingsPath(dir)
    const settings = {
      theme: 'dark' as const,
      fontTier: 'large' as const,
      globalRules: '',
      providers: [],
      workspaces: [],
      outsideWorkspaceMode: 'full' as const,
      defaultWorkspace: null,
      defaultWorkspaceInitialized: false,
      closeToTrayMode: 'quit' as const,
      projects: [],
      permissions: { rules: [] },
      mcpServers: [],
      pluginMarketplaces: [],
      installedPlugins: [],
      modelPrefs: {},
      probedModels: {},
      modelOverrides: {},
      pinnedThreads: [],
      pinnedProjects: [],
      archivedThreads: [],
      archivedProjects: [],
      langfuse: {
        enabled: true,
        endpoint: 'https://cloud.langfuse.com',
        proxyUrl: 'http://127.0.0.1:7890'
      },
      semanticRecall: {
        enabled: true,
        source: 'remote' as const,
        baseUrl: '',
        model: '',
        idleMinutes: 5
      },
      reasoningTranslate: {
        enabled: false,
        mode: 'full' as const,
        baseUrl: 'http://192.168.31.18:8235/v1',
        model: 'Index-Translate-2B',
        targetLanguage: '简体中文'
      },
      webSearch: {
        mode: 'free' as const,
        provider: 'exa' as const,
        exaEndpoint: 'https://mcp.exa.ai/mcp',
        readerEndpoint: 'https://r.jina.ai'
      },
      updateUrl: ''
    }

    writeSettings(file, settings)

    expect(readSettings(file)).toEqual(settings)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(settings)
  })

  it('没有落过盘（首启动）→ 默认值', () => {
    expect(readSettings(settingsPath(dir))).toEqual(DEFAULT_SETTINGS)
  })

  it('文件不是 JSON（写坏/被改）→ 默认值，不抛', () => {
    const file = settingsPath(dir)
    writeFileSync(file, '{不是 json', 'utf8')

    expect(readSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('字段过不了 schema（非法主题 / 缺键 / 多键）→ 整个文件当没写过（默认值），不抛', () => {
    const file = settingsPath(dir)

    for (const bad of [
      { ...DEFAULT_SETTINGS, theme: 'blue' },
      { theme: 'dark', fontTier: 'large' },
      { ...DEFAULT_SETTINGS, evil: 1 }
    ]) {
      writeFileSync(file, JSON.stringify(bad), 'utf8')
      expect(readSettings(file), JSON.stringify(bad)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('读出来的默认值是新的（含新数组/新对象），调用方改了不污染模块级默认', () => {
    const first = readSettings(settingsPath(dir))
    first.providers.push({ id: 'leaked', type: 'anthropic', model: 'm', isDefault: false })
    first.workspaces.push({ path: 'D:/leaked', mode: 'ask' })
    first.permissions.rules.push({ tool: 'write', workspace: 'D:/leaked', mode: 'allow' })
    first.projects.push({
      id: 'leaked',
      name: 'leaked',
      path: 'D:/leaked',
      createdAt: '2026-10-11T00:00:00.000Z'
    })
    first.langfuse.endpoint = 'https://leaked.example'

    expect(DEFAULT_SETTINGS.providers).toEqual([])
    expect(DEFAULT_SETTINGS.workspaces).toEqual([])
    expect(DEFAULT_SETTINGS.projects).toEqual([])
    expect(DEFAULT_SETTINGS.permissions.rules).toEqual([])
    expect(DEFAULT_SETTINGS.langfuse).toEqual({
      enabled: true,
      endpoint: LANGFUSE_PRESET.endpoint,
      proxyUrl: ''
    })
  })

  it('旧的落盘文件（T13 之前没有 permissions、T12 之前没有 mcpServers、T18 之前没有 defaultWorkspace/projects、T17 之前没有 langfuse、round 20 之前没有 pinned/archived、round 28 之前没有 semanticRecall、round 32 之前没有 reasoningTranslate、round 45 之前没有 webSearch、round 63 之前没有 updateUrl、round 67 之前没有 langfuse.proxyUrl）读出空值：升级不丢原有设置', () => {
    const file = settingsPath(dir)
    writeFileSync(
      file,
      JSON.stringify({ theme: 'dark', fontTier: 'large', providers: [], workspaces: [] }),
      'utf8'
    )

    expect(readSettings(file)).toEqual({
      theme: 'dark',
      fontTier: 'large',
      globalRules: '',
      providers: [],
      workspaces: [],
      // round 75：旧文件没有「工作区之外」那一档 → 补保守档 ask（缺了会整份设置当坏文件）
      outsideWorkspaceMode: 'ask',
      defaultWorkspace: null,
      defaultWorkspaceInitialized: false,
      // 0.1.3 托盘驻留：关闭偏好是后加的字段 → 老文件（没有旧 hint 标记）补默认档 ask
      closeToTrayMode: 'ask',
      projects: [],
      permissions: { rules: [] },
      mcpServers: [],
      pluginMarketplaces: [],
      installedPlugins: [],
      modelPrefs: {},
      probedModels: {},
      modelOverrides: {},
      pinnedThreads: [],
      pinnedProjects: [],
      archivedThreads: [],
      archivedProjects: [],
      // round 67：T17 之前根本没有 langfuse 这一节（整节缺失）→ 补预置地址 + 空代理；
      // round 86：显式开关也缺 → 补 true（没显式关过 = 开着）
      langfuse: { enabled: true, endpoint: LANGFUSE_PRESET.endpoint, proxyUrl: '' },
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
      updateUrl: ''
    })
  })

  it('用户反馈 003/004：手动覆盖（上下文长度 / 显示名）落盘读回；老文件缺这一节 → 补空表，不丢原有设置', () => {
    const file = settingsPath(dir)
    // 老文件：完全没有 modelOverrides 这一节（strict schema 会整份丢掉，所以迁移必须补空表）
    writeFileSync(
      file,
      JSON.stringify({ theme: 'dark', fontTier: 'large', providers: [], workspaces: [] }),
      'utf8'
    )
    const migrated = readSettings(file)
    expect(migrated.theme).toBe('dark')
    expect(migrated.modelOverrides).toEqual({})

    // 写进去一读回来（键 = `<providerId>:<model>`）
    writeSettings(file, {
      ...DEFAULT_SETTINGS,
      modelOverrides: {
        'ds:deepseek-flash': { contextWindow: 900_000, displayName: '主力模型' },
        'ds:deepseek-v4-pro': { displayName: '深度思考' }
      }
    })
    expect(readSettings(file).modelOverrides).toEqual({
      'ds:deepseek-flash': { contextWindow: 900_000, displayName: '主力模型' },
      'ds:deepseek-v4-pro': { displayName: '深度思考' }
    })

    // 取值不合法（0 / 非整数 / 不是对象 / 多字段）→ 整份当坏文件（既有口径），不半截落盘
    for (const bad of [
      { 'ds:m': { contextWindow: 0 } },
      { 'ds:m': { contextWindow: 1.5 } },
      { 'ds:m': 'nope' },
      { 'ds:m': { nope: 1 } }
    ]) {
      writeFileSync(file, JSON.stringify({ ...DEFAULT_SETTINGS, modelOverrides: bad }), 'utf8')
      expect(readSettings(file), JSON.stringify(bad)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('round 67：T17 那版落盘的 langfuse 只有 endpoint（没有 proxyUrl）——补空串，地址原样留着', () => {
    const file = settingsPath(dir)
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        fontTier: 'large',
        providers: [],
        workspaces: [],
        langfuse: { endpoint: 'http://192.168.31.18:3000' }
      }),
      'utf8'
    )

    const settings = readSettings(file)
    expect(settings.theme).toBe('dark')
    // 老地址一个字符不改（用户想换新地址在设置页里改，迁移不替用户做决定）；
    // round 86：那版也没有显式开关 → 补 true（没显式关过 = 开着）
    expect(settings.langfuse).toEqual({
      enabled: true,
      endpoint: 'http://192.168.31.18:3000',
      proxyUrl: ''
    })
  })

  /**
   * round 86（用户口径 010）：显式开关是后加的字段。老用户"没显式关过"必须还是开着 ——
   * 升级一次就把正在上报的人静默关掉，是这条迁移唯一要防的事。反向那一半同样要钉：
   * 显式存下来的 false 不能被迁移当成"缺省"翻回 true。
   */
  it('round 86：老设置没有 langfuse.enabled → 补 true（不被静默关掉）；显式 false 原样保留', () => {
    const file = settingsPath(dir)
    const base = {
      theme: 'dark',
      fontTier: 'large',
      providers: [],
      workspaces: [],
      langfuse: { endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
    }
    writeFileSync(file, JSON.stringify(base), 'utf8')
    expect(readSettings(file).langfuse).toEqual({
      enabled: true,
      endpoint: 'https://cloud.langfuse.com',
      proxyUrl: ''
    })

    // 用户自己在设置页关过（落盘里明明白白一个 false）→ 读回来还是关着
    writeFileSync(
      file,
      JSON.stringify({
        ...base,
        langfuse: { enabled: false, endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      }),
      'utf8'
    )
    expect(readSettings(file).langfuse.enabled).toBe(false)

    // 这一节被手改坏（enabled 不是布尔）→ 归一到 true，不把整份设置（主题/provider…）当坏文件丢掉
    writeFileSync(
      file,
      JSON.stringify({
        ...base,
        langfuse: { enabled: 'yes', endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      }),
      'utf8'
    )
    const recovered = readSettings(file)
    expect(recovered.theme).toBe('dark')
    expect(recovered.langfuse).toEqual({
      enabled: true,
      endpoint: 'https://cloud.langfuse.com',
      proxyUrl: ''
    })
  })

  /**
   * 0.1.3 托盘驻留：关闭偏好从"首次提示标记"（旧 boolean）迁到三档 mode——老文件必须能被读出来
   * （strict schema 缺键 = 整份设置当坏文件，主题/provider 全丢）。口径：
   *   - 合法的新值优先（用户在新设置页改过就是它）；
   *   - 旧键 `closeToTrayHintShown: true` = 旧行为下"点关闭直接收进托盘"→ 迁成 `tray`（保持旧行为，
   *     不是还原过去按钮选择——旧标记里没有按钮信息）；缺失 / false → `ask`（照旧会问）；
   *   - 非法新值不连累其余设置（退到上面那条旧键规则）；
   *   - 旧键一律剥掉：strict schema 里没有它，留着会让整份设置当坏文件。
   */
  it('0.1.3：关闭偏好迁移——合法新值优先；旧 hint true → tray（保旧行为）；缺/非法 → ask；旧键剥掉', () => {
    const file = settingsPath(dir)
    const legacy = (): Record<string, unknown> => {
      const raw = { ...DEFAULT_SETTINGS } as Record<string, unknown>
      delete raw.closeToTrayMode
      return raw
    }

    // 1) 老文件什么都没有（既没有新键也没有旧键）→ ask
    writeFileSync(
      file,
      JSON.stringify({ theme: 'dark', fontTier: 'large', providers: [], workspaces: [] }),
      'utf8'
    )
    const fresh = readSettings(file)
    expect(fresh.closeToTrayMode).toBe('ask')
    expect(fresh.theme).toBe('dark')

    // 2) 旧键 true（旧行为：提示给过之后点关闭直接收进托盘）→ tray；旧键不留在读出的对象里
    writeFileSync(file, JSON.stringify({ ...legacy(), closeToTrayHintShown: true }), 'utf8')
    const migrated = readSettings(file)
    expect(migrated.closeToTrayMode).toBe('tray')
    expect(migrated.theme).toBe('system')
    expect(Object.keys(migrated)).not.toContain('closeToTrayHintShown')
    expect(JSON.stringify(migrated)).not.toContain('closeToTrayHintShown')

    // 3) 旧键 false / 被手改坏（非布尔）→ ask（不连累其余设置）
    for (const old of [false, 'yes', 1]) {
      writeFileSync(file, JSON.stringify({ ...legacy(), closeToTrayHintShown: old }), 'utf8')
      const recovered = readSettings(file)
      expect(recovered.closeToTrayMode, String(old)).toBe('ask')
      expect(recovered.theme, String(old)).toBe('system')
    }

    // 4) 合法新值优先（哪怕旧键是 true）：'quit' 说了算，旧键照样剥掉（不然 strict 会整份丢）
    writeFileSync(
      file,
      JSON.stringify({ ...DEFAULT_SETTINGS, closeToTrayMode: 'quit', closeToTrayHintShown: true }),
      'utf8'
    )
    expect(readSettings(file).closeToTrayMode).toBe('quit')
    expect(readSettings(file).theme).toBe('system')

    // 5) 非法新值 + 旧键 true → 退到旧行为 tray；非法新值 + 没有旧键 → ask
    writeFileSync(
      file,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        closeToTrayMode: 'always',
        closeToTrayHintShown: true
      }),
      'utf8'
    )
    expect(readSettings(file).closeToTrayMode).toBe('tray')
    writeFileSync(file, JSON.stringify({ ...DEFAULT_SETTINGS, closeToTrayMode: 'always' }), 'utf8')
    expect(readSettings(file).closeToTrayMode).toBe('ask')

    // 6) 两个写口都往返：用户在设置页改（补丁路径）与弹窗勾"记住"（主进程内部写）落盘后读回原样
    updateSettings(file, { closeToTrayMode: 'tray' })
    expect(readSettings(file).closeToTrayMode).toBe('tray')
    updateSettings(file, { closeToTrayMode: 'quit' })
    expect(readSettings(file).closeToTrayMode).toBe('quit')
  })

  it('round 48：带旧 modelCapabilities 键（已删除的手动"支持看图"开关）的文件照样读：迁移时剥掉，其余不丢', () => {
    const file = settingsPath(dir)
    // appSettingsSchema 是 strictObject：不剥掉旧键的话，整份设置会被当成坏文件丢回默认值
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        fontTier: 'large',
        providers: [],
        workspaces: [],
        modelCapabilities: { 'deepseek-flash': { vision: true } }
      }),
      'utf8'
    )

    const settings = readSettings(file)
    expect(settings.theme).toBe('dark')
    expect(settings.fontTier).toBe('large')
    expect(Object.keys(settings)).not.toContain('modelCapabilities')
    // 落盘回写时也不会再带上那个键
    expect(JSON.stringify(settings)).not.toContain('modelCapabilities')
  })

  it('round 66：带旧 pptTemplate 键（已废除的全局模板设置）的文件照样读：迁移时剥掉，且不迁移进任何会话', () => {
    const file = settingsPath(dir)
    // appSettingsSchema 是 strictObject：不剥掉旧键的话，整份设置会被当成坏文件丢回默认值
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        fontTier: 'large',
        providers: [],
        workspaces: [],
        pptTemplate: '学术紫'
      }),
      'utf8'
    )

    const settings = readSettings(file)
    expect(settings.theme).toBe('dark')
    expect(settings.fontTier).toBe('large')
    expect(Object.keys(settings)).not.toContain('pptTemplate')
    // 会话级的那份映射在 libsql 里（session_ppt_templates），settings 这一侧一个残留都不留
    expect(JSON.stringify(settings)).not.toContain('学术紫')
  })

  it('思考翻译（round 32）：老文件没有这个字段时补成缺省（关着 + 预置服务）；落过盘的取值原样保留', () => {
    const file = settingsPath(dir)

    writeFileSync(
      file,
      JSON.stringify({ theme: 'system', fontTier: 'default', providers: [], workspaces: [] }),
      'utf8'
    )
    expect(readSettings(file).reasoningTranslate).toEqual(DEFAULT_REASONING_TRANSLATE)

    writeFileSync(
      file,
      JSON.stringify({
        theme: 'system',
        fontTier: 'default',
        providers: [],
        workspaces: [],
        reasoningTranslate: {
          enabled: true,
          mode: 'button',
          baseUrl: '',
          model: '',
          targetLanguage: 'English'
        }
      }),
      'utf8'
    )
    // 空串与用户改过的目标语言都原样读回：预置只是"没有这个字段时"的缺省，不回头改写
    expect(readSettings(file).reasoningTranslate).toEqual({
      enabled: true,
      mode: 'button',
      baseUrl: '',
      model: '',
      targetLanguage: 'English'
    })
  })

  it('语义召回：v1 形状（本地/远程两路）字段名搬家，取值原样保留（预置只是缺字段时的缺省）', () => {
    const file = settingsPath(dir)

    // v1 形状：source=local + remoteBaseUrl/remoteModel（从未发布，但开发机可能落过盘）
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'system',
        fontTier: 'default',
        providers: [],
        workspaces: [],
        semanticRecall: {
          enabled: true,
          source: 'local',
          remoteBaseUrl: 'https://embed.example.com/v1',
          remoteModel: 'my-embed'
        }
      }),
      'utf8'
    )
    expect(readSettings(file).semanticRecall).toEqual({
      enabled: true,
      source: 'remote',
      baseUrl: 'https://embed.example.com/v1',
      model: 'my-embed',
      idleMinutes: 5
    })

    // 落过盘的取值原样保留（空串也保留：用户清空就是清空，写什么读什么）；
    // 预置只是"没有这个字段时"的缺省，不回头改已经存在的那条
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'system',
        fontTier: 'default',
        providers: [],
        workspaces: [],
        semanticRecall: { enabled: false, source: 'remote', baseUrl: '', model: '' }
      }),
      'utf8'
    )
    expect(readSettings(file).semanticRecall).toEqual({
      enabled: false,
      source: 'remote',
      baseUrl: '',
      model: '',
      idleMinutes: 5
    })
  })

  it('T18 的字段往返：默认工作区与项目清单一起落盘读回', () => {
    const file = settingsPath(dir)
    const project = {
      id: 'p1',
      name: '插件',
      path: join(dir, '插件'),
      createdAt: '2026-10-11T00:00:00.000Z'
    }

    writeSettings(file, {
      ...DEFAULT_SETTINGS,
      workspaces: [
        { path: join(dir, '插件'), mode: 'ask' },
        { path: join(dir, '默认'), mode: 'ask' }
      ],
      defaultWorkspace: join(dir, '默认'),
      projects: [project]
    })

    expect(readSettings(file)).toMatchObject({
      defaultWorkspace: join(dir, '默认'),
      projects: [project]
    })
  })

  it('目录还不存在时写入会自己建目录（userData 首次创建）', () => {
    const file = settingsPath(join(dir, 'nested', 'deeper'))

    writeSettings(file, { ...DEFAULT_SETTINGS, theme: 'light' })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ theme: 'light' })
  })

  it('半截 provider（缺 baseUrl / 空 model）能落盘也能读回：录到一半的状态不该被读盘丢掉', () => {
    const file = settingsPath(dir)
    const halfDone = {
      id: 'custom-1',
      type: 'openai-compatible' as const,
      model: '',
      isDefault: true
    }
    writeSettings(file, { ...DEFAULT_SETTINGS, providers: [halfDone] })

    expect(readSettings(file).providers).toEqual([halfDone])
  })

  it('写不进去就抛（磁盘满/路径被占），不静默吞掉用户的改动', () => {
    // 父路径是个文件 → mkdir 必失败
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x', 'utf8')

    expect(() => writeSettings(settingsPath(blocked), DEFAULT_SETTINGS)).toThrow()
  })
})

describe('首次默认工作区初始化', () => {
  it('没有 settings.json：创建推荐目录，加入 ask 工作区并设为默认', () => {
    const home = join(dir, 'home')

    initializeDefaultWorkspace(join(dir, 'user-data'), home)

    const settings = readSettings(settingsPath(join(dir, 'user-data')))
    const expected = realpathSync.native(join(home, 'kyclaw', '工作区'))
    expect(settings.defaultWorkspace).toBe(expected)
    expect(settings.workspaces).toEqual([{ path: expected, mode: 'ask' }])
    expect(settings.defaultWorkspaceInitialized).toBe(true)
  })

  it('已有默认工作区只补完成标记；已完成初始化的明确 null 不恢复', () => {
    const file = settingsPath(dir)
    const chosen = join(dir, 'chosen')
    writeSettings(file, { ...DEFAULT_SETTINGS, defaultWorkspace: chosen })
    initializeDefaultWorkspace(dir, join(dir, 'home'))
    expect(readSettings(file).defaultWorkspace).toBe(chosen)
    expect(readSettings(file).defaultWorkspaceInitialized).toBe(true)

    updateSettings(file, { workspaces: [], defaultWorkspace: null })
    initializeDefaultWorkspace(dir, join(dir, 'other-home'))
    expect(readSettings(file).defaultWorkspace).toBeNull()
    expect(readSettings(file).workspaces).toEqual([])
    expect(readSettings(file).defaultWorkspaceInitialized).toBe(true)
  })

  it('真实旧空 profile：没有完成标记且 workspaces 为空/defaultWorkspace 为 null 时初始化', () => {
    const file = settingsPath(dir)
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        fontTier: 'large',
        providers: [],
        workspaces: [],
        defaultWorkspace: null
      }),
      'utf8'
    )

    initializeDefaultWorkspace(dir, join(dir, 'home'))
    const settings = readSettings(file)
    expect(settings.defaultWorkspaceInitialized).toBe(true)
    expect(settings.defaultWorkspace).toBe(
      realpathSync.native(join(dir, 'home', 'kyclaw', '工作区'))
    )
    expect(settings.workspaces).toEqual([{ path: settings.defaultWorkspace, mode: 'ask' }])
    expect(settings.theme).toBe('dark')
    expect(settings.fontTier).toBe('large')

    updateSettings(file, { workspaces: [], defaultWorkspace: null })
    initializeDefaultWorkspace(dir, join(dir, 'other-home'))
    expect(readSettings(file).defaultWorkspace).toBeNull()
    expect(readSettings(file).workspaces).toEqual([])
    expect(readSettings(file).defaultWorkspaceInitialized).toBe(true)
  })

  it('旧配置已有 workspace 但 defaultWorkspace 为 null：保留选择，只补完成标记', () => {
    const file = settingsPath(dir)
    const workspace = { path: join(dir, 'chosen'), mode: 'full' as const }
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        fontTier: 'large',
        providers: [],
        workspaces: [workspace],
        defaultWorkspace: null
      }),
      'utf8'
    )

    initializeDefaultWorkspace(dir, join(dir, 'home'))
    expect(readSettings(file).defaultWorkspace).toBeNull()
    expect(readSettings(file).workspaces).toEqual([workspace])
    expect(readSettings(file).defaultWorkspaceInitialized).toBe(true)
  })

  it('旧合法设置缺少 defaultWorkspace 只补一次', () => {
    const file = settingsPath(dir)
    writeFileSync(
      file,
      JSON.stringify({ theme: 'dark', fontTier: 'large', providers: [], workspaces: [] }),
      'utf8'
    )

    initializeDefaultWorkspace(dir, join(dir, 'first-home'))
    const first = readSettings(file)
    initializeDefaultWorkspace(dir, join(dir, 'second-home'))

    expect(readSettings(file).defaultWorkspace).toBe(first.defaultWorkspace)
    expect(first.workspaces[0]?.mode).toBe('ask')
  })

  it('坏 JSON 或非法配置不覆盖原文件', () => {
    const file = settingsPath(dir)
    for (const contents of ['{不是 json', JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'bad' })]) {
      writeFileSync(file, contents, 'utf8')
      initializeDefaultWorkspace(dir, join(dir, 'home'))
      expect(readFileSync(file, 'utf8')).toBe(contents)
    }
  })
})

describe('updateSettings（打补丁 → 合并 → 校验 → 落盘）', () => {
  it('只改补丁里的字段，其余保持原值，并把合并结果落盘', () => {
    const file = settingsPath(dir)
    writeSettings(file, { ...DEFAULT_SETTINGS, fontTier: 'small' })

    const next = updateSettings(file, { theme: 'dark' })

    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'small' })
    expect(readSettings(file)).toEqual(next)
  })

  it('文件还没写过时打补丁：以默认值为底再合并', () => {
    const file = settingsPath(dir)

    expect(updateSettings(file, { fontTier: 'large' })).toEqual({
      ...DEFAULT_SETTINGS,
      fontTier: 'large'
    })
  })

  it('补丁取值不合法就抛，且文件保持原样（拒绝半落盘）', () => {
    const file = settingsPath(dir)
    writeSettings(file, { ...DEFAULT_SETTINGS, theme: 'light' })

    // 直接调函数时（没走 IPC 闸门）也要拦住：schema 是最后一道
    expect(() => updateSettings(file, { theme: 'blue' } as unknown as { theme: 'dark' })).toThrow()
    expect(readSettings(file)).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' })
  })
})
