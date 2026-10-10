// @vitest-environment node
/**
 * 更新通道（T17）：源解析的三条路 + 状态机的每一步。
 *
 * 这里不 import electron-updater（它 require('electron')，只有在主进程里能加载）：
 * 状态机对后端的依赖被压成一个窄接口（UpdateBackend），单测注入假件。
 * 真后端与真更新源的行为由本机模拟（smoke-t17）与主进程实测覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createInertUpdater,
  createKyclawUpdater,
  createUpdater,
  hasBundledUpdateConfig,
  resolveUpdateSource,
  type UpdateBackend,
  type UpdateBackendEvents
} from '../updater'
import type { UpdateState } from '../../shared/ipc'

/** 假后端：记下配置、按需发事件、按需失败 */
class FakeBackend implements UpdateBackend {
  feedUrl: string | null = null
  forceDevConfig: boolean | null = null
  checks = 0
  installs = 0
  /** 每次 check() 时抛出的错误（模拟网络/解析失败） */
  failWith: Error | null = null
  /** check() 期间要发的事件（模拟 electron-updater 在检查过程中回调） */
  checkEvents: Array<() => void> = []

  private readonly listeners = new Map<keyof UpdateBackendEvents, Set<(...args: never[]) => void>>()

  on<E extends keyof UpdateBackendEvents>(event: E, listener: UpdateBackendEvents[E]): void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener as (...args: never[]) => void)
    this.listeners.set(event, set)
  }

  emit<E extends keyof UpdateBackendEvents>(
    event: E,
    ...args: Parameters<UpdateBackendEvents[E]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (...inner: Parameters<UpdateBackendEvents[E]>) => void)(...args)
    }
  }

  setFeedURL(url: string): void {
    this.feedUrl = url
  }

  setForceDevConfig(force: boolean): void {
    this.forceDevConfig = force
  }

  async check(): Promise<unknown> {
    this.checks += 1
    for (const event of this.checkEvents.splice(0)) event()
    if (this.failWith !== null) throw this.failWith
    return { updateInfo: { version: '1.0.1' } }
  }

  install(): void {
    this.installs += 1
  }
}

function updaterWith(
  backend: FakeBackend,
  source?: Parameters<typeof createUpdater>[0]['source']
): { updater: ReturnType<typeof createUpdater>; changes: UpdateState[] } {
  const changes: UpdateState[] = []
  const updater = createUpdater({
    currentVersion: '1.0.0',
    source:
      source ?? ({ kind: 'url', url: 'http://127.0.0.1:8555/', forceDevConfig: true } as const),
    backend,
    onChange: (state) => changes.push(state)
  })
  return { updater, changes }
}

describe('resolveUpdateSource：环境变量 > 打包内配置 > 未配置', () => {
  it('环境变量给了地址：用它，未打包实例还要开 forceDevUpdateConfig', () => {
    expect(
      resolveUpdateSource({
        envUrl: 'http://127.0.0.1:8555/',
        isPackaged: false,
        hasBundledConfig: false
      })
    ).toEqual({ kind: 'url', url: 'http://127.0.0.1:8555/', forceDevConfig: true })
    expect(
      resolveUpdateSource({
        envUrl: 'https://gitee.com/o/r/releases/download/v1.0.1',
        isPackaged: true,
        hasBundledConfig: true
      })
    ).toEqual({
      kind: 'url',
      url: 'https://gitee.com/o/r/releases/download/v1.0.1',
      forceDevConfig: false
    })
  })

  it('空白环境变量不算配置（等于没给），地址两端空白被去掉', () => {
    expect(
      resolveUpdateSource({ envUrl: '   ', isPackaged: false, hasBundledConfig: false })
    ).toEqual({ kind: 'none' })
    expect(
      resolveUpdateSource({
        envUrl: '  http://127.0.0.1:8555/  ',
        isPackaged: false,
        hasBundledConfig: false
      })
    ).toEqual({ kind: 'url', url: 'http://127.0.0.1:8555/', forceDevConfig: true })
  })

  it('打包内带 app-update.yml 就用它；开发态里这个文件不算数（没有 publish 的产物不该被读）', () => {
    expect(resolveUpdateSource({ isPackaged: true, hasBundledConfig: true })).toEqual({
      kind: 'bundled'
    })
    expect(resolveUpdateSource({ isPackaged: false, hasBundledConfig: true })).toEqual({
      kind: 'none'
    })
  })

  it('什么都没配 = none（开发态默认）：不检查、不报错', () => {
    expect(resolveUpdateSource({ isPackaged: false, hasBundledConfig: false })).toEqual({
      kind: 'none'
    })
    expect(hasBundledUpdateConfig('D:/不存在的目录')).toBe(false)
  })
})

describe('createUpdater：状态机', () => {
  it('没配源：configured=false、停在 idle；check() 是空操作（不发请求）、install() 什么都不做', async () => {
    const backend = new FakeBackend()
    const updater = createInertUpdater('1.0.0')

    expect(updater.state()).toEqual({
      currentVersion: '1.0.0',
      configured: false,
      status: { phase: 'idle' }
    })

    await expect(updater.check()).resolves.toMatchObject({ configured: false })
    updater.install()
    expect(backend.checks).toBe(0)
    expect(backend.installs).toBe(0)
  })

  it('配了源：把地址与开发态开关交给后端，configured=true', () => {
    const backend = new FakeBackend()
    const { updater } = updaterWith(backend)

    expect(backend.feedUrl).toBe('http://127.0.0.1:8555/')
    expect(backend.forceDevConfig).toBe(true)
    expect(updater.state()).toMatchObject({ configured: true, status: { phase: 'idle' } })
  })

  it('检出 → 下载 → 下载完成：每个事件都翻成状态（percent 取整并夹在 0–100）', async () => {
    const backend = new FakeBackend()
    const { updater, changes } = updaterWith(backend)

    backend.emit('update-available', { version: '1.0.1' })
    expect(updater.state().status).toEqual({ phase: 'available', version: '1.0.1' })

    backend.emit('download-progress', { percent: 41.6 })
    expect(updater.state().status).toEqual({
      phase: 'downloading',
      version: '1.0.1',
      percent: 42
    })

    backend.emit('download-progress', { percent: 250 })
    expect(updater.state().status).toMatchObject({ phase: 'downloading', percent: 100 })
    backend.emit('download-progress', { percent: -3 })
    expect(updater.state().status).toMatchObject({ phase: 'downloading', percent: 0 })

    backend.emit('update-downloaded', { version: '1.0.1' })
    expect(updater.state().status).toEqual({ phase: 'downloaded', version: '1.0.1' })

    // 推给窗口的顺序就是状态变化的顺序
    expect(changes.map((state) => state.status.phase)).toEqual([
      'available',
      'downloading',
      'downloading',
      'downloading',
      'downloaded'
    ])
  })

  it('已是最新：检查结束回到 up-to-date；没有事件兜底时不编造结论（回 idle）', async () => {
    const backend = new FakeBackend()
    const { updater } = updaterWith(backend)

    backend.checkEvents.push(() => backend.emit('update-not-available'))
    await updater.check()
    expect(updater.state().status).toEqual({ phase: 'up-to-date' })

    // 后端一个事件都不发（比如被判定为不活跃）→ 不留在"检查中"
    const quiet = new FakeBackend()
    const other = updaterWith(quiet).updater
    await other.check()
    expect(other.state().status).toEqual({ phase: 'idle' })
  })

  it('check() 等的是"检查"这一步：返回时状态已经是检查后的结果', async () => {
    const backend = new FakeBackend()
    const { updater } = updaterWith(backend)
    backend.checkEvents.push(() => {
      backend.emit('update-available', { version: '2.0.0' })
    })

    await expect(updater.check()).resolves.toMatchObject({
      status: { phase: 'available', version: '2.0.0' }
    })
    expect(backend.checks).toBe(1)
  })

  it('后端抛错 / 发 error 事件：都进同一格，文案压成一行且截断（不带栈）', async () => {
    const backend = new FakeBackend()
    const { updater } = updaterWith(backend)

    backend.emit(
      'error',
      new Error('Cannot check for updates: Error: getaddrinfo ENOTFOUND\n    at x')
    )
    expect(updater.state().status).toEqual({
      phase: 'error',
      message: 'Cannot check for updates: Error: getaddrinfo ENOTFOUND at x'
    })

    const throwing = new FakeBackend()
    throwing.failWith = new Error('x'.repeat(300))
    const other = updaterWith(throwing).updater
    await other.check()
    const status = other.state().status
    expect(status.phase).toBe('error')
    if (status.phase === 'error') {
      expect(status.message?.endsWith('…')).toBe(true)
      expect(status.message?.length).toBe(160)
    }
  })

  it('install 只在"已下载"阶段生效（检查中/下载中点它没有动作）', async () => {
    const backend = new FakeBackend()
    const { updater } = updaterWith(backend)

    updater.install()
    expect(backend.installs).toBe(0)

    backend.emit('update-available', { version: '1.0.1' })
    updater.install()
    expect(backend.installs).toBe(0)

    backend.emit('update-downloaded', { version: '1.0.1' })
    updater.install()
    expect(backend.installs).toBe(1)
  })
})

describe('createKyclawUpdater：装配不抛', () => {
  it('electron-updater 在非主进程里加载不起来 → 退回"未配置"实例并留日志（不拦启动）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const updater = await createKyclawUpdater({
      currentVersion: '1.0.0',
      envUrl: 'http://127.0.0.1:65535/',
      isPackaged: false,
      hasBundledConfig: false
    })

    expect(updater.state()).toEqual({
      currentVersion: '1.0.0',
      configured: false,
      status: { phase: 'idle' }
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('没配源时连 electron-updater 都不加载（本机构建端也不该为更新通道付加载成本）', async () => {
    const updater = await createKyclawUpdater({
      currentVersion: '1.0.0',
      isPackaged: false,
      hasBundledConfig: false
    })

    expect(updater.state().configured).toBe(false)
  })
})
