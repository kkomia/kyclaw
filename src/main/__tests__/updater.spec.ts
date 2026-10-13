// @vitest-environment node
/**
 * 更新通道（T17 / round 63）：源解析的四条路（env > 设置 > 打包内 > 未配置）+ 渠道推导与兜底重试
 * + 状态机与运行时重配（reconfigure）。
 *
 * 这里不 import electron-updater（它 require('electron')，只有在主进程里能加载）：
 * 状态机对后端的依赖被压成一个窄接口（UpdateBackend），单测注入假件。
 * 真后端与真更新源的行为由本机模拟（smoke-t17）与主进程实测覆盖。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelOf,
  createInertUpdater,
  createKyclawUpdater,
  createUpdater,
  hasBundledUpdateConfig,
  normalizeUpdateUrl,
  readBundledUpdateUrl,
  resolveUpdateSource,
  type KyclawUpdater,
  type UpdateBackend,
  type UpdateBackendEvents,
  type UpdateChannel,
  type UpdateSource
} from '../updater'
import type { UpdateState } from '../../shared/ipc'

/** 源上没有渠道文件时 electron-updater 抛的那个错误（真件上还挂着 code） */
function channelFileMissing(file: string): Error {
  const error = new Error(`Cannot find channel "${file}" update info: Error: HttpError: 404`)
  ;(error as Error & { code?: string }).code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
  return error
}

/** 假后端：记下配置、按需发事件、按需失败 */
class FakeBackend implements UpdateBackend {
  feedUrl: string | null = null
  feedChannel: UpdateChannel | null = null
  forceDevConfig: boolean | null = null
  checks = 0
  installs = 0
  /** 每次 check() 抛出的错误（按顺序取；取完就不再抛）——模拟网络/渠道文件不存在 */
  failWith: Error[] = []
  /** check() 期间要发的事件（模拟 electron-updater 在检查过程中回调，比如它先发 error 再抛） */
  checkEvents: Array<() => void> = []
  /** 检查成功时要不要发"已是最新"（真件拿到渠道文件就会给结论；失败的那次不会） */
  emitNotAvailable = false

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

  setFeedURL(url: string, channel: UpdateChannel): void {
    this.feedUrl = url
    this.feedChannel = channel
  }

  setForceDevConfig(force: boolean): void {
    this.forceDevConfig = force
  }

  async check(): Promise<unknown> {
    this.checks += 1
    for (const event of this.checkEvents.splice(0)) event()
    const failure = this.failWith.shift()
    if (failure !== undefined) throw failure
    if (this.emitNotAvailable) this.emit('update-not-available')
    return { updateInfo: { version: '1.0.1' } }
  }

  install(): void {
    this.installs += 1
  }
}

/** 源落到后端是异步的（后端惰性装配、事件也在这时挂上）：等一拍再断言 feed / 发事件 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

interface Built {
  updater: KyclawUpdater
  changes: UpdateState[]
  backend: FakeBackend
  /** 换源（模拟设置里改完 updateUrl） */
  setSource: (next: UpdateSource) => void
}

function built(options: {
  version?: string
  source?: UpdateSource
  builtinUrl?: string | null
  backend?: FakeBackend
}): Built {
  const backend = options.backend ?? new FakeBackend()
  const changes: UpdateState[] = []
  let source: UpdateSource = options.source ?? {
    kind: 'url',
    url: 'http://127.0.0.1:8555/',
    forceDevConfig: true
  }
  const updater = createUpdater({
    currentVersion: options.version ?? '1.0.0',
    resolveSource: () => source,
    builtinUrl: options.builtinUrl ?? null,
    backend: async () => backend,
    onChange: (state) => changes.push(state)
  })
  return { updater, changes, backend, setSource: (next) => (source = next) }
}

describe('resolveUpdateSource：env > 设置里的更新源 > 打包内配置 > 未配置', () => {
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
        envUrl: 'https://gitee.com/o/r/releases/download/v1.0.1/',
        isPackaged: true,
        hasBundledConfig: true
      })
    ).toEqual({
      kind: 'url',
      url: 'https://gitee.com/o/r/releases/download/v1.0.1/',
      forceDevConfig: false
    })
  })

  it('设置里填的地址排第二：env 没给（或给了空/非法）时用它；env 给了就听 env 的', () => {
    expect(
      resolveUpdateSource({
        settingsUrl: 'https://mine.example.com/releases/',
        isPackaged: true,
        hasBundledConfig: true
      })
    ).toEqual({ kind: 'url', url: 'https://mine.example.com/releases/', forceDevConfig: false })

    expect(
      resolveUpdateSource({
        envUrl: '  ',
        settingsUrl: 'https://mine.example.com/releases/',
        isPackaged: false,
        hasBundledConfig: false
      })
    ).toEqual({ kind: 'url', url: 'https://mine.example.com/releases/', forceDevConfig: true })

    expect(
      resolveUpdateSource({
        envUrl: 'https://test.example.com/',
        settingsUrl: 'https://mine.example.com/releases/',
        isPackaged: true,
        hasBundledConfig: true
      })
    ).toEqual({ kind: 'url', url: 'https://test.example.com/', forceDevConfig: false })
  })

  it('地址归一化：两端空白去掉、路径补尾斜杠（与 electron-updater 的 newBaseUrl 同口径）', () => {
    expect(normalizeUpdateUrl('  http://127.0.0.1:8555  ')).toBe('http://127.0.0.1:8555/')
    expect(normalizeUpdateUrl('http://192.168.31.18:9000/kyclaw/releases')).toBe(
      'http://192.168.31.18:9000/kyclaw/releases/'
    )
    // 已有尾斜杠/查询串的地址不被改动（查询串留着——那可能是访问凭据）
    expect(normalizeUpdateUrl('http://h/releases/?token=abc')).toBe('http://h/releases/?token=abc')
    expect(
      resolveUpdateSource({
        settingsUrl: 'http://127.0.0.1:8555',
        isPackaged: true,
        hasBundledConfig: false
      })
    ).toEqual({ kind: 'url', url: 'http://127.0.0.1:8555/', forceDevConfig: false })
  })

  it('非法地址一律当没配（不抛）：顺着优先级往下走，都不行就回"未配置"', () => {
    for (const bad of ['ftp://host/x', 'not a url', 'http://', 'file:///D:/releases']) {
      expect(normalizeUpdateUrl(bad), bad).toBeNull()
      // 打包件：非法地址不该把烘焙好的内置源顶掉
      expect(
        resolveUpdateSource({ settingsUrl: bad, isPackaged: true, hasBundledConfig: true }),
        bad
      ).toEqual({ kind: 'bundled' })
      // 开发态：就是"没配"（不检查、不报错）
      expect(
        resolveUpdateSource({ settingsUrl: bad, isPackaged: false, hasBundledConfig: true })
      ).toEqual({ kind: 'none' })
    }
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

describe('channelOf：渠道文件名跟着版本走', () => {
  it('预发布（含 -）走 beta，正式版走 latest', () => {
    expect(channelOf('0.1.0-beta.3')).toBe('beta')
    expect(channelOf('0.1.0')).toBe('latest')
  })
})

describe('readBundledUpdateUrl：读打包内 app-update.yml 的 url 一行（best-effort）', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function resourcesWith(content: string): string {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-bundled-'))
    writeFileSync(join(dir, 'app-update.yml'), content, 'utf8')
    return dir
  }

  it('读出 provider/url/channel 里那个 url（取顶层键、去掉引号与空白）', () => {
    const resources = resourcesWith(
      'provider: generic\nurl: http://192.168.31.18:9000/kyclaw/releases/\nchannel: beta\n'
    )
    expect(readBundledUpdateUrl(resources)).toBe('http://192.168.31.18:9000/kyclaw/releases/')

    const quoted = resourcesWith('provider: generic\n"url": "http://h:9/r"\n')
    expect(readBundledUpdateUrl(quoted)).toBeNull()
  })

  it('没有这个文件 / 没有 url 行 / url 不是 http(s)：回 null（网络那一步照旧由 electron-updater 读盘）', () => {
    expect(readBundledUpdateUrl('D:/不存在的目录')).toBeNull()
    expect(readBundledUpdateUrl(resourcesWith('provider: generic\nchannel: beta\n'))).toBeNull()
    expect(readBundledUpdateUrl(resourcesWith('url: file:///D:/releases\n'))).toBeNull()
  })
})

describe('createUpdater：状态机', () => {
  it('没配源：configured=false、停在 idle；check() 是空操作（不发请求、连后端都不取）', async () => {
    const backend = new FakeBackend()
    const loader = vi.fn(async () => backend)
    const updater = createUpdater({
      currentVersion: '1.0.0',
      resolveSource: () => ({ kind: 'none' }),
      backend: loader
    })

    expect(updater.state()).toEqual({
      currentVersion: '1.0.0',
      configured: false,
      builtinUrl: null,
      status: { phase: 'idle' }
    })

    await expect(updater.check()).resolves.toMatchObject({ configured: false })
    updater.install()
    expect(loader).not.toHaveBeenCalled()
    expect(backend.checks).toBe(0)
    expect(backend.installs).toBe(0)

    // 占位实例（主进程在异步装配前顶位子用的那个）是同一套"什么都不做"
    expect(createInertUpdater('1.0.0').state()).toEqual(updater.state())
  })

  it('配了源：把地址、渠道与开发态开关交给后端，configured=true', async () => {
    const { updater, backend } = built({})
    await flush()

    expect(backend.feedUrl).toBe('http://127.0.0.1:8555/')
    // 正式版本 → latest.yml
    expect(backend.feedChannel).toBe('latest')
    expect(backend.forceDevConfig).toBe(true)
    expect(updater.state()).toMatchObject({ configured: true, status: { phase: 'idle' } })
  })

  it('渠道按版本推：预发布包要 beta.yml（不带给后端的话它会去找 latest.yml，直接 404）', async () => {
    const { backend } = built({ version: '0.1.0-beta.3' })
    await flush()

    expect(backend.feedChannel).toBe('beta')
  })

  it('内置源：用 app-update.yml 里读到的地址 + 版本推导的渠道（打包件不留空占位）', async () => {
    const { updater, backend } = built({
      version: '0.1.0-beta.3',
      source: { kind: 'bundled' },
      builtinUrl: 'http://192.168.31.18:9000/kyclaw/releases/'
    })
    await flush()

    expect(backend.feedUrl).toBe('http://192.168.31.18:9000/kyclaw/releases/')
    expect(backend.feedChannel).toBe('beta')
    // 内置源的地址也进状态：设置页拿它当输入框的占位提示
    expect(updater.state()).toEqual({
      currentVersion: '0.1.0-beta.3',
      configured: true,
      builtinUrl: 'http://192.168.31.18:9000/kyclaw/releases/',
      status: { phase: 'idle' }
    })
  })

  it('检出 → 下载 → 下载完成：每个事件都翻成状态（percent 取整并夹在 0–100）', async () => {
    const { updater, changes, backend } = built({})
    await flush()

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
    const { updater, backend } = built({})

    backend.checkEvents.push(() => backend.emit('update-not-available'))
    await updater.check()
    expect(updater.state().status).toEqual({ phase: 'up-to-date' })

    // 后端一个事件都不发（比如被判定为不活跃）→ 不留在"检查中"
    const other = built({})
    await other.updater.check()
    expect(other.updater.state().status).toEqual({ phase: 'idle' })
  })

  it('check() 等的是"检查"这一步：返回时状态已经是检查后的结果', async () => {
    const { updater, backend } = built({})
    backend.checkEvents.push(() => {
      backend.emit('update-available', { version: '2.0.0' })
    })

    await expect(updater.check()).resolves.toMatchObject({
      status: { phase: 'available', version: '2.0.0' }
    })
    expect(backend.checks).toBe(1)
  })

  it('后端抛错 / 发 error 事件：都进同一格，文案压成一行且截断（不带栈）', async () => {
    const { updater, backend } = built({})
    await flush()

    backend.emit(
      'error',
      new Error('Cannot check for updates: Error: getaddrinfo ENOTFOUND\n    at x')
    )
    expect(updater.state().status).toEqual({
      phase: 'error',
      message: 'Cannot check for updates: Error: getaddrinfo ENOTFOUND at x'
    })

    const throwing = new FakeBackend()
    throwing.failWith = [new Error('x'.repeat(300))]
    const other = built({ backend: throwing })
    await other.updater.check()
    const status = other.updater.state().status
    expect(status.phase).toBe('error')
    if (status.phase === 'error') {
      expect(status.message?.endsWith('…')).toBe(true)
      expect(status.message?.length).toBe(160)
    }
  })

  it('install 只在"已下载"阶段生效（检查中/下载中点它没有动作）', async () => {
    const { updater, backend } = built({})
    await flush()

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

describe('createUpdater：渠道兜底重试', () => {
  it('beta 包对着只有 latest.yml 的源：换渠道再试一次就成了，并记住哪条通', async () => {
    const { updater, backend } = built({ version: '0.1.0-beta.3' })
    await flush()
    expect(backend.feedChannel).toBe('beta')

    // 第一次 beta.yml 404；换了渠道之后 latest.yml 拿到了
    backend.failWith = [channelFileMissing('beta.yml')]
    backend.emitNotAvailable = true
    await updater.check()

    expect(backend.checks).toBe(2)
    expect(backend.feedChannel).toBe('latest')
    expect(updater.state().status).toEqual({ phase: 'up-to-date' })

    // 本会话记住了：下一次检查直接从 latest 开始（不再白跑一次 404）
    await updater.check()
    expect(backend.checks).toBe(3)
    expect(backend.feedChannel).toBe('latest')
  })

  it('正式包对着只有 beta.yml 的源：反方向同样能更新', async () => {
    const { updater, backend } = built({})
    await flush()

    backend.failWith = [channelFileMissing('latest.yml')]
    backend.emitNotAvailable = true
    await updater.check()

    expect(backend.feedChannel).toBe('beta')
    expect(updater.state().status).toEqual({ phase: 'up-to-date' })
  })

  it('错误走 error 事件（不是 promise 拒绝）也认：单测与真件两条路都覆盖', async () => {
    const { updater, backend } = built({ version: '0.1.0-beta.3' })
    await flush()

    backend.checkEvents.push(() => backend.emit('error', channelFileMissing('beta.yml')))
    backend.emitNotAvailable = true
    await updater.check()

    expect(backend.checks).toBe(2)
    expect(backend.feedChannel).toBe('latest')
    expect(updater.state().status).toEqual({ phase: 'up-to-date' })
  })

  it('两条渠道都没有：报第一次的错（版本推导的那条），渠道记忆也还回去', async () => {
    const { updater, backend } = built({ version: '0.1.0-beta.3' })
    await flush()

    backend.failWith = [channelFileMissing('beta.yml'), channelFileMissing('latest.yml')]
    await updater.check()

    expect(backend.checks).toBe(2)
    expect(backend.feedChannel).toBe('beta')
    expect(updater.state().status).toMatchObject({ phase: 'error' })
    const status = updater.state().status
    if (status.phase === 'error') expect(status.message).toContain('beta.yml')
  })

  it('别的错不重试（连不上源不是"渠道不对"，换一条也一样连不上）', async () => {
    const { updater, backend } = built({ version: '0.1.0-beta.3' })
    await flush()

    backend.failWith = [new Error('getaddrinfo ENOTFOUND updates.example.com')]
    await updater.check()

    expect(backend.checks).toBe(1)
    expect(updater.state().status).toMatchObject({ phase: 'error' })
  })
})

describe('createUpdater：运行时重配（设置里改更新源）', () => {
  it('源变了：立刻重算 configured、相位归 idle 并广播一次（不用重启）', async () => {
    const { updater, changes, backend, setSource } = built({ source: { kind: 'none' } })
    expect(updater.state()).toMatchObject({ configured: false, status: { phase: 'idle' } })

    // 先检查一轮（未配置 = 空操作）
    await updater.check()
    expect(backend.checks).toBe(0)

    setSource({ kind: 'url', url: 'https://mine.example.com/releases/', forceDevConfig: false })
    updater.reconfigure()
    await flush()

    expect(updater.state()).toMatchObject({ configured: true, status: { phase: 'idle' } })
    expect(backend.feedUrl).toBe('https://mine.example.com/releases/')
    expect(backend.feedChannel).toBe('latest')
    expect(changes[changes.length - 1]).toMatchObject({
      configured: true,
      builtinUrl: null,
      status: { phase: 'idle' }
    })

    // 之后的检查走新源
    await updater.check()
    expect(backend.checks).toBe(1)
  })

  it('源没变：什么都不做（保存别的设置不该把状态行清掉）', async () => {
    const { updater, changes, backend } = built({})
    await flush()
    backend.emit('update-downloaded', { version: '1.0.1' })
    const before = changes.length

    updater.reconfigure()

    expect(changes.length).toBe(before)
    expect(updater.state().status).toEqual({ phase: 'downloaded', version: '1.0.1' })
  })

  it('从覆盖源切回内置源：把内置地址显式设回去（setFeedURL 之后那份 yml 不再被读）', async () => {
    const { updater, backend, setSource } = built({
      source: { kind: 'url', url: 'https://mine.example.com/releases/', forceDevConfig: false },
      builtinUrl: 'http://192.168.31.18:9000/kyclaw/releases/'
    })
    await flush()
    expect(backend.feedUrl).toBe('https://mine.example.com/releases/')

    setSource({ kind: 'bundled' })
    updater.reconfigure()
    await flush()

    expect(backend.feedUrl).toBe('http://192.168.31.18:9000/kyclaw/releases/')
    expect(updater.state()).toMatchObject({ configured: true, status: { phase: 'idle' } })
  })

  it('清空更新源（回开发态的"没配"）：configured=false，检查变回空操作', async () => {
    const { updater, backend, setSource } = built({})
    await flush()

    setSource({ kind: 'none' })
    updater.reconfigure()

    expect(updater.state()).toMatchObject({ configured: false })
    await updater.check()
    expect(backend.checks).toBe(0)
  })

  it('reconfigure 之后渠道记忆重新按版本推（新源不一定有旧渠道的文件）', async () => {
    const { updater, backend, setSource } = built({ version: '0.1.0-beta.3' })
    await flush()

    backend.failWith = [channelFileMissing('beta.yml')]
    await updater.check()
    expect(backend.feedChannel).toBe('latest')

    setSource({ kind: 'url', url: 'https://mine.example.com/releases/', forceDevConfig: false })
    updater.reconfigure()
    await flush()

    expect(backend.feedUrl).toBe('https://mine.example.com/releases/')
    expect(backend.feedChannel).toBe('beta')
  })
})

describe('createKyclawUpdater：装配不抛', () => {
  it('electron-updater 在非主进程里加载不起来 → 退回"未配置"实例并留日志（不拦启动）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const updater = await createKyclawUpdater({
      currentVersion: '1.0.0',
      resolveSource: () => ({ kind: 'url', url: 'http://127.0.0.1:65535/', forceDevConfig: true })
    })

    expect(updater.state()).toEqual({
      currentVersion: '1.0.0',
      configured: false,
      builtinUrl: null,
      status: { phase: 'idle' }
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('没配源时连 electron-updater 都不加载（本机构建端也不该为更新通道付加载成本）', async () => {
    const updater = await createKyclawUpdater({
      currentVersion: '1.0.0',
      resolveSource: () => ({ kind: 'none' }),
      builtinUrl: 'http://192.168.31.18:9000/kyclaw/releases/'
    })

    // 没配源 = 不检查；打包内地址照旧进状态（设置页拿它当占位提示）
    expect(updater.state()).toMatchObject({
      configured: false,
      builtinUrl: 'http://192.168.31.18:9000/kyclaw/releases/'
    })
  })
})
