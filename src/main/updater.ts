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
 *   3. **不骚扰**：没有弹窗、通知或错误框；状态只落在设置页「关于」栏的一行文字里，错误也只是一句
 *      截断过的话，启动检查是静默的。新版本的**发行日志**（源上渠道 yml 里的 releaseNotes/
 *      releaseName/releaseDate）跟着状态一起走，只显示当前这一版的那一份，缺了就什么也不显示。
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

/**
 * 假后端（单测）与真后端（electron-updater）共用的那一小块面。
 * 两个"有新版本"的事件都带同一份 UpdateInfo（真件上就是 electron-updater 的类型）。
 */
export interface UpdateBackendEvents {
  'update-available': (info: UpdateInfoLike) => void
  'update-not-available': () => void
  'download-progress': (progress: { percent: number }) => void
  'update-downloaded': (info: UpdateInfoLike) => void
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

/** 发行说明的文本上限：状态要经 IPC 推给窗口，别把源上一个无上限的字符串整份搬过去 */
const NOTES_TEXT_LIMIT = 20_000

/** 去掉两端空白；空串 = 没有（不编一个空字符串出来给界面显示） */
function textOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text.length === 0 ? undefined : text
}

/**
 * 发行说明的两种形状（electron-updater 的 `UpdateInfo.releaseNotes`）：generic 源（我们的局域网
 * MinIO / Gitee 静态目录）是 `string`；GitHub 的"全量更新日志"是 `[{ version, note }]`。
 * 数组按**目标版本**挑条目，挑不到就整条丢掉 —— 宁可不显示，也不把别的版本的日志挂在眼前这一版上。
 */
function notesOf(raw: unknown, version: string | undefined): string | undefined {
  if (Array.isArray(raw)) {
    const matched = raw.find(
      (entry) =>
        version !== undefined &&
        textOf((entry as { version?: unknown } | null)?.version) === version
    )
    return textOf((matched as { note?: unknown } | null)?.note)
  }
  return textOf(raw)
}

/** 发行说明的截断（只截不留痕：状态不是日志窗口） */
function clampNotes(notes: string | undefined): string | undefined {
  if (notes === undefined || notes.length <= NOTES_TEXT_LIMIT) return notes
  return `${notes.slice(0, NOTES_TEXT_LIMIT - 1)}…`
}

/** 后端给的一份"新版本信息"（真件是 electron-updater 的 UpdateInfo；四个字段都可能缺） */
export interface UpdateInfoLike {
  version?: unknown
  releaseNotes?: unknown
  releaseName?: unknown
  releaseDate?: unknown
}

/**
 * 一次检出的"给人看的那部分"。为什么记这一份而不是每次从相位里抠：
 * 下载进度与下载完成两个事件也要带上**同一份**（它们有的不带说明，有的只带版本）。
 */
interface Release {
  version: string | undefined
  notes: string | undefined
  releaseName: string | undefined
  releaseDate: string | undefined
}

/** 从后端给的一份信息里读出这四个字段（读不出来的就是 undefined，不猜） */
function releaseOf(info: unknown): Release {
  const record = (info ?? {}) as Record<string, unknown>
  const version = versionOf(info)
  return {
    version,
    notes: clampNotes(notesOf(record.releaseNotes, version)),
    releaseName: textOf(record.releaseName),
    releaseDate: textOf(record.releaseDate)
  }
}

/**
 * 下载完成那一份常常不带全：缺的字段用检出那次补上（版本一致 = 同一版，缺说明时沿用这一版的）。
 * 版本**不同**的完成事件不是"这一次下载"，调用方直接丢掉（见 bindEvents）；版本一致但没带说明的
 * 也不回退到别的版本 —— 只有检出那一次记下的那一份。
 */
function mergeRelease(previous: Release, next: Release): Release {
  return {
    version: next.version ?? previous.version,
    notes: next.notes ?? previous.notes,
    releaseName: next.releaseName ?? previous.releaseName,
    releaseDate: next.releaseDate ?? previous.releaseDate
  }
}

/** 状态里的发行说明三个字段（共用一处；没有的就是 undefined，界面按"没提供"处理） */
function releaseFields(
  release: Release | null
): Pick<Release, 'notes' | 'releaseName' | 'releaseDate'> {
  return {
    notes: release?.notes,
    releaseName: release?.releaseName,
    releaseDate: release?.releaseDate
  }
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
  /** 本次检出到的那一份（版本 + 发行说明）：下载进度/下载完成都要带上它，见 mergeRelease */
  let release: Release | null = null
  /**
   * 会话号（换源 +1）。后端的事件不带源的信息，但"我们发起的那次检查"带着它的会话号：
   * 旧源迟到的结论（连同那一版的发行说明）就此认领不到新源头上（见 bindEvents）。
   */
  let session = 0
  /** 还没收尾的那次检查（electron-updater 会把并发检查并成一次，见 check()） */
  let running: { session: number; observed: Error | null; done: Promise<void> } | null = null
  /** 最后那次检出之后有下载在跑（换源时靠它判断"可能有旧源的下载还在飞"） */
  let downloading = false
  /**
   * 可能有旧源的下载还在飞（下载不带源信息，也取消不掉）：这期间的进度先不显示——
   * 把旧源的百分比挂到新源那一版头上，比不显示更糟。
   */
  let staleDownload = false

  let backend: UpdateBackend | null = null
  let backendLoading: Promise<UpdateBackend | null> | null = null
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

  /** 这个事件算不算"当前源这次检查"的（旧源迟到的、没在检查的一律不算） */
  const forCurrentCheck = (): boolean => running !== null && running.session === session

  const bindEvents = (target: UpdateBackend): void => {
    target.on('update-available', (info) => {
      if (!forCurrentCheck()) return
      // 检出是"这一份"的起点：版本与它的发行说明一起记下、一起进状态（缺说明就是缺，不沿用上一份）
      release = releaseOf(info)
      downloading = true
      setStatus({ phase: 'available', version: release.version, ...releaseFields(release) })
    })
    target.on('update-not-available', () => {
      if (!forCurrentCheck()) return
      setStatus({ phase: 'up-to-date' })
    })
    target.on('download-progress', (progress) => {
      // 没有"当前源检出的那一份"、或可能有旧源的下载还在飞：都不显示（进度认不出是哪个源的）
      if (release === null || staleDownload) return
      setStatus({
        phase: 'downloading',
        version: release.version,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
        ...releaseFields(release)
      })
    })
    target.on('update-downloaded', (info) => {
      // 有下载收尾了（不管是哪个源的）：这一条之后，进度就能重新归属了
      downloading = false
      staleDownload = false
      if (release === null) return
      const finished = releaseOf(info)
      // 报的版本与检出那版不同 = 不是这一次下载（换源后旧源迟到的完成事件）：整份丢掉，
      // 不记它的版本、不带它的说明，也就不会让界面拿旧源那份去装
      if (
        finished.version !== undefined &&
        release.version !== undefined &&
        finished.version !== release.version
      ) {
        return
      }
      release = mergeRelease(release, finished)
      setStatus({ phase: 'downloaded', version: release.version, ...releaseFields(release) })
    })
    target.on('error', (error) => {
      // 检查期间的错误交给那次检查（可能要换渠道重试）；之外只认"当前这一份下载"的错
      const attempt = running
      if (attempt !== null && attempt.session === session) {
        attempt.observed ??= error
        return
      }
      // 检查之外出错 = 下载结束了（认不认这条都一样）
      downloading = false
      staleDownload = false
      if (release === null) return
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
   * 只有"渠道文件不存在"会交给调用方去换渠道重试，其余错误当场落状态（会话换了的就什么都不写）。
   */
  const attemptCheck = async (target: UpdateBackend): Promise<CheckAttempt> => {
    const attempt = {
      session,
      observed: null as Error | null,
      done: Promise.resolve()
    }
    running = attempt
    attempt.done = (async () => {
      try {
        await target.check()
      } catch (error) {
        attempt.observed ??= toError(error)
      }
    })()
    try {
      await attempt.done
    } finally {
      if (running === attempt) running = null
    }
    const observed = attempt.observed
    if (observed === null) return { kind: 'ok' }
    if (!isChannelFileMissing(observed)) {
      if (attempt.session === session) setStatus({ phase: 'error', message: errorText(observed) })
      return { kind: 'ok' }
    }
    return { kind: 'channel-missing', error: observed }
  }

  return {
    state: snapshot,

    check: async () => {
      const mine = session
      await pendingApply
      if (source.kind === 'none') return snapshot()
      const target = await ensureBackend()
      if (target === null) return snapshot()
      // 上一次检查还在飞：等它收尾再发自己那一次（不 await 的话 electron-updater 会把两次并成
      // 一次，这一次的结论其实是上一个源的）
      const previous = running
      if (previous !== null) await previous.done
      if (session !== mine) return snapshot()
      setStatus({ phase: 'checking' })

      const first = await attemptCheck(target)
      if (session !== mine) return snapshot()
      if (first.kind === 'channel-missing') {
        // 渠道兜底：源上只有另一条渠道的 yml（beta 包对着只有 latest.yml 的源）时换一条再试一次，
        // 试通了就把这条记在本会话里，后面直接用；两条都没有就把版本推导的那条还回去，报第一次的错
        const derived = channel
        channel = otherChannel(channel)
        await applySource(source, channel)
        setStatus({ phase: 'checking' })
        const second = await attemptCheck(target)
        if (session !== mine) return snapshot()
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
      // 换源 = 新会话 + 相位归 idle：旧源上那个版本的结论与发行说明一并作废，旧源迟到的
      // 检查结论/下载进度/完成事件也认领不到新源头上（见 session）
      session += 1
      channel = channelOf(currentVersion)
      release = null
      // 换源时可能旧源的下载还在飞（取消不掉）：进度先按住，等有下载收尾再放行（见 staleDownload）
      staleDownload = downloading
      downloading = false
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
