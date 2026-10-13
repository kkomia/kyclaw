/**
 * 更新通道（T17 试点；round 63 起源可以在运行时配置）：electron-updater + generic provider
 * （局域网 MinIO / Gitee Release 直链这类静态目录）。
 *
 * 四件说清楚的事：
 *   1. **源从哪来**（优先级从高到低）：环境变量 `KYCLAW_UPDATE_URL`（本机模拟更新源 / 内测切通道）
 *      → 设置里填的更新源（设置 → 关于，改完当场生效、不用重启）→ 打包时烘焙进
 *      resources/app-update.yml 的源 → 都没配 = **不检查、不报错**（开发态与"未配置"的默认路径
 *      安静待着，UI 上只说一句"未配置更新源"）。填错的地址一律当没填（不抛、不拦保存）。
 *   2. **渠道**：渠道文件名跟着版本走——含 '-' 的预发布是 beta.yml，正式版是 latest.yml
 *      （与 scripts/package.mjs 的产物自检、app-update.yml 里的 channel 同一口径）。
 *      运行时的源**必须把渠道一起交给 electron-updater**：调过 setFeedURL 之后它不再读
 *      app-update.yml，不给渠道就会去找 latest.yml（beta 包直接 404）。
 *      源上只有另一条渠道的 yml 时换一条再试一次（本会话记住哪条通）——beta 包对着只有 latest.yml
 *      的源、正式包对着只有 beta.yml 的源，都能更新。
 *   3. **不骚扰**：没有任何弹窗、通知或错误框。状态只落在设置页「关于」栏的一行文字里，
 *      错误也只是一句截断过的话；启动检查是静默的。
 *   4. **不自动装**：检出后自动下载（进度同样只进状态），但**安装必须用户点"重启并安装"**
 *      （autoInstallOnAppQuit = false）—— 本机模拟源给的是假安装包，静默安装不可接受。
 *
 * 为什么把 autoUpdater 包一层：electron-updater 是 electron 运行时模块（而且它的 `error` 事件
 * 没有监听者时会把进程带走），真件在 `electronUpdaterBackend()` 里动态 import；状态机本体不碰
 * electron，单测直接注入假后端（见 main/__tests__/updater.spec.ts）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { UpdateState, UpdateStatus } from '../shared/ipc'

/** 更新源覆盖（本机模拟更新源、内测切通道都走它；优先级最高） */
export const UPDATE_URL_ENV = 'KYCLAW_UPDATE_URL'

/** 打包内的更新配置：electron-builder 配了 publish 时会写进 resources/ */
export const BUNDLED_UPDATE_CONFIG = 'app-update.yml'

/** 开发态替代品：forceDevUpdateConfig 时 electron-updater 读它（repo 根目录一份，不进安装包） */
export const DEV_UPDATE_CONFIG = 'dev-app-update.yml'

/** 错误文案上限：状态栏是一行字，不是日志 */
const ERROR_TEXT_LIMIT = 160

/** 源上没有这条渠道的 yml 时 electron-updater 挂的错误码（渠道兜底重试认它） */
const CHANNEL_FILE_NOT_FOUND = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'

/** 渠道名（= 渠道文件名去掉 .yml） */
export type UpdateChannel = 'beta' | 'latest'

/**
 * 渠道跟着版本走：预发布版本（0.1.0-beta.3）走 beta.yml，正式版走 latest.yml。
 * 与 scripts/package.mjs 的产物自检、electron-builder 写进 app-update.yml 的 channel 同一口径。
 */
export function channelOf(version: string): UpdateChannel {
  return version.includes('-') ? 'beta' : 'latest'
}

/** 另一条渠道（渠道兜底重试用） */
function otherChannel(channel: UpdateChannel): UpdateChannel {
  return channel === 'beta' ? 'latest' : 'beta'
}

/**
 * 更新源地址的规范化：两端空白去掉，必须是 http(s)，路径补尾斜杠
 * （尾斜杠与 electron-updater 内部的 newBaseUrl 同口径——两种写法都指向同一个目录，
 * 归一了才好比较"源变没变"、也才好当占位提示）。
 * 给不出合法地址就回 null：调用方按"没配"处理——地址是用户填的，填错只该是"不生效"，
 * 不该把保存动作炸掉，也不该在状态里编一个源出来。
 */
export function normalizeUpdateUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim() ?? ''
  if (text.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.href
}

/**
 * 更新源的三种下场：url = 显式给了地址（环境变量或设置里填的；未打包时还要开
 * forceDevUpdateConfig，才能读 dev-app-update.yml 里的缓存目录名等本地配置）；
 * bundled = 用打包内的 app-update.yml；none = 没配（安静待着）。
 */
export type UpdateSource =
  { kind: 'url'; url: string; forceDevConfig: boolean } | { kind: 'bundled' } | { kind: 'none' }

/**
 * 按优先级挑一个源。每一步都先过 `normalizeUpdateUrl`：空白与非法地址一律"当作没给"，
 * 顺着优先级往下走（env 填坏了会落到设置里的源，而不是把更新通道整条关掉）。
 */
export function resolveUpdateSource(options: {
  envUrl?: string | undefined
  /** 设置里填的更新源（空串 = 跟随打包内源） */
  settingsUrl?: string | undefined
  isPackaged: boolean
  /** 打包内有没有 app-update.yml（测试注入；生产由调用方 existsSync 判定） */
  hasBundledConfig: boolean
}): UpdateSource {
  const url = normalizeUpdateUrl(options.envUrl) ?? normalizeUpdateUrl(options.settingsUrl)
  if (url !== null) return { kind: 'url', url, forceDevConfig: !options.isPackaged }
  if (options.isPackaged && options.hasBundledConfig) return { kind: 'bundled' }
  return { kind: 'none' }
}

/** 主进程从打包目录判定"有没有 app-update.yml" */
export function hasBundledUpdateConfig(resourcesPath: string): boolean {
  return existsSync(join(resourcesPath, BUNDLED_UPDATE_CONFIG))
}

/**
 * 读打包内 app-update.yml 里的 `url:` 一行（best-effort）。只有两个用处：
 *   - 设置里留空时，界面的更新源输入框拿它当占位提示（用户看得见"留空会用哪个源"）；
 *   - 设过覆盖源之后再切回内置源时，把 feed 显式设回去（见 createUpdater 的 applySource）。
 * 读不出合法地址就回 null：网络那一步照旧由 electron-updater 自己读这份文件，我们不越权、也不猜。
 * 用正则而不是 yaml 解析：这是 electron-builder 生成的扁平键值文件，为一行 url 引一个 yaml 依赖
 * 不划算（`^url:` 只认顶层键，注释行以 # 开头不会命中）。
 */
export function readBundledUpdateUrl(resourcesPath: string): string | null {
  const file = join(resourcesPath, BUNDLED_UPDATE_CONFIG)
  if (!existsSync(file)) return null
  try {
    const matched = /^url:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(file, 'utf8'))
    const raw = matched?.[1]?.replace(/^['"]|['"]$/g, '')
    return raw === undefined ? null : normalizeUpdateUrl(raw)
  } catch (error) {
    console.warn('[kyclaw] 读不出打包内的更新地址（界面上就没有占位提示，更新流程照旧）', error)
    return null
  }
}

/** 假后端（单测）与真后端（electron-updater）共用的那一小块面 */
export interface UpdateBackendEvents {
  'update-available': (info: { version: string }) => void
  'update-not-available': () => void
  'download-progress': (progress: { percent: number }) => void
  'update-downloaded': (info: { version: string }) => void
  error: (error: Error) => void
}

export interface UpdateBackend {
  on<E extends keyof UpdateBackendEvents>(event: E, listener: UpdateBackendEvents[E]): void
  /**
   * 配置 generic provider 源（**必须带渠道**）。注意 electron-updater 的语义：调过它之后
   * 打包内的 app-update.yml 就不再被读（client 被钉死），所以"回内置源"也得显式设一遍。
   */
  setFeedURL(url: string, channel: UpdateChannel): void
  /** 未打包实例也允许检查（electron-updater 的 forceDevUpdateConfig） */
  setForceDevConfig(force: boolean): void
  check(): Promise<unknown>
  /** 重启并安装（调用方负责先确认已下载） */
  install(): void
}

export interface KyclawUpdater {
  state(): UpdateState
  /** 检查更新：结果落在状态里（失败进 error，不抛）；没配源时是空操作 */
  check(): Promise<UpdateState>
  /** 重启并安装（只在"已下载"阶段生效） */
  install(): void
  /**
   * 设置里改了更新源：立刻现算一次 source/configured、重配后端并广播（不用重启）。
   * 源没变就什么都不做（保存别的设置不该把状态行清掉）；变了则相位归 idle（旧源上的结论作废）。
   */
  reconfigure(): void
}

/** 一次检查的结局：ok = 有结果（或错误已经落进状态）；channel-missing = 源上没有这条渠道的 yml */
type CheckAttempt = { kind: 'ok' } | { kind: 'channel-missing'; error: Error }

/** 错误文案：一行、截断、不带栈（electron-updater 的 error.message 有时会带一大段上下文） */
function errorText(error: unknown): string {
  const raw =
    error instanceof Error && error.message.length > 0 ? error.message : String(error ?? '未知错误')
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > ERROR_TEXT_LIMIT ? `${oneLine.slice(0, ERROR_TEXT_LIMIT - 1)}…` : oneLine
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error ?? '未知错误'))
}

function versionOf(info: unknown): string | undefined {
  const version = (info as { version?: unknown } | null)?.version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

/**
 * "源上没有这条渠道的 yml"：electron-updater 给这类失败挂了 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND
 * 错误码（挂在错误对象上），换了包装层可能只剩那句 `Cannot find channel "beta.yml"` 文案——两条都认。
 */
function isChannelFileMissing(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === CHANNEL_FILE_NOT_FOUND) return true
  return error instanceof Error && error.message.includes('Cannot find channel')
}

/** 两个源是不是同一个（reconfigure 靠它决定要不要动） */
function sameSource(a: UpdateSource, b: UpdateSource): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'url' && b.kind === 'url') {
    return a.url === b.url && a.forceDevConfig === b.forceDevConfig
  }
  return true
}

/**
 * 状态机（不碰 electron）：把后端的事件翻成 UpdateState 并回调 `onChange`。
 * 没配置源时给一个"什么都不做"的实例——IPC 那侧就不必到处判空。
 *
 * 与 T17 版的三处不同（round 63）：
 *   - 源不再在构造那一刻冻结：`resolveSource()` 每次现算，所以设置里改完当场生效（reconfigure）；
 *   - 渠道由版本推导并交给后端，源上只有另一条渠道时换一条再试一次（本会话记住哪条通）；
 *   - 打包内源的地址进状态（`builtinUrl`），设置页拿它当输入框的占位提示。
 */
export function createUpdater(options: {
  currentVersion: string
  /** 现算更新源（设置改完就是新源，不必重建更新器） */
  resolveSource: () => UpdateSource
  /** 打包内 app-update.yml 里的地址（留空时用的就是它）；读不出来 = null */
  builtinUrl?: string | null
  /** 惰性取后端（electron-updater 只在主进程里加载得动）；取不到回 null = 本次运行不检查更新 */
  backend: () => Promise<UpdateBackend | null>
  onChange?: (state: UpdateState) => void
}): KyclawUpdater {
  const currentVersion = options.currentVersion
  const builtinUrl = options.builtinUrl ?? null
  let source = options.resolveSource()
  /** 渠道记忆：默认按版本推；渠道文件不存在时换另一条，试通了就记住（本会话内沿用） */
  let channel = channelOf(currentVersion)
  let status: UpdateStatus = { phase: 'idle' }
  /** 本次检出到的目标版本（下载进度要带上它，单独记不用从相位里抠） */
  let targetVersion: string | undefined

  let backend: UpdateBackend | null = null
  let backendLoading: Promise<UpdateBackend | null> | null = null
  /** 检查期间后端的错误先交给 check()（可能要换渠道重试）；检查之外（下载失败等）直接进状态 */
  let collectCheckError: ((error: Error) => void) | null = null
  /** 源落到后端是异步的：check 前先等它（刚改完源就点检查时不会用着上一个源） */
  let pendingApply: Promise<void> = Promise.resolve()

  const snapshot = (): UpdateState => ({
    currentVersion,
    configured: source.kind !== 'none',
    builtinUrl,
    status
  })

  const setStatus = (next: UpdateStatus): void => {
    status = next
    options.onChange?.(snapshot())
  }

  const bindEvents = (target: UpdateBackend): void => {
    target.on('update-available', (info) => {
      targetVersion = versionOf(info)
      setStatus({ phase: 'available', version: targetVersion })
    })
    target.on('update-not-available', () => {
      setStatus({ phase: 'up-to-date' })
    })
    target.on('download-progress', (progress) => {
      // 下载中也要带上目标版本（available 那一下记下来的）
      setStatus({
        phase: 'downloading',
        version: targetVersion,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
      })
    })
    target.on('update-downloaded', (info) => {
      targetVersion = versionOf(info) ?? targetVersion
      setStatus({ phase: 'downloaded', version: targetVersion })
    })
    target.on('error', (error) => {
      if (collectCheckError !== null) {
        collectCheckError(error)
        return
      }
      setStatus({ phase: 'error', message: errorText(error) })
    })
  }

  /** 后端拿一次就留住（装配失败也留住 null：不反复 import、不反复刷日志） */
  const ensureBackend = async (): Promise<UpdateBackend | null> => {
    if (backend !== null) return backend
    backendLoading ??= options.backend()
    let loaded: UpdateBackend | null = null
    try {
      loaded = await backendLoading
    } catch {
      // 装载失败 = 本次运行没有更新后端（加载器自己留日志）；这里不抛——更新是加法
      return null
    }
    if (loaded !== null && backend === null) {
      backend = loaded
      bindEvents(loaded)
    }
    return loaded
  }

  /** 这一刻该给后端设的 feed（null = 不设，让它自己读打包内的 app-update.yml） */
  const feedFor = (
    next: UpdateSource,
    nextChannel: UpdateChannel
  ): { url: string; channel: UpdateChannel } | null => {
    if (next.kind === 'url') return { url: next.url, channel: nextChannel }
    // 内置源：读得到地址就显式设（渠道按版本推导；推错了还有 check() 里的兜底重试换另一条）
    if (next.kind === 'bundled' && builtinUrl !== null) {
      return { url: builtinUrl, channel: nextChannel }
    }
    return null
  }

  /**
   * 把源落到后端。覆盖源与内置源走同一条路：只要给得出地址就显式设 feed
   * —— 调过 setFeedURL 之后打包内那份 yml 不再被读，所以"切回内置源/换渠道重试"也必须显式设回去。
   * 失败只记日志：更新是加法，配不上源不该把"检查/保存"这些动作炸掉。
   */
  const applySource = async (next: UpdateSource, nextChannel: UpdateChannel): Promise<void> => {
    try {
      if (next.kind === 'none') return
      const feed = feedFor(next, nextChannel)
      if (feed === null) return
      const target = await ensureBackend()
      if (target === null) return
      target.setFeedURL(feed.url, feed.channel)
      target.setForceDevConfig(next.kind === 'url' && next.forceDevConfig)
    } catch (error) {
      console.warn('[kyclaw] 更新源配置失败（本次检查可能还用着上一个源）', error)
    }
  }

  pendingApply = applySource(source, channel)

  /**
   * 跑一次检查，并把"这一次尝试"的错误收干净（后端的事件与 check() 的拒绝两条路都算）。
   * 只有"渠道文件不存在"会交给调用方去换渠道重试，其余错误当场落状态。
   */
  const attemptCheck = async (target: UpdateBackend): Promise<CheckAttempt> => {
    let observed: Error | null = null
    collectCheckError = (error) => {
      observed ??= error
    }
    try {
      await target.check()
    } catch (error) {
      observed ??= toError(error)
    } finally {
      collectCheckError = null
    }
    if (observed === null) return { kind: 'ok' }
    if (!isChannelFileMissing(observed)) {
      setStatus({ phase: 'error', message: errorText(observed) })
      return { kind: 'ok' }
    }
    return { kind: 'channel-missing', error: observed }
  }

  return {
    state: snapshot,

    check: async () => {
      await pendingApply
      if (source.kind === 'none') return snapshot()
      const target = await ensureBackend()
      if (target === null) return snapshot()
      setStatus({ phase: 'checking' })

      const first = await attemptCheck(target)
      if (first.kind === 'channel-missing') {
        // 渠道兜底：源上只有另一条渠道的 yml（beta 包对着只有 latest.yml 的源）时换一条再试一次，
        // 试通了就把这条记在本会话里，后面直接用；两条都没有就把版本推导的那条还回去，报第一次的错
        const derived = channel
        channel = otherChannel(channel)
        await applySource(source, channel)
        setStatus({ phase: 'checking' })
        const second = await attemptCheck(target)
        if (second.kind === 'channel-missing') {
          // 两条都没有：把记忆还回版本推导的那条（feed 也一并设回去，记忆与后端别各说各话），
          // 报第一次的错——版本推导的那条才是"本该有"的
          channel = derived
          await applySource(source, channel)
          setStatus({ phase: 'error', message: errorText(first.error) })
        }
      }
      // 后端没发任何结果事件（比如 updater 被判定为不活跃）：退回"尚未检查"，不编造结论
      if (status.phase === 'checking') setStatus({ phase: 'idle' })
      return snapshot()
    },

    install: () => {
      if (backend === null || status.phase !== 'downloaded') return
      backend.install()
    },

    reconfigure: () => {
      const next = options.resolveSource()
      if (sameSource(next, source)) return
      source = next
      // 换源 = 换渠道记忆、相位归 idle：旧源上的"已是最新/已下载"对新源不成立
      channel = channelOf(currentVersion)
      targetVersion = undefined
      pendingApply = applySource(source, channel)
      setStatus({ phase: 'idle' })
    }
  }
}

/**
 * 真后端：动态 import electron-updater（它 require('electron')，只有主进程能加载）。
 * 两个开关在这里定死：自动下载开、退出时自动安装关（安装是用户点的动作）。
 */
export async function electronUpdaterBackend(): Promise<UpdateBackend> {
  // CJS 互操作：运行时形状与类型声明不一致 —— electron-updater 的 autoUpdater 是
  // Object.defineProperty 挂的 getter，ESM 的命名导出探测看不到它，真身在 default（module.exports）上
  // （实测：import 进来只有 default.autoUpdater 有值）。两条都试，拿不到就抛（调用方退回未配置）。
  const imported = (await import('electron-updater')) as unknown as {
    autoUpdater?: AppUpdater
    default?: { autoUpdater?: AppUpdater }
  }
  const autoUpdater = imported.autoUpdater ?? imported.default?.autoUpdater
  if (autoUpdater === undefined) throw new Error('electron-updater 里拿不到 autoUpdater')

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  return {
    on: (event, listener) => {
      autoUpdater.on(event, listener as never)
    },
    setFeedURL: (url, channel) => {
      // 渠道必须一起给：调过 setFeedURL 之后 app-update.yml 不再被读，不给渠道它会按
      // configuration.channel ?? 'latest' 去找 latest.yml（beta 包对着只有 beta.yml 的源就 404）
      autoUpdater.setFeedURL({ provider: 'generic', url, channel })
    },
    setForceDevConfig: (force) => {
      autoUpdater.forceDevUpdateConfig = force
    },
    check: () => autoUpdater.checkForUpdates(),
    install: () => autoUpdater.quitAndInstall()
  }
}

/**
 * "什么都不做"的实例：没配更新源时用它，也给主进程在异步装配前顶个位
 * （通道面立刻可用——渲染端一挂载就会拉状态）。
 */
export function createInertUpdater(currentVersion: string): KyclawUpdater {
  return createUpdater({
    currentVersion,
    resolveSource: () => ({ kind: 'none' }),
    backend: async () => null
  })
}

/**
 * 应用启动时装配更新器：**不会抛**。后端加载失败退回"未配置"实例（更新是加法，不该拦住应用启动）；
 * 源交给 `resolveSource` 现算 —— 设置里改完更新源，主进程调 `reconfigure()` 当场生效，不用重启。
 *
 * 启动时源已配好就当场把后端装起来（装配完成即"能检查"）；源为空则一个字节都不加载
 * （本机构建端与"没配源"的路径不该为更新通道付 electron-updater 的加载成本），
 * 等设置里真填了地址再在第一次配置/检查时惰性加载。
 */
export async function createKyclawUpdater(options: {
  currentVersion: string
  resolveSource: () => UpdateSource
  /** 打包内源的地址（进状态，界面上当输入框的占位提示） */
  builtinUrl?: string | null
  onChange?: (state: UpdateState) => void
}): Promise<KyclawUpdater> {
  /** electron-updater 真件只装一次；装不上也记住结果（不反复 import、不反复刷日志） */
  let loading: Promise<UpdateBackend | null> | null = null
  const loadBackend = (): Promise<UpdateBackend | null> => {
    loading ??= electronUpdaterBackend().catch((error) => {
      console.warn('[kyclaw] 更新通道加载失败（本次运行不检查更新）', error)
      return null
    })
    return loading
  }

  if (options.resolveSource().kind !== 'none' && (await loadBackend()) === null) {
    return createInertUpdater(options.currentVersion)
  }

  return createUpdater({
    currentVersion: options.currentVersion,
    resolveSource: options.resolveSource,
    builtinUrl: options.builtinUrl,
    backend: loadBackend,
    onChange: options.onChange
  })
}
