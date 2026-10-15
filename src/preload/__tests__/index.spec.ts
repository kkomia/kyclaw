import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings'

/**
 * preload 桥：白名单方法 + 与主进程共用的通道名 / schema。
 * mock 掉 electron 的 contextBridge / ipcRenderer，看到的就是"渲染端真正会拿到的那张面"。
 *
 * 注意：模块导入期的副作用（exposeInMainWorld 调用）发生在 vitest 的收集阶段，
 * mock 的调用记录那时会被清掉——所以每个用例都用 vi.resetModules() 重新导入一遍，
 * 顺带把"两种 contextIsolation 分支"都真跑过。
 */
const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn<(file: File) => string>(() => '')
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: { getPathForFile: mocks.getPathForFile }
}))

type PreloadModule = typeof import('../index')

async function loadPreload(contextIsolated = true): Promise<PreloadModule> {
  vi.resetModules()
  Object.defineProperty(process, 'contextIsolated', { value: contextIsolated, configurable: true })
  return import('../index')
}

beforeEach(() => {
  mocks.exposeInMainWorld.mockReset()
  mocks.invoke.mockReset()
  mocks.on.mockReset()
  mocks.removeListener.mockReset()
  mocks.getPathForFile.mockReset()
  mocks.getPathForFile.mockReturnValue('')
})

/** 取 ipcRenderer.on 注册进去的监听器 */
function pushedListener(): (event: unknown, payload: unknown) => void {
  const call = mocks.on.mock.calls[0]
  if (!call) throw new Error('没有订阅任何通道')
  return call[1] as (event: unknown, payload: unknown) => void
}

describe('preload：window.kyclaw 白名单', () => {
  it('contextIsolation 开着时，只经 contextBridge 暴露 kyclaw，且 window 面就是那五个方法', async () => {
    const { kyclawApi } = await loadPreload(true)

    expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(mocks.exposeInMainWorld).toHaveBeenCalledWith('kyclaw', kyclawApi)
    expect(Object.keys(kyclawApi.window).sort()).toEqual([
      'close',
      'isMaximized',
      'maximize',
      'minimize',
      'onStateChanged'
    ])
  })

  it('contextIsolation 关着时退回直接挂 window（兜底分支也真跑）', async () => {
    const { kyclawApi } = await loadPreload(false)

    expect(mocks.exposeInMainWorld).not.toHaveBeenCalled()
    expect((window as unknown as Record<string, unknown>).kyclaw).toBe(kyclawApi)
  })

  it('三个动作方法打到约定通道、不带多余入参', async () => {
    const { kyclawApi } = await loadPreload()

    kyclawApi.window.minimize()
    kyclawApi.window.maximize()
    kyclawApi.window.close()

    expect(mocks.invoke.mock.calls).toEqual([
      ['window:minimize'],
      ['window:maximize'],
      ['window:close']
    ])
  })

  it('isMaximized 取主进程的布尔结果；返回值不合法（跨边界脏数据）当 false', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce(true)
    await expect(kyclawApi.window.isMaximized()).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenLastCalledWith('window:is-maximized')

    mocks.invoke.mockResolvedValueOnce('yes')
    await expect(kyclawApi.window.isMaximized()).resolves.toBe(false)
  })

  it('onStateChanged 订阅状态推送：合法 payload 转给监听方', async () => {
    const { kyclawApi } = await loadPreload()
    const listener = vi.fn()

    kyclawApi.window.onStateChanged(listener)

    expect(mocks.on).toHaveBeenCalledWith('window:state-changed', expect.any(Function))
    pushedListener()({}, { maximized: true })
    expect(listener).toHaveBeenCalledWith({ maximized: true })
  })

  it('onStateChanged 丢掉结构不对的 payload（不把脏数据交给上层）', async () => {
    const { kyclawApi } = await loadPreload()
    const listener = vi.fn()

    kyclawApi.window.onStateChanged(listener)

    const push = pushedListener()
    push({}, 'true')
    push({}, { maximized: 'yes' })
    push({}, null)

    expect(listener).not.toHaveBeenCalled()
  })

  it('onStateChanged 返回退订函数：摘掉的是同一个监听器', async () => {
    const { kyclawApi } = await loadPreload()

    const unsubscribe = kyclawApi.window.onStateChanged(vi.fn())
    unsubscribe()

    expect(mocks.removeListener).toHaveBeenCalledWith('window:state-changed', pushedListener())
  })
})

describe('preload：window.kyclaw.settings', () => {
  it('暴露 settings 一族（读 / 改 / 密钥 / 密钥状态 / 测试连接 / 删除 / 元数据探测 / 列端点模型 / 发现模型）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.settings).sort()).toEqual([
      'discoverProviderModels',
      'get',
      'listProviderModels',
      'probeModels',
      'providerKeyStates',
      'removeProvider',
      'setProviderKey',
      'testProvider',
      'update'
    ])
  })

  it('discoverProviderModels 把刚填的入参原样发出去（含密钥），回包过 schema 才交给上层', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({ ok: true, models: [{ id: 'm' }] })
    await expect(
      kyclawApi.settings.discoverProviderModels({
        type: 'openai-compatible',
        baseUrl: 'https://x/v1',
        apiKey: 'sk-just-typed'
      })
    ).resolves.toEqual({ ok: true, models: [{ id: 'm' }] })
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:discover-provider-models', {
      type: 'openai-compatible',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-just-typed'
    })

    // 失败带原因也是一等结果，照原样交给上层（弹窗要把"读不到"和"空清单"分开说）
    mocks.invoke.mockResolvedValueOnce({ ok: false, message: '认证失败（401）' })
    await expect(
      kyclawApi.settings.discoverProviderModels({ type: 'anthropic', apiKey: 'k' })
    ).resolves.toEqual({ ok: false, message: '认证失败（401）' })

    // 结构不对（两个分支混在一起 / 缺 scopeNote 那一类脏数据）→ 抛，不交给上层
    mocks.invoke.mockResolvedValueOnce({ ok: true, models: [], message: 'x' })
    await expect(
      kyclawApi.settings.discoverProviderModels({ type: 'anthropic', apiKey: 'k' })
    ).rejects.toThrow(/模型发现响应结构不合法/)
  })

  it('listProviderModels 打 settings:list-provider-models：回包过 schema 才交给上层（007）', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce([{ id: 'm', contextWindow: 1000 }, { id: 'n' }])
    await expect(kyclawApi.settings.listProviderModels('deepseek')).resolves.toEqual([
      { id: 'm', contextWindow: 1000 },
      { id: 'n' }
    ])
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:list-provider-models', 'deepseek')

    // 结构不对（脏数据）→ 抛，不把半截清单交给上层
    mocks.invoke.mockResolvedValueOnce([{ id: '' }])
    await expect(kyclawApi.settings.listProviderModels('deepseek')).rejects.toThrow(
      /模型清单响应结构不合法/
    )
  })

  it('get 打 settings:get，返回值按同一份 schema 解析后交给上层', async () => {
    const { kyclawApi } = await loadPreload()
    const persisted = { ...defaultSettings(), theme: 'dark' as const, fontTier: 'large' as const }
    mocks.invoke.mockResolvedValueOnce(persisted)

    await expect(kyclawApi.settings.get()).resolves.toEqual(persisted)
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:get')
  })

  it('get 的返回值结构不对（跨边界脏数据）→ 默认值，不把脏数据交给上层', async () => {
    const { kyclawApi } = await loadPreload()

    for (const bad of [{ theme: 'blue' }, { theme: 'dark' }, 'dark', null]) {
      mocks.invoke.mockResolvedValueOnce(bad)
      await expect(kyclawApi.settings.get()).resolves.toEqual(defaultSettings())
    }
  })

  it('update 把补丁原样发给 settings:update，回吐落盘后的完整设置', async () => {
    const { kyclawApi } = await loadPreload()
    const updated = { ...defaultSettings(), theme: 'light' as const }
    mocks.invoke.mockResolvedValueOnce(updated)

    await expect(kyclawApi.settings.update({ theme: 'light' })).resolves.toEqual(updated)
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:update', { theme: 'light' })
  })

  it('update 的返回值结构不对 → 默认值（渲染端不拿到半截对象）', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ theme: 'light' })

    await expect(kyclawApi.settings.update({ theme: 'light' })).resolves.toEqual(defaultSettings())
  })

  it('setProviderKey 原样发给 settings:set-provider-key，只把 {hasKey:true} 交给上层', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ hasKey: true })

    await expect(kyclawApi.settings.setProviderKey('deepseek', 'sk-test-key')).resolves.toEqual({
      hasKey: true
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      'settings:set-provider-key',
      'deepseek',
      'sk-test-key'
    )
  })

  it('setProviderKey 回包多带任何字段（比如顺手回显明文）→ 整个响应不合法，抛错不交给上层', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ hasKey: true, key: 'sk-test-key' })

    await expect(kyclawApi.settings.setProviderKey('deepseek', 'sk-test-key')).rejects.toThrow()
  })

  it('providerKeyStates 按 schema 解析出 { hasKey, needsReentry }；结构不对就抛', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({
      deepseek: { hasKey: true, needsReentry: false },
      openai: { hasKey: false, needsReentry: true }
    })

    await expect(kyclawApi.settings.providerKeyStates()).resolves.toEqual({
      deepseek: { hasKey: true, needsReentry: false },
      openai: { hasKey: false, needsReentry: true }
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:provider-key-states')

    mocks.invoke.mockResolvedValueOnce({ deepseek: 'configured' })
    await expect(kyclawApi.settings.providerKeyStates()).rejects.toThrow()
  })

  it('testProvider 带上 id，结果按 schema 解析；脏数据（缺 steps / 两个分支混在一起）抛错', async () => {
    const { kyclawApi } = await loadPreload()
    const result = {
      ok: true,
      latencyMs: 812,
      steps: [
        { id: 'connectivity', status: 'passed', latencyMs: 400, detail: '通了' },
        { id: 'streaming', status: 'passed', latencyMs: 380, detail: '拿到正文' },
        { id: 'tools', status: 'passed', latencyMs: 32, detail: '调了探针工具' }
      ],
      scopeNote: '验证范围：……'
    }
    mocks.invoke.mockResolvedValueOnce(result)

    await expect(kyclawApi.settings.testProvider('deepseek')).resolves.toEqual(result)
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:test-provider', 'deepseek')

    // 旧形状（只有 ok/latencyMs）不再是合法回包：半截结果没法分项显示
    mocks.invoke.mockResolvedValueOnce({ ok: true, latencyMs: 812 })
    await expect(kyclawApi.settings.testProvider('deepseek')).rejects.toThrow()
    mocks.invoke.mockResolvedValueOnce({ ok: false, message: '认证失败', latencyMs: 1 })
    await expect(kyclawApi.settings.testProvider('deepseek')).rejects.toThrow()
  })

  it('removeProvider 走 settings:remove-provider，回吐合并后的设置（脏数据回默认值）', async () => {
    const { kyclawApi } = await loadPreload()
    const persisted = { ...defaultSettings(), theme: 'dark' as const }
    mocks.invoke.mockResolvedValueOnce(persisted)

    await expect(kyclawApi.settings.removeProvider('deepseek')).resolves.toEqual(persisted)
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:remove-provider', 'deepseek')
  })
})

describe('preload：window.kyclaw.workspace', () => {
  /** 落盘后的设置（含一条工作区），用作 workspace 面回包的样本 */
  const persisted = {
    ...defaultSettings(),
    workspaces: [{ path: 'D:\\项目', mode: 'ask' as const }]
  }

  it('暴露 workspace 一族（pick / pickDefault / add / setMode / remove / listFiles / openInExplorer）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.workspace).sort()).toEqual([
      'add',
      'listFiles',
      'openInExplorer',
      'pick',
      'pickDefault',
      'remove',
      'setMode'
    ])
  })

  it('openInExplorer 把 threadId 发给 workspace:open-in-explorer，回包过 { path } schema', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ path: 'D:\\项目' })

    await expect(kyclawApi.workspace.openInExplorer('t1')).resolves.toEqual({ path: 'D:\\项目' })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workspace:open-in-explorer', 't1')

    // 结构不对就抛（路径是打开动作的凭据，不交半截对象）
    mocks.invoke.mockResolvedValueOnce({ nope: true })
    await expect(kyclawApi.workspace.openInExplorer('t1')).rejects.toThrow(/结构不合法/)
  })

  it('pick 打 workspace:pick（不带入参），回包按同一份 settings schema 解析', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce(persisted)

    await expect(kyclawApi.workspace.pick()).resolves.toEqual(persisted)
    expect(mocks.invoke).toHaveBeenLastCalledWith('workspace:pick')
  })

  it('add 把 path 发给 workspace:add（T13：不再带 mode）', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce(persisted)

    await expect(kyclawApi.workspace.add('D:\\项目')).resolves.toEqual(persisted)
    expect(mocks.invoke).toHaveBeenLastCalledWith('workspace:add', 'D:\\项目')
  })

  it('setMode 把 [path, mode] 发给 workspace:set-mode', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce(persisted)

    await expect(kyclawApi.workspace.setMode('D:\\项目', 'full')).resolves.toEqual(persisted)
    expect(mocks.invoke).toHaveBeenLastCalledWith('workspace:set-mode', 'D:\\项目', 'full')
  })

  it('remove 把 path 发给 workspace:remove', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ ...persisted, workspaces: [] })

    await expect(kyclawApi.workspace.remove('D:\\项目')).resolves.toMatchObject({ workspaces: [] })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workspace:remove', 'D:\\项目')
  })

  it('pickDefault 打 workspace:pick-default（不带入参），回包按同一份 settings schema 解析', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ ...persisted, defaultWorkspace: 'D:\\项目' })

    await expect(kyclawApi.workspace.pickDefault()).resolves.toMatchObject({
      defaultWorkspace: 'D:\\项目'
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workspace:pick-default')
  })

  it('回包结构不对（跨边界脏数据）→ 默认值：多一个字段的工作区也不许进渲染端', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({
      ...persisted,
      workspaces: [{ path: 'D:\\项目', mode: 'ask', extra: 1 }]
    })

    await expect(kyclawApi.workspace.pick()).resolves.toEqual(defaultSettings())
  })
})

describe('preload：window.kyclaw.projects', () => {
  const persisted = {
    ...defaultSettings(),
    defaultWorkspace: 'D:\\ws',
    projects: [
      { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: '2026-10-11T00:00:00.000Z' }
    ]
  }

  it('暴露 projects 一族（base / pickFolder / create / remove / rename / openInExplorer）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.projects).sort()).toEqual([
      'base',
      'create',
      'openInExplorer',
      'pickFolder',
      'readRules',
      'remove',
      'rename',
      'rulesStatus',
      'saveRules'
    ])
  })

  it('规则 status/read/save 参数精确且响应严格校验', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ processorRegistered: true })
    await expect(kyclawApi.projects.rulesStatus()).resolves.toEqual({ processorRegistered: true })
    expect(mocks.invoke).toHaveBeenLastCalledWith('rules:status')
    mocks.invoke.mockResolvedValueOnce({ processorRegistered: 'true' })
    await expect(kyclawApi.projects.rulesStatus()).rejects.toThrow()
    const view = {
      projectId: 'p1',
      source: '.kyclaw/rules.md',
      text: '偏好',
      diagnostics: [],
      processorRegistered: true,
      projectIncluded: true
    }
    mocks.invoke.mockResolvedValueOnce(view)
    await expect(kyclawApi.projects.readRules('p1')).resolves.toEqual(view)
    expect(mocks.invoke).toHaveBeenLastCalledWith('rules:read-project', 'p1')
    mocks.invoke.mockResolvedValueOnce({ ok: true, view })
    await expect(kyclawApi.projects.saveRules('p1', '偏好')).resolves.toEqual({ ok: true, view })
    expect(mocks.invoke).toHaveBeenLastCalledWith('rules:save-project', {
      projectId: 'p1',
      text: '偏好'
    })
    mocks.invoke.mockResolvedValueOnce({ ...view, arbitraryPath: 'outside' })
    await expect(kyclawApi.projects.readRules('p1')).rejects.toThrow()
    mocks.invoke.mockResolvedValueOnce({
      ok: false,
      diagnostics: [{ scope: 'project', code: 'save-failed', message: '无法保存' }]
    })
    await expect(kyclawApi.projects.saveRules('p1', '')).resolves.toMatchObject({ ok: false })
  })

  it('base / pickFolder 的两块料按各自 schema 解析；结构不对就抛', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({ base: 'D:\\ws' })
    await expect(kyclawApi.projects.base()).resolves.toEqual({ base: 'D:\\ws' })
    expect(mocks.invoke).toHaveBeenLastCalledWith('projects:base')

    mocks.invoke.mockResolvedValueOnce({ path: null })
    await expect(kyclawApi.projects.pickFolder()).resolves.toEqual({ path: null })
    expect(mocks.invoke).toHaveBeenLastCalledWith('projects:pick-folder')

    mocks.invoke.mockResolvedValueOnce({ base: '' })
    await expect(kyclawApi.projects.base()).rejects.toThrow()
  })

  it('create 把 name/path 装成对象发出去，回吐落盘后的完整设置', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce(persisted)

    await expect(kyclawApi.projects.create('插件', 'D:\\ws\\插件')).resolves.toEqual(persisted)
    expect(mocks.invoke).toHaveBeenLastCalledWith('projects:create', {
      name: '插件',
      path: 'D:\\ws\\插件'
    })
  })

  it('remove 走 projects:remove；回包结构不对 → 默认值', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ ...persisted, projects: [] })

    await expect(kyclawApi.projects.remove('p1')).resolves.toMatchObject({ projects: [] })
    expect(mocks.invoke).toHaveBeenLastCalledWith('projects:remove', 'p1')

    mocks.invoke.mockResolvedValueOnce({ projects: [{ id: 'p1' }] })
    await expect(kyclawApi.projects.remove('p1')).resolves.toEqual(defaultSettings())
  })
})

describe('preload：window.kyclaw.updates（T17）', () => {
  const STATE = {
    currentVersion: '1.0.0',
    configured: true,
    builtinUrl: null,
    status: { phase: 'idle' }
  }

  it('暴露 updates 一族（读 / 检查 / 安装 / 订阅）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.updates).sort()).toEqual([
      'check',
      'install',
      'onStateChanged',
      'state'
    ])
  })

  it('state / check 打约定通道，返回值按 schema 解析后交给上层', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce(STATE)
    await expect(kyclawApi.updates.state()).resolves.toEqual(STATE)
    expect(mocks.invoke).toHaveBeenLastCalledWith('updates:state')

    mocks.invoke.mockResolvedValueOnce({ ...STATE, status: { phase: 'up-to-date' } })
    await expect(kyclawApi.updates.check()).resolves.toMatchObject({
      status: { phase: 'up-to-date' }
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('updates:check')
  })

  it('state / check 的返回值结构不对（跨边界脏数据）→ 抛，不编造"未配置"糊弄上层', async () => {
    const { kyclawApi } = await loadPreload()

    for (const bad of [
      { currentVersion: '1.0.0' },
      { ...STATE, status: { phase: 'ready' } },
      null
    ]) {
      mocks.invoke.mockResolvedValueOnce(bad)
      await expect(kyclawApi.updates.state()).rejects.toThrow()
    }
  })

  it('install 打 updates:install（无入参）', async () => {
    const { kyclawApi } = await loadPreload()

    await kyclawApi.updates.install()

    expect(mocks.invoke).toHaveBeenLastCalledWith('updates:install')
  })

  it('onStateChanged：合法推送转给监听方，脏 payload 丢掉，退订摘同一个监听器', async () => {
    const { kyclawApi } = await loadPreload()
    const listener = vi.fn()

    const unsubscribe = kyclawApi.updates.onStateChanged(listener)
    expect(mocks.on).toHaveBeenCalledWith('updates:state-changed', expect.any(Function))

    const push = pushedListener()
    push({}, { ...STATE, status: { phase: 'downloading', percent: 40 } })
    push({}, { currentVersion: '1.0.0' })
    push({}, null)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      currentVersion: '1.0.0',
      configured: true,
      builtinUrl: null,
      status: { phase: 'downloading', percent: 40 }
    })

    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith('updates:state-changed', push)
  })
})

describe('preload：window.kyclaw.telemetry（T17）', () => {
  const STATE = {
    endpoint: 'https://cloud.langfuse.com',
    publicKey: { hasKey: true, needsReentry: false },
    secretKey: { hasKey: true, needsReentry: false },
    active: false
  }

  it('暴露 telemetry 一族（状态 / 写密钥 / 清密钥）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.telemetry).sort()).toEqual([
      'clearLangfuseKeys',
      'langfuseState',
      'setLangfuseKeys'
    ])
  })

  it('setLangfuseKeys 原样发给通道，只把 {hasKeys:true} 交给上层', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ hasKeys: true })

    await expect(kyclawApi.telemetry.setLangfuseKeys('pk-test', 'sk-test')).resolves.toEqual({
      hasKeys: true
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      'telemetry:set-langfuse-keys',
      'pk-test',
      'sk-test'
    )
  })

  it('setLangfuseKeys 回包多带任何字段（比如顺手回显明文）→ 整个响应不合法，抛错不交给上层', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ hasKeys: true, publicKey: 'pk-test' })

    await expect(kyclawApi.telemetry.setLangfuseKeys('pk-test', 'sk-test')).rejects.toThrow()
  })

  it('langfuseState / clearLangfuseKeys 按 schema 解析；结构不对就抛', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce(STATE)
    await expect(kyclawApi.telemetry.langfuseState()).resolves.toEqual(STATE)
    expect(mocks.invoke).toHaveBeenLastCalledWith('telemetry:langfuse-state')

    mocks.invoke.mockResolvedValueOnce({ ...STATE, publicKey: { hasKey: false } })
    await expect(kyclawApi.telemetry.clearLangfuseKeys()).rejects.toThrow()
    expect(mocks.invoke).toHaveBeenLastCalledWith('telemetry:clear-langfuse-keys')
  })
})

describe('preload：window.kyclaw.translate（思考翻译，round 32）', () => {
  it('暴露 translate 一族（run / keyState / setKey / clearKey）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.translate).sort()).toEqual([
      'clearKey',
      'keyState',
      'run',
      'setKey'
    ])
  })

  it('run 把 { text, targetLanguage } 原样发给 translate:run，结果按同一份 schema 解析', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ ok: true, text: '译文' })

    await expect(
      kyclawApi.translate.run({ text: 'Hello', targetLanguage: '简体中文' })
    ).resolves.toEqual({ ok: true, text: '译文' })
    expect(mocks.invoke).toHaveBeenLastCalledWith('translate:run', {
      text: 'Hello',
      targetLanguage: '简体中文'
    })

    // 失败是产品语言的一等结果（原样交给上层，不抛）
    mocks.invoke.mockResolvedValueOnce({ ok: false, message: '翻译服务没有返回内容' })
    await expect(kyclawApi.translate.run({ text: 'Hello' })).resolves.toEqual({
      ok: false,
      message: '翻译服务没有返回内容'
    })

    // 结构不对（两个分支混在一起 / 缺 text）→ 抛，不编一个译文本给上层
    for (const bad of [{ ok: true, text: '译文', message: '多余' }, { ok: false }, null]) {
      mocks.invoke.mockResolvedValueOnce(bad)
      await expect(kyclawApi.translate.run({ text: 'Hello' })).rejects.toThrow(/结构不合法/)
    }
  })

  it('setKey 只把 {hasKey:true} 交给上层；回包多带明文 = 整个响应不合法', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ hasKey: true })

    await expect(kyclawApi.translate.setKey('sk-translate')).resolves.toEqual({ hasKey: true })
    expect(mocks.invoke).toHaveBeenLastCalledWith('translate:set-key', 'sk-translate')

    mocks.invoke.mockResolvedValueOnce({ hasKey: true, key: 'sk-translate' })
    await expect(kyclawApi.translate.setKey('sk-translate')).rejects.toThrow()
  })

  it('keyState / clearKey 按 schema 解析；结构不对就抛', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ hasKey: false, needsReentry: false })

    await expect(kyclawApi.translate.keyState()).resolves.toEqual({
      hasKey: false,
      needsReentry: false
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('translate:key-state')

    mocks.invoke.mockResolvedValueOnce({ hasKey: true, needsReentry: false })
    await expect(kyclawApi.translate.clearKey()).resolves.toEqual({
      hasKey: true,
      needsReentry: false
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('translate:clear-key')

    mocks.invoke.mockResolvedValueOnce({ hasKey: 'yes' })
    await expect(kyclawApi.translate.keyState()).rejects.toThrow()
  })
})

describe('preload：window.kyclaw.workbench / terminal（工作台四工具）', () => {
  it('暴露 workbench 一族（listDir / readFile / readBytes / search / reveal / gitOverview / gitLog / gitShow）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.workbench).sort()).toEqual([
      'gitLog',
      'gitOverview',
      'gitShow',
      'listDir',
      'open',
      'readBytes',
      'readFile',
      'reveal',
      'search'
    ])
    expect(Object.keys(kyclawApi.terminal).sort()).toEqual([
      'dispose',
      'onData',
      'onExit',
      'resize',
      'start',
      'write'
    ])
  })

  it('listDir / readFile / reveal 都把 [threadId, 相对路径] 发出去', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({
      entries: [{ name: 'src', kind: 'dir', size: 0 }],
      truncated: false
    })
    await expect(kyclawApi.workbench.listDir('t1', 'src')).resolves.toEqual({
      entries: [{ name: 'src', kind: 'dir', size: 0 }],
      truncated: false
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:list-dir', 't1', 'src')

    mocks.invoke.mockResolvedValueOnce({ kind: 'text', text: 'x', size: 1, truncated: false })
    await expect(kyclawApi.workbench.readFile('t1', 'a.txt')).resolves.toEqual({
      kind: 'text',
      text: 'x',
      size: 1,
      truncated: false
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:read-file', 't1', 'a.txt')

    mocks.invoke.mockResolvedValueOnce({ path: 'D:\\项目\\a.txt' })
    await expect(kyclawApi.workbench.reveal('t1', 'a.txt')).resolves.toEqual({
      path: 'D:\\项目\\a.txt'
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:reveal', 't1', 'a.txt')
  })

  it('round 77：open 走 workbench:open（同一个 [threadId, 相对路径]），回包过 { path } schema', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({ path: 'D:\\项目\\方案.docx' })
    await expect(kyclawApi.workbench.open('t1', '方案.docx')).resolves.toEqual({
      path: 'D:\\项目\\方案.docx'
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:open', 't1', '方案.docx')

    // 结构不对就抛（路径是打开动作的凭据，不交半截对象）
    mocks.invoke.mockResolvedValueOnce({ path: '' })
    await expect(kyclawApi.workbench.open('t1', '方案.docx')).rejects.toThrow(/结构不合法/)
  })

  it('文件预览是按 kind 判别的联合：判别字段不对/多带字段都当结构不合法', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({ kind: 'binary', size: 1 })
    await expect(kyclawApi.workbench.readFile('t1', 'a')).resolves.toEqual({
      kind: 'binary',
      size: 1
    })

    mocks.invoke.mockResolvedValueOnce({ kind: 'text', text: 'x' })
    await expect(kyclawApi.workbench.readFile('t1', 'a')).rejects.toThrow(/结构不合法/)

    mocks.invoke.mockResolvedValueOnce({
      kind: 'text',
      text: 'x',
      size: 1,
      truncated: false,
      额外: 1
    })
    await expect(kyclawApi.workbench.readFile('t1', 'a')).rejects.toThrow(/结构不合法/)
  })

  it('round 44：search 发 [threadId, query, mode]，结果按 schema 解析（对不上就抛）', async () => {
    const { kyclawApi } = await loadPreload()

    const result = {
      results: [
        { path: 'src/index.ts', name: 'index.ts', line: 2, preview: '// TODO' },
        { path: 'README.md', name: 'README.md' }
      ],
      truncated: false,
      scanned: 12
    }
    mocks.invoke.mockResolvedValueOnce(result)
    await expect(kyclawApi.workbench.search('t1', 'todo', 'content')).resolves.toEqual(result)
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:search', 't1', 'todo', 'content')

    // 命中缺 path / mode 认不出 / 多带字段：都是结构不合法
    mocks.invoke.mockResolvedValueOnce({
      results: [{ name: 'a.ts' }],
      truncated: false,
      scanned: 1
    })
    await expect(kyclawApi.workbench.search('t1', 'a.ts', 'name')).rejects.toThrow(/结构不合法/)

    mocks.invoke.mockResolvedValueOnce({ results: [], truncated: false, scanned: 0, 额外: 1 })
    await expect(kyclawApi.workbench.search('t1', 'a.ts', 'name')).rejects.toThrow(/结构不合法/)
  })

  it('git 三件：总览按 isRepo 形态解析、历史与详情各自的 schema', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({ isRepo: false, empty: false, branch: null, changes: [] })
    await expect(kyclawApi.workbench.gitOverview('t1')).resolves.toEqual({
      isRepo: false,
      empty: false,
      branch: null,
      changes: []
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:git-overview', 't1')

    mocks.invoke.mockResolvedValueOnce({ commits: [] })
    await expect(kyclawApi.workbench.gitLog('t1', 200)).resolves.toEqual({ commits: [] })
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:git-log', 't1', 200)

    const detail = {
      sha: 'a'.repeat(40),
      short: 'aaaaaaa',
      author: '张三',
      email: 'z@example.com',
      date: '2026-10-11T10:00:00+08:00',
      message: '标题',
      files: [{ path: 'a.ts', additions: 1, deletions: null }]
    }
    mocks.invoke.mockResolvedValueOnce(detail)
    await expect(kyclawApi.workbench.gitShow('t1', detail.sha)).resolves.toEqual(detail)
    expect(mocks.invoke).toHaveBeenLastCalledWith('workbench:git-show', 't1', detail.sha)

    mocks.invoke.mockResolvedValueOnce({ commits: [{ sha: 'x' }] })
    await expect(kyclawApi.workbench.gitLog('t1', 1)).rejects.toThrow(/结构不合法/)
  })

  it('terminal：start 发 [threadId, cols, rows]；write / resize / dispose 各走各的通道', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({
      id: 'term-1',
      shell: 'D:\\Git\\bin\\bash.exe',
      cwd: 'D:\\项目'
    })
    await expect(kyclawApi.terminal.start('t1', 120, 40)).resolves.toEqual({
      id: 'term-1',
      shell: 'D:\\Git\\bin\\bash.exe',
      cwd: 'D:\\项目'
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal:start', 't1', 120, 40)

    await kyclawApi.terminal.write('term-1', 'ls\n')
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal:write', 'term-1', 'ls\n')

    await kyclawApi.terminal.resize('term-1', 100, 30)
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal:resize', 'term-1', 100, 30)

    await kyclawApi.terminal.dispose('term-1')
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal:dispose', 'term-1')

    // 结构不对就抛（半截会话没法定位进程）
    mocks.invoke.mockResolvedValueOnce({ id: 'term-2' })
    await expect(kyclawApi.terminal.start('t1', 80, 24)).rejects.toThrow(/结构不合法/)
  })

  it('terminal 的两条推送：合法 payload 转给监听方，脏 payload 丢掉，退订摘同一个监听器', async () => {
    const { kyclawApi } = await loadPreload()
    /** 最近一次注册的监听器（本文件前面的 pushedListener 取的是第一条，这里要按顺序取） */
    const lastListener = (): ((event: unknown, payload: unknown) => void) => {
      const call = mocks.on.mock.calls.at(-1)
      if (!call) throw new Error('没有订阅任何通道')
      return call[1] as (event: unknown, payload: unknown) => void
    }

    const onData = vi.fn()
    const off = kyclawApi.terminal.onData(onData)

    expect(mocks.on).toHaveBeenLastCalledWith('terminal:data', expect.any(Function))
    lastListener()({}, { id: 'term-1', data: 'hi' })
    expect(onData).toHaveBeenCalledWith({ id: 'term-1', data: 'hi' })
    lastListener()({}, { id: 'term-1' })
    expect(onData).toHaveBeenCalledTimes(1)
    off()
    expect(mocks.removeListener).toHaveBeenLastCalledWith('terminal:data', expect.any(Function))

    const onExit = vi.fn()
    kyclawApi.terminal.onExit(onExit)
    expect(mocks.on).toHaveBeenLastCalledWith('terminal:exit', expect.any(Function))
    lastListener()({}, { id: 'term-1', exitCode: 3 })
    expect(onExit).toHaveBeenCalledWith({ id: 'term-1', exitCode: 3 })
    lastListener()({}, { id: 'term-1', exitCode: 'x' })
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})

describe('preload：window.kyclaw.files（round 53，File → 绝对路径的小桥）', () => {
  it('pathForFile 走 webUtils.getPathForFile；抛异常（不是真文件）回空串，不打断上层', async () => {
    const { kyclawApi } = await loadPreload()
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })

    mocks.getPathForFile.mockReturnValueOnce('D:\\Downloads\\a.txt')
    expect(kyclawApi.files.pathForFile(file)).toBe('D:\\Downloads\\a.txt')
    expect(mocks.getPathForFile).toHaveBeenLastCalledWith(file)

    // 内存里造的 / 跨进程来的 File：electron 侧会抛 —— 这里回 ''，调用方按"拿不到"兜底
    mocks.getPathForFile.mockImplementationOnce(() => {
      throw new Error('file is not a real file')
    })
    expect(kyclawApi.files.pathForFile(file)).toBe('')
  })
})
