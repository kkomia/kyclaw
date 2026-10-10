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
