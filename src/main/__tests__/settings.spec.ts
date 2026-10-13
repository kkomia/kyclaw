import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_REASONING_TRANSLATE,
  DEFAULT_SETTINGS,
  LANGFUSE_PRESET
} from '../../shared/settings'
import { readSettings, settingsPath, updateSettings, writeSettings } from '../settings'

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
      providers: [],
      workspaces: [],
      outsideWorkspaceMode: 'full' as const,
      defaultWorkspace: null,
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
      langfuse: { endpoint: 'https://cloud.langfuse.com', proxyUrl: 'http://127.0.0.1:7890' },
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
    expect(DEFAULT_SETTINGS.langfuse).toEqual({ endpoint: LANGFUSE_PRESET.endpoint, proxyUrl: '' })
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
      providers: [],
      workspaces: [],
      // round 75：旧文件没有「工作区之外」那一档 → 补保守档 ask（缺了会整份设置当坏文件）
      outsideWorkspaceMode: 'ask',
      defaultWorkspace: null,
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
      // round 67：T17 之前根本没有 langfuse 这一节（整节缺失）→ 补预置地址 + 空代理
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
      updateUrl: ''
    })
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
    // 老地址一个字符不改（用户想换新地址在设置页里改，迁移不替用户做决定）
    expect(settings.langfuse).toEqual({ endpoint: 'http://192.168.31.18:3000', proxyUrl: '' })
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
