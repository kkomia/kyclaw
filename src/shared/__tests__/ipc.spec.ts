import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  agentEndpointSchema,
  bundledReleaseNotesSchema,
  CONNECTION_TEST_SCOPE_NOTE,
  connectionTestResultSchema,
  IPC_CHANNELS,
  IpcInputError,
  langfuseKeysArgsSchema,
  langfuseStateSchema,
  localModelIdArgsSchema,
  noArgsSchema,
  parseIpcArgs,
  projectBaseSchema,
  projectCreateArgsSchema,
  projectFolderSchema,
  projectRemoveArgsSchema,
  providerIdArgsSchema,
  providerKeyArgsSchema,
  providerKeyStatesSchema,
  providerModelDiscoveryArgsSchema,
  providerModelDiscoveryResultSchema,
  providerModelListResultSchema,
  setLangfuseKeysResultSchema,
  setProviderKeyResultSchema,
  settingsUpdateArgsSchema,
  updateStateSchema,
  updateStatusSchema,
  windowStateSchema,
  workspaceAddArgsSchema,
  workspaceListFilesArgsSchema,
  workspaceRemoveArgsSchema,
  workspaceSetModeArgsSchema
} from '../ipc'
import { emptyOverview, localModelsOverviewSchema } from '../local-models'
import { DEFAULT_SETTINGS } from '../settings'
import {
  OFFICE_PREVIEW_REQUEST_ID_MAX,
  officePreviewArgsSchema,
  officePreviewCancelArgsSchema,
  officePreviewResultSchema
} from '../office-preview'
import { tableBytesResultSchema } from '../workbench'
import {
  textPageArgsSchema,
  textPageResultSchema,
  textVersionArgsSchema,
  textVersionResultSchema
} from '../workbench-text'

describe('IPC 契约：window 通道', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.window).toEqual({
      minimize: 'window:minimize',
      maximize: 'window:maximize',
      close: 'window:close',
      isMaximized: 'window:is-maximized',
      stateChanged: 'window:state-changed'
    })
  })

  it('无入参通道只收空入参（多给一个参数就是非法调用）', () => {
    expect(noArgsSchema.safeParse([]).success).toBe(true)
    expect(noArgsSchema.safeParse([{ maximized: true }]).success).toBe(false)
    expect(noArgsSchema.safeParse([null]).success).toBe(false)
    expect(noArgsSchema.safeParse([1, 2]).success).toBe(false)
  })

  it('窗口状态 payload 只收 { maximized: boolean }，缺键/错型/多键都不合法', () => {
    expect(windowStateSchema.safeParse({ maximized: true }).success).toBe(true)
    expect(windowStateSchema.safeParse({ maximized: false }).success).toBe(true)
    expect(windowStateSchema.safeParse({ maximized: 'true' }).success).toBe(false)
    expect(windowStateSchema.safeParse({}).success).toBe(false)
    expect(windowStateSchema.safeParse({ maximized: true, extra: 1 }).success).toBe(false)
  })

  it('parseIpcArgs 校验的是整个 args 元组：合法时返回解析结果', () => {
    expect(parseIpcArgs(noArgsSchema, [], 'window:minimize')).toEqual([])
    // 带 payload 的通道把 payload 包成单元素元组（后续任务的新通道照此约定）
    expect(
      parseIpcArgs(z.tuple([windowStateSchema]), [{ maximized: true }], 'window:whatever')
    ).toEqual([{ maximized: true }])
  })

  it('parseIpcArgs 非法时抛 IpcInputError，且消息里带通道名（定位用）', () => {
    expect(() => parseIpcArgs(noArgsSchema, [1], IPC_CHANNELS.window.minimize)).toThrow(
      IpcInputError
    )
    expect(() => parseIpcArgs(noArgsSchema, [1], IPC_CHANNELS.window.minimize)).toThrow(
      /window:minimize/
    )
  })
})

describe('IPC 契约：settings 通道', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.settings).toEqual({
      get: 'settings:get',
      update: 'settings:update',
      setProviderKey: 'settings:set-provider-key',
      providerKeyStates: 'settings:provider-key-states',
      testProvider: 'settings:test-provider',
      removeProvider: 'settings:remove-provider',
      probeModels: 'settings:probe-models',
      listProviderModels: 'settings:list-provider-models',
      discoverProviderModels: 'settings:discover-provider-models'
    })
  })

  it('settings:list-provider-models 的入参与回包（用户反馈 007）：[id] → 可选项数组，缺 contextWindow 也算一条', () => {
    expect(
      parseIpcArgs(providerIdArgsSchema, ['deepseek'], 'settings:list-provider-models')
    ).toEqual(['deepseek'])
    expect(() => parseIpcArgs(providerIdArgsSchema, [], 'settings:list-provider-models')).toThrow(
      /list-provider-models/
    )

    // 回包：有条目 id 就够（端点不回 context_window 的条目照样列得出来）
    expect(
      providerModelListResultSchema.parse([
        { id: 'deepseek-flash', contextWindow: 1_048_576 },
        { id: 'deepseek-v4-pro' }
      ])
    ).toEqual([{ id: 'deepseek-flash', contextWindow: 1_048_576 }, { id: 'deepseek-v4-pro' }])
    expect(providerModelListResultSchema.parse([])).toEqual([])
    // 结构不对（空 id / 非法 contextWindow / 多余字段）→ 拒
    for (const bad of [
      [{ id: '' }],
      [{ id: 'm', contextWindow: 0 }],
      [{ id: 'm', extra: 1 }],
      'nope'
    ]) {
      expect(providerModelListResultSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('settings:update 只收一个补丁对象（形状与取值都过 settings schema）', () => {
    expect(parseIpcArgs(settingsUpdateArgsSchema, [{ theme: 'dark' }], 'settings:update')).toEqual([
      { theme: 'dark' }
    ])
    expect(parseIpcArgs(settingsUpdateArgsSchema, [{}], 'settings:update')).toEqual([{}])
    expect(
      parseIpcArgs(settingsUpdateArgsSchema, [{ theme: 'dark', providers: [] }], 'settings:update')
    ).toEqual([{ theme: 'dark', providers: [] }])
  })

  it('settings:update 拦住非法补丁：错值 / 多键 / 非对象 / 缺参 / 多参 / 夹带 workspaces', () => {
    const reject = (...args: unknown[]): void => {
      expect(() =>
        parseIpcArgs(settingsUpdateArgsSchema, args, IPC_CHANNELS.settings.update)
      ).toThrow(IpcInputError)
    }

    reject({ theme: 'blue' })
    reject({ fontTier: 'huge' })
    reject({ theme: 'dark', evil: 1 })
    reject('dark')
    reject(null)
    reject()
    reject({ theme: 'dark' }, { theme: 'light' })
    // 授权工作区不走设置补丁（路径要在主进程过校验），夹带进来就是非法补丁
    reject({ workspaces: [] })
    reject({ ...DEFAULT_SETTINGS })
  })
})

describe('IPC 契约：settings 密钥/测试连接通道', () => {
  it('set-provider-key 只收 [id, key] 两个非空字符串；回包只能是 {hasKey:true}', () => {
    expect(
      parseIpcArgs(providerKeyArgsSchema, ['deepseek', 'sk-x'], 'settings:set-provider-key')
    ).toEqual(['deepseek', 'sk-x'])

    for (const bad of [
      [],
      ['deepseek'],
      ['', 'sk-x'],
      ['deepseek', ''],
      ['deepseek', 'sk-x', 'extra'],
      [1, 2]
    ]) {
      expect(
        parseIpcArgs.bind(
          null,
          providerKeyArgsSchema,
          bad as unknown[],
          'settings:set-provider-key'
        ),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }

    expect(setProviderKeyResultSchema.safeParse({ hasKey: true }).success).toBe(true)
    // 回包多带任何字段（比如明文）都不合法——preload 会拦下来
    expect(setProviderKeyResultSchema.safeParse({ hasKey: true, key: 'sk-x' }).success).toBe(false)
    expect(setProviderKeyResultSchema.safeParse({ hasKey: false }).success).toBe(false)
  })

  it('test-provider / remove-provider 只收一个非空 id', () => {
    expect(parseIpcArgs(providerIdArgsSchema, ['deepseek'], 'settings:test-provider')).toEqual([
      'deepseek'
    ])
    expect(() => parseIpcArgs(providerIdArgsSchema, [''], 'settings:test-provider')).toThrow(
      IpcInputError
    )
    expect(() => parseIpcArgs(providerIdArgsSchema, [], 'settings:test-provider')).toThrow(
      IpcInputError
    )
  })

  it('密钥状态回包：{ hasKey, needsReentry }，多键/错型都不收', () => {
    expect(
      providerKeyStatesSchema.safeParse({
        deepseek: { hasKey: true, needsReentry: false },
        openai: { hasKey: false, needsReentry: true }
      }).success
    ).toBe(true)
    expect(providerKeyStatesSchema.safeParse({}).success).toBe(true)
    expect(providerKeyStatesSchema.safeParse({ deepseek: { hasKey: true } }).success).toBe(false)
    expect(
      providerKeyStatesSchema.safeParse({
        deepseek: { hasKey: true, needsReentry: false, key: 'x' }
      }).success
    ).toBe(false)
    expect(providerKeyStatesSchema.safeParse({ deepseek: 'configured' }).success).toBe(false)
  })

  it('测试连接回包：三步结论 + 总耗时 + 范围声明；判别与四档状态都要严', () => {
    const passing = {
      ok: true,
      latencyMs: 812,
      steps: [
        { id: 'connectivity', status: 'passed', latencyMs: 100, detail: '通了' },
        { id: 'streaming', status: 'passed', latencyMs: 700, detail: '拿到正文' },
        { id: 'tools', status: 'unverified', detail: '模型没调工具' }
      ],
      scopeNote: CONNECTION_TEST_SCOPE_NOTE
    }
    expect(connectionTestResultSchema.parse(passing)).toEqual(passing)

    // 失败也要带 steps（哪一步没过、哪几步没跑，界面据此说人话）
    const failing = {
      ok: false,
      latencyMs: 40,
      steps: [
        { id: 'connectivity', status: 'failed', detail: '认证失败（401）' },
        { id: 'streaming', status: 'skipped', detail: '上一步没有通过，这一步没有跑' },
        { id: 'tools', status: 'skipped', detail: '上一步没有通过，这一步没有跑' }
      ],
      message: '认证失败（401）',
      scopeNote: CONNECTION_TEST_SCOPE_NOTE
    }
    expect(connectionTestResultSchema.parse(failing)).toEqual(failing)

    // 缺字段 / 非法状态 / 非法步骤 id / 少 scopeNote 一律不合法
    expect(connectionTestResultSchema.safeParse({ ok: true, latencyMs: 1 }).success).toBe(false)
    expect(
      connectionTestResultSchema.safeParse({
        ...passing,
        steps: [{ id: 'nope', status: 'passed', detail: 'x' }]
      }).success
    ).toBe(false)
    expect(
      connectionTestResultSchema.safeParse({
        ...passing,
        steps: [{ id: 'connectivity', status: 'maybe', detail: 'x' }]
      }).success
    ).toBe(false)
    expect(connectionTestResultSchema.safeParse({ ...passing, scopeNote: undefined }).success).toBe(
      false
    )
    expect(connectionTestResultSchema.safeParse({ ...passing, ok: 'yes' }).success).toBe(false)
  })

  it('发现模型的入参/回包：成功带清单（空数组合法）、失败带原因，两者判别要严', () => {
    expect(
      providerModelDiscoveryArgsSchema.parse([
        { type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'sk-a' }
      ])
    ).toEqual([{ type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'sk-a' }])
    // baseUrl 可省（Anthropic 官方域）；apiKey 允许空串（由主进程回一句能照做的人话）
    expect(providerModelDiscoveryArgsSchema.parse([{ type: 'anthropic', apiKey: '' }])).toEqual([
      { type: 'anthropic', apiKey: '' }
    ])
    expect(
      providerModelDiscoveryArgsSchema.safeParse([{ baseUrl: 'https://x', apiKey: 'k' }]).success
    ).toBe(false)
    expect(
      providerModelDiscoveryArgsSchema.safeParse([
        { type: 'openai-compatible', baseUrl: 'https://x', apiKey: 'k', extra: 1 }
      ]).success
    ).toBe(false)

    expect(providerModelDiscoveryResultSchema.parse({ ok: true, models: [] })).toEqual({
      ok: true,
      models: []
    })
    expect(
      providerModelDiscoveryResultSchema.parse({
        ok: false,
        message: '这个端点需要 API Key（401）'
      })
    ).toEqual({ ok: false, message: '这个端点需要 API Key（401）' })
    expect(providerModelDiscoveryResultSchema.safeParse({ ok: true }).success).toBe(false)
    expect(providerModelDiscoveryResultSchema.safeParse({ ok: false }).success).toBe(false)
  })
})

describe('IPC 契约：workspace 通道', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.workspace).toEqual({
      pick: 'workspace:pick',
      add: 'workspace:add',
      setMode: 'workspace:set-mode',
      remove: 'workspace:remove',
      pickDefault: 'workspace:pick-default',
      listFiles: 'workspace:list-files',
      openInExplorer: 'workspace:open-in-explorer'
    })
  })

  it('workspace:list-files 的入参 [threadId]：空串 / 缺参 / 多参都拦下', () => {
    expect(
      parseIpcArgs(workspaceListFilesArgsSchema, ['thread-1'], 'workspace:list-files')
    ).toEqual(['thread-1'])
    for (const bad of [[], [''], [1], ['a', 'b']]) {
      expect(() => parseIpcArgs(workspaceListFilesArgsSchema, bad, 'workspace:list-files')).toThrow(
        IpcInputError
      )
    }
  })

  it('workspace:add 只收 [path]（T13：不收入参 mode，一律 ask 落盘）', () => {
    expect(parseIpcArgs(workspaceAddArgsSchema, ['D:\\ws'], 'workspace:add')).toEqual(['D:\\ws'])

    for (const bad of [
      [],
      [''],
      ['D:\\ws', 'full'],
      ['D:\\ws', 'ask'],
      ['D:\\ws', 'ask', 'extra'],
      [1],
      [null]
    ]) {
      expect(
        parseIpcArgs.bind(null, workspaceAddArgsSchema, bad as unknown[], 'workspace:add'),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }
  })

  it('workspace:set-mode 只收 [path, mode]：path 非空、mode 只收 ask / full', () => {
    expect(
      parseIpcArgs(workspaceSetModeArgsSchema, ['D:\\ws', 'full'], 'workspace:set-mode')
    ).toEqual(['D:\\ws', 'full'])
    expect(
      parseIpcArgs(workspaceSetModeArgsSchema, ['D:\\ws', 'ask'], 'workspace:set-mode')
    ).toEqual(['D:\\ws', 'ask'])

    for (const bad of [
      [],
      ['D:\\ws'],
      ['', 'full'],
      ['D:\\ws', 'always'],
      ['D:\\ws', 'full', 'x']
    ]) {
      expect(
        parseIpcArgs.bind(null, workspaceSetModeArgsSchema, bad as unknown[], 'workspace:set-mode'),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }
  })

  it('workspace:remove 只收一个非空路径；workspace:pick 不收任何入参', () => {
    expect(parseIpcArgs(workspaceRemoveArgsSchema, ['D:\\ws'], 'workspace:remove')).toEqual([
      'D:\\ws'
    ])
    for (const bad of [[], [''], ['D:\\ws', 'x'], [1]]) {
      expect(
        parseIpcArgs.bind(null, workspaceRemoveArgsSchema, bad as unknown[], 'workspace:remove'),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }
    expect(parseIpcArgs(noArgsSchema, [], 'workspace:pick')).toEqual([])
    expect(() => parseIpcArgs(noArgsSchema, ['D:\\ws'], 'workspace:pick')).toThrow(IpcInputError)
  })
})

describe('IPC 契约：projects 通道（T18）', () => {
  it('通道名是固定字面量', () => {
    expect(IPC_CHANNELS.projects).toEqual({
      base: 'projects:base',
      pickFolder: 'projects:pick-folder',
      create: 'projects:create',
      remove: 'projects:remove',
      rename: 'projects:rename',
      openInExplorer: 'projects:open-in-explorer'
    })
  })

  it('projects:create 只收 [{name, path}]（两个都非空，多键/缺键都不合法）', () => {
    expect(
      parseIpcArgs(projectCreateArgsSchema, [{ name: '插件', path: 'D:\\ws' }], 'projects:create')
    ).toEqual([{ name: '插件', path: 'D:\\ws' }])

    for (const bad of [
      [],
      ['插件'],
      [{ name: '插件' }],
      [{ path: 'D:\\ws' }],
      [{ name: '', path: 'D:\\ws' }],
      [{ name: '插件', path: '' }],
      [{ name: '插件', path: 'D:\\ws', mode: 'full' }]
    ]) {
      expect(
        parseIpcArgs.bind(null, projectCreateArgsSchema, bad as unknown[], 'projects:create'),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }
  })

  it('projects:remove 只收 [id]；base / pick-folder 的回包形状锁死', () => {
    expect(parseIpcArgs(projectRemoveArgsSchema, ['p1'], 'projects:remove')).toEqual(['p1'])
    for (const bad of [[], [''], ['p1', 'x']]) {
      expect(
        parseIpcArgs.bind(null, projectRemoveArgsSchema, bad as unknown[], 'projects:remove'),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }

    expect(projectBaseSchema.safeParse({ base: 'D:\\ws' }).success).toBe(true)
    expect(projectBaseSchema.safeParse({ base: '' }).success).toBe(false)
    expect(projectFolderSchema.safeParse({ path: null }).success).toBe(true)
    expect(projectFolderSchema.safeParse({ path: 'D:\\ws' }).success).toBe(true)
    expect(projectFolderSchema.safeParse({}).success).toBe(false)
  })
})

describe('IPC 契约：agent 通道', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.agent).toEqual({ endpoint: 'agent:endpoint' })
  })
  it('端点 payload 只收 { baseUrl, token } 两个字符串，缺键/错型/多键都不合法', () => {
    expect(
      agentEndpointSchema.safeParse({ baseUrl: 'http://127.0.0.1:43210', token: 'abc' }).success
    ).toBe(true)
    expect(agentEndpointSchema.safeParse({ baseUrl: 'http://127.0.0.1:43210' }).success).toBe(false)
    expect(agentEndpointSchema.safeParse({ baseUrl: 1, token: 'abc' }).success).toBe(false)
    expect(agentEndpointSchema.safeParse({ baseUrl: 'x', token: 'y', port: 1 }).success).toBe(false)
  })
})

describe('IPC 契约：updates 通道（T17）', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.updates).toEqual({
      state: 'updates:state',
      check: 'updates:check',
      install: 'updates:install',
      stateChanged: 'updates:state-changed',
      releaseNotes: 'updates:release-notes'
    })
  })

  it('状态：相位是七个固定取值，只带该相位下的字段（缺键/多键/错型都不合法）', () => {
    expect(updateStatusSchema.safeParse({ phase: 'idle' }).success, 'idle').toBe(true)
    expect(updateStatusSchema.safeParse({ phase: 'checking' }).success).toBe(true)
    expect(updateStatusSchema.safeParse({ phase: 'up-to-date' }).success).toBe(true)
    expect(updateStatusSchema.safeParse({ phase: 'available', version: '1.0.1' }).success).toBe(
      true
    )
    expect(
      updateStatusSchema.safeParse({ phase: 'downloading', version: '1.0.1', percent: 42 }).success
    ).toBe(true)
    expect(updateStatusSchema.safeParse({ phase: 'downloaded', version: '1.0.1' }).success).toBe(
      true
    )
    expect(updateStatusSchema.safeParse({ phase: 'error', message: '连不上' }).success).toBe(true)

    for (const bad of [
      {},
      { phase: 'ready' },
      { phase: 'idle', percent: 1 },
      { phase: 'idle', extra: 1 },
      { phase: 'downloading', percent: '42' }
    ]) {
      expect(updateStatusSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('0.1.1：有新版本时带上发行说明（notes / releaseName / releaseDate，三个都可缺）', () => {
    expect(
      updateStatusSchema.safeParse({
        phase: 'available',
        version: '0.1.1',
        notes: '- 一条更新内容',
        releaseName: 'kyclaw 0.1.1',
        releaseDate: '2026-10-15T00:00:00.000Z'
      }).success
    ).toBe(true)

    for (const phase of ['available', 'downloading', 'downloaded'] as const) {
      expect(updateStatusSchema.safeParse({ phase, notes: '只给说明' }).success, phase).toBe(true)
    }

    // 没有"这一版"的那几个相位不收发行说明；说明本身也得是字符串
    expect(updateStatusSchema.safeParse({ phase: 'up-to-date', notes: 'x' }).success).toBe(false)
    expect(updateStatusSchema.safeParse({ phase: 'idle', notes: 'x' }).success).toBe(false)
    expect(updateStatusSchema.safeParse({ phase: 'available', notes: 1 }).success).toBe(false)
  })

  it('本轮：本版本随包发行说明是三态联合（ok / missing / unreadable，缺与读异常分开）', () => {
    expect(
      bundledReleaseNotesSchema.safeParse({
        state: 'ok',
        version: '0.1.1',
        notes: 'kyclaw 0.1.1\n\n本次更新内容：\n- 一条'
      }).success
    ).toBe(true)
    expect(bundledReleaseNotesSchema.safeParse({ state: 'missing' }).success).toBe(true)
    expect(
      bundledReleaseNotesSchema.safeParse({ state: 'unreadable', message: '本版发行说明读取失败' })
        .success
    ).toBe(true)

    for (const bad of [
      {},
      { state: 'ok', notes: '缺版本号' },
      { state: 'ok', version: '0.1.1', notes: 1 },
      { state: 'missing', version: '0.1.1' },
      { state: 'unreadable' },
      { state: 'error', message: 'x' }
    ]) {
      expect(bundledReleaseNotesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('整态：当前版本 + 有没有配源 + 打包内源地址 + 状态（四者齐，别的键不收）', () => {
    const state = {
      currentVersion: '1.0.0',
      configured: true,
      builtinUrl: 'http://192.168.31.18:9000/kyclaw/releases/',
      status: { phase: 'up-to-date' }
    }
    expect(updateStateSchema.safeParse(state).success).toBe(true)
    // 没配打包内源就是 null（不是空串：没配与"配了个空地址"是两件事）
    expect(
      updateStateSchema.safeParse({ ...state, builtinUrl: null }).success,
      'builtinUrl 可以是 null'
    ).toBe(true)

    for (const bad of [
      { currentVersion: '1.0.0', configured: true },
      { currentVersion: 1, configured: true, status: { phase: 'idle' } },
      { currentVersion: '1.0.0', configured: 'yes', status: { phase: 'idle' } },
      { ...state, builtinUrl: undefined },
      { ...state, feedUrl: 'http://x' }
    ]) {
      expect(updateStateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('IPC 契约：telemetry 通道（T17）', () => {
  it('通道名是固定字面量', () => {
    expect(IPC_CHANNELS.telemetry).toEqual({
      langfuseState: 'telemetry:langfuse-state',
      setLangfuseKeys: 'telemetry:set-langfuse-keys',
      clearLangfuseKeys: 'telemetry:clear-langfuse-keys'
    })
  })

  it('Langfuse 状态：地址是原文，两个密钥只有"有没有 / 要不要重录"，active 是布尔', () => {
    const state = {
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: true, needsReentry: false },
      secretKey: { hasKey: false, needsReentry: false },
      active: false
    }
    expect(langfuseStateSchema.safeParse(state).success).toBe(true)

    for (const bad of [
      { ...state, endpoint: 1 },
      { ...state, publicKey: true },
      { ...state, secretKey: { hasKey: true } },
      { ...state, active: 'no' },
      { ...state, extra: 1 },
      { ...state, publicKey: undefined }
    ]) {
      expect(langfuseStateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('写密钥：两段非空字符串；回包只有 {hasKeys:true}（含明文/多字段一律不收）', () => {
    expect(
      parseIpcArgs(langfuseKeysArgsSchema, ['pk', 'sk'], 'telemetry:set-langfuse-keys')
    ).toEqual(['pk', 'sk'])
    for (const bad of [[], ['pk'], ['pk', 'sk', 'x'], ['', 'sk'], [1, 'sk']]) {
      expect(
        parseIpcArgs.bind(
          null,
          langfuseKeysArgsSchema,
          bad as unknown[],
          'telemetry:set-langfuse-keys'
        ),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }

    expect(setLangfuseKeysResultSchema.safeParse({ hasKeys: true }).success).toBe(true)
    expect(setLangfuseKeysResultSchema.safeParse({ hasKeys: true, publicKey: 'pk' }).success).toBe(
      false
    )
    expect(setLangfuseKeysResultSchema.safeParse({ hasKeys: false }).success).toBe(false)
  })
})

describe('IPC 契约：localModels 通道（模块 3B）', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.localModels).toEqual({
      overview: 'localModels:overview',
      download: 'localModels:download',
      cancel: 'localModels:cancel',
      select: 'localModels:select',
      pickCustom: 'localModels:pick-custom',
      remove: 'localModels:remove',
      progressChanged: 'localModels:progress-changed'
    })
  })

  it('下载/生效/删除只收一个非空 id（路径**不进**入参：自定义模型只能从原生选择器来）', () => {
    expect(parseIpcArgs(localModelIdArgsSchema, ['bge-m3-q4-k-m'], 'localModels:download')).toEqual(
      ['bge-m3-q4-k-m']
    )
    for (const bad of [[], [''], ['a', 'b'], [1]]) {
      expect(
        parseIpcArgs.bind(null, localModelIdArgsSchema, bad as unknown[], 'localModels:download'),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }
  })

  it('总览回包：形状严（多一个键、少一个键、相位不认识都不收）', () => {
    const overview = emptyOverview('D:\\\\models')
    expect(localModelsOverviewSchema.safeParse(overview).success).toBe(true)

    const withProgress = {
      ...overview,
      download: { id: 'x', phase: 'downloading', received: 1, total: 2, message: null }
    }
    expect(localModelsOverviewSchema.safeParse(withProgress).success).toBe(true)

    for (const bad of [
      { ...overview, extra: 1 },
      { ...overview, engine: { phase: 'unknown', modelId: null, detail: null } },
      { ...overview, items: [{ id: 'x' }] },
      { ...withProgress, download: { id: 'x', phase: 'downloading', received: 1 } }
    ]) {
      expect(localModelsOverviewSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('IPC 契约：工作台的办公档预览（office-pdf / cancel-office-pdf）', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.workbench.officePdf).toBe('workbench:office-pdf')
    expect(IPC_CHANNELS.workbench.cancelOfficePdf).toBe('workbench:cancel-office-pdf')
  })

  it('office-pdf 的入参是四个位置参数：threadId / 相对路径 / 调度意图 / requestId', () => {
    expect(
      parseIpcArgs(
        officePreviewArgsSchema,
        ['t1', '方案.docx', 'foreground', 'req-1'],
        'workbench:office-pdf'
      )
    ).toEqual(['t1', '方案.docx', 'foreground', 'req-1'])
    expect(
      parseIpcArgs(
        officePreviewArgsSchema,
        ['t1', '旧稿.doc', 'background', 'req-2'],
        'workbench:office-pdf'
      )
    ).toEqual(['t1', '旧稿.doc', 'background', 'req-2'])

    for (const bad of [
      [],
      ['t1'],
      ['t1', '方案.docx'],
      ['t1', '方案.docx', 'foreground'],
      ['', '方案.docx', 'foreground', 'req'],
      ['t1', '', 'foreground', 'req'],
      ['t1', '方案.docx', 'foreground!', 'req'],
      ['t1', '方案.docx', 'foreground', ''],
      ['t1', '方案.docx', 'foreground', 'x'.repeat(OFFICE_PREVIEW_REQUEST_ID_MAX + 1)],
      ['t1', '方案.docx', 'foreground', 'req', '第五个'],
      ['t1', '方案.docx', 'foreground', 42]
    ]) {
      expect(
        () => parseIpcArgs(officePreviewArgsSchema, bad as unknown[], 'workbench:office-pdf'),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }
  })

  it('cancel-office-pdf 的入参只有一个非空 requestId（幂等靠主进程那张表，不靠形状）', () => {
    expect(
      parseIpcArgs(officePreviewCancelArgsSchema, ['req-1'], 'workbench:cancel-office-pdf')
    ).toEqual(['req-1'])
    for (const bad of [
      [],
      [''],
      [1],
      ['a', 'b'],
      ['x'.repeat(OFFICE_PREVIEW_REQUEST_ID_MAX + 1)]
    ]) {
      expect(
        () =>
          parseIpcArgs(
            officePreviewCancelArgsSchema,
            bad as unknown[],
            'workbench:cancel-office-pdf'
          ),
        JSON.stringify(bad)
      ).toThrow(IpcInputError)
    }
  })

  it('office-pdf 的回包：pdf 支要真字节与缺字体；failed 支带分类，cancelled 是其中一种', () => {
    const pdf = {
      kind: 'pdf',
      path: '方案.docx',
      version: '1024:1712345',
      pdf: new Uint8Array([37, 80, 68, 70]),
      size: 4,
      missingFonts: ['思源黑体'],
      generation: 'gen-1'
    }
    expect(officePreviewResultSchema.safeParse(pdf).success).toBe(true)
    // 缺字体可以为空（二进制格式查不了 —— 空数组是"引擎没声明"，不是"不缺字"）
    expect(officePreviewResultSchema.safeParse({ ...pdf, missingFonts: [] }).success).toBe(true)

    for (const bad of [
      // 字节必须真是 Uint8Array（普通数组过结构化克隆会变成数组，这里就要拦住）
      { ...pdf, pdf: [37, 80, 68, 70] },
      { ...pdf, path: '' },
      { ...pdf, version: '' },
      { ...pdf, generation: '' },
      { ...pdf, extra: 1 }
    ]) {
      expect(officePreviewResultSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }

    expect(
      officePreviewResultSchema.safeParse({
        kind: 'failed',
        path: '方案.docx',
        code: 'cancelled',
        message: '这次预览转换已取消'
      }).success
    ).toBe(true)
    expect(
      officePreviewResultSchema.safeParse({
        kind: 'failed',
        path: '方案.docx',
        code: '没这个分类',
        message: 'x'
      }).success
    ).toBe(false)
  })
})

describe('IPC 契约：工作台的表格原始字节通道（table-bytes）', () => {
  it('通道名是固定字面量', () => {
    expect(IPC_CHANNELS.workbench.tableBytes).toBe('workbench:table-bytes')
  })

  it('回包是五支判别联合：bytes / too-large / unsupported / missing / changed', () => {
    expect(
      tableBytesResultSchema.safeParse({
        kind: 'bytes',
        format: 'xls',
        bytes: new Uint8Array([0xd0, 0xcf]),
        size: 2
      }).success
    ).toBe(true)
    expect(tableBytesResultSchema.safeParse({ kind: 'too-large', size: 9, limit: 8 }).success).toBe(
      true
    )
    expect(tableBytesResultSchema.safeParse({ kind: 'unsupported', size: 9 }).success).toBe(true)
    expect(tableBytesResultSchema.safeParse({ kind: 'missing' }).success).toBe(true)
    expect(tableBytesResultSchema.safeParse({ kind: 'changed' }).success).toBe(true)

    for (const bad of [
      { kind: 'bytes', format: 'ods', bytes: new Uint8Array(), size: 0 },
      { kind: 'bytes', format: 'csv', bytes: [1], size: 1 },
      { kind: 'bytes', format: 'csv', bytes: new Uint8Array(), size: 0, extra: 1 },
      { kind: 'changed', size: 1 },
      { kind: 'nope' }
    ]) {
      expect(tableBytesResultSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('IPC 契约：工作台的文本分页通道（read-text-page / text-version）', () => {
  it('通道名是固定字面量', () => {
    expect(IPC_CHANNELS.workbench.readTextPage).toBe('workbench:read-text-page')
    expect(IPC_CHANNELS.workbench.textVersion).toBe('workbench:text-version')
  })

  it('入参：[threadId, relative, cursor|null]；cursor 必须带 offset 与 version', () => {
    expect(textPageArgsSchema.safeParse(['t1', 'a.txt', null]).success).toBe(true)
    expect(
      textPageArgsSchema.safeParse(['t1', 'a.txt', { offset: 256, version: '2:1' }]).success
    ).toBe(true)

    for (const bad of [
      ['t1', 'a.txt'],
      ['t1', 'a.txt', { offset: -1, version: '2:1' }],
      ['t1', 'a.txt', { offset: 0 }],
      ['t1', 'a.txt', { cursor: 0 }],
      ['', 'a.txt', null]
    ]) {
      expect(textPageArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(textVersionArgsSchema.safeParse(['t1', 'a.txt']).success).toBe(true)
    expect(textVersionArgsSchema.safeParse(['t1']).success).toBe(false)
  })

  it('回包是五支判别联合：page / binary / missing / too-large / changed', () => {
    expect(
      textPageResultSchema.safeParse({
        kind: 'page',
        text: 'a\n',
        offset: 0,
        nextOffset: 2,
        size: 2,
        version: '2:1',
        eof: true,
        overlongLine: false
      }).success
    ).toBe(true)
    expect(textPageResultSchema.safeParse({ kind: 'binary', size: 2 }).success).toBe(true)
    expect(textPageResultSchema.safeParse({ kind: 'missing' }).success).toBe(true)
    expect(textPageResultSchema.safeParse({ kind: 'too-large', size: 9, limit: 8 }).success).toBe(
      true
    )
    expect(textPageResultSchema.safeParse({ kind: 'changed' }).success).toBe(true)

    for (const bad of [
      { kind: 'page', text: 'a' },
      {
        kind: 'page',
        text: 'a',
        offset: 0,
        nextOffset: 1,
        size: 1,
        version: '',
        eof: true,
        overlongLine: false
      },
      {
        kind: 'page',
        text: 'a',
        offset: 0,
        nextOffset: 1,
        size: 1,
        version: '1:1',
        eof: true,
        overlongLine: false,
        extra: 1
      },
      { kind: 'nope' }
    ]) {
      expect(textPageResultSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('版本探询回包：两支判别联合（还是 uuid 那种自由串都收，只要求非空）', () => {
    expect(
      textVersionResultSchema.safeParse({ kind: 'version', version: '2:1', size: 2 }).success
    ).toBe(true)
    expect(textVersionResultSchema.safeParse({ kind: 'missing' }).success).toBe(true)
    expect(
      textVersionResultSchema.safeParse({ kind: 'version', version: '', size: 0 }).success
    ).toBe(false)
    expect(textVersionResultSchema.safeParse({ kind: 'version', version: '2:1' }).success).toBe(
      false
    )
  })
})
