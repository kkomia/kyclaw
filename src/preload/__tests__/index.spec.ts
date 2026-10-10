import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener }
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
  it('暴露 settings 一族（读 / 改 / 密钥 / 密钥状态 / 测试连接 / 删除）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.settings).sort()).toEqual([
      'get',
      'providerKeyStates',
      'removeProvider',
      'setProviderKey',
      'testProvider',
      'update'
    ])
  })

  it('get 打 settings:get，返回值按同一份 schema 解析后交给上层', async () => {
    const { kyclawApi } = await loadPreload()
    const persisted = {
      theme: 'dark',
      fontTier: 'large',
      providers: [],
      workspaces: [],
      permissions: { rules: [] }
    }
    mocks.invoke.mockResolvedValueOnce(persisted)

    await expect(kyclawApi.settings.get()).resolves.toEqual(persisted)
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:get')
  })

  it('get 的返回值结构不对（跨边界脏数据）→ 默认值，不把脏数据交给上层', async () => {
    const { kyclawApi } = await loadPreload()

    for (const bad of [{ theme: 'blue' }, { theme: 'dark' }, 'dark', null]) {
      mocks.invoke.mockResolvedValueOnce(bad)
      await expect(kyclawApi.settings.get()).resolves.toEqual({
        theme: 'system',
        fontTier: 'default',
        providers: [],
        workspaces: [],
        permissions: { rules: [] }
      })
    }
  })

  it('update 把补丁原样发给 settings:update，回吐落盘后的完整设置', async () => {
    const { kyclawApi } = await loadPreload()
    const updated = {
      theme: 'light',
      fontTier: 'default',
      providers: [],
      workspaces: [],
      permissions: { rules: [] }
    }
    mocks.invoke.mockResolvedValueOnce(updated)

    await expect(kyclawApi.settings.update({ theme: 'light' })).resolves.toEqual(updated)
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:update', { theme: 'light' })
  })

  it('update 的返回值结构不对 → 默认值（渲染端不拿到半截对象）', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ theme: 'light' })

    await expect(kyclawApi.settings.update({ theme: 'light' })).resolves.toEqual({
      theme: 'system',
      fontTier: 'default',
      providers: [],
      workspaces: [],
      permissions: { rules: [] }
    })
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

  it('testProvider 带上 id，结果按 schema 解析；脏数据（两个分支混在一起）抛错', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({ ok: true, latencyMs: 812 })

    await expect(kyclawApi.settings.testProvider('deepseek')).resolves.toEqual({
      ok: true,
      latencyMs: 812
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:test-provider', 'deepseek')

    mocks.invoke.mockResolvedValueOnce({ ok: false, message: '认证失败', latencyMs: 1 })
    await expect(kyclawApi.settings.testProvider('deepseek')).rejects.toThrow()
  })

  it('removeProvider 走 settings:remove-provider，回吐合并后的设置（脏数据回默认值）', async () => {
    const { kyclawApi } = await loadPreload()
    mocks.invoke.mockResolvedValueOnce({
      theme: 'dark',
      fontTier: 'default',
      providers: [],
      workspaces: [],
      permissions: { rules: [] }
    })

    await expect(kyclawApi.settings.removeProvider('deepseek')).resolves.toEqual({
      theme: 'dark',
      fontTier: 'default',
      providers: [],
      workspaces: [],
      permissions: { rules: [] }
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('settings:remove-provider', 'deepseek')
  })
})

describe('preload：window.kyclaw.workspace', () => {
  /** 落盘后的设置（含一条工作区），用作 workspace 面回包的样本 */
  const persisted = {
    theme: 'system',
    fontTier: 'default',
    providers: [],
    workspaces: [{ path: 'D:\\项目', mode: 'ask' }],
    permissions: { rules: [] }
  }

  it('暴露 workspace 一族（pick / add / setMode / remove）', async () => {
    const { kyclawApi } = await loadPreload()

    expect(Object.keys(kyclawApi.workspace).sort()).toEqual(['add', 'pick', 'remove', 'setMode'])
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

  it('回包结构不对（跨边界脏数据）→ 默认值：多一个字段的工作区也不许进渲染端', async () => {
    const { kyclawApi } = await loadPreload()

    mocks.invoke.mockResolvedValueOnce({
      ...persisted,
      workspaces: [{ path: 'D:\\项目', mode: 'ask', extra: 1 }]
    })

    await expect(kyclawApi.workspace.pick()).resolves.toEqual({
      theme: 'system',
      fontTier: 'default',
      providers: [],
      workspaces: [],
      permissions: { rules: [] }
    })
  })
})
