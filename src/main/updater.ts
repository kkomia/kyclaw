/**
 * 更新通道（T17 试点）：electron-updater + generic provider（Gitee Release 直链）。
 *
 * 三件说清楚的事：
 *   1. **源从哪来**：环境变量 `KYCLAW_UPDATE_URL`（本机模拟更新源 / 内测切通道）优先；打包产物里
 *      带了 electron-builder 生成的 app-update.yml（真发布时配了 publish 才有）就用它；两者都没有 =
 *      **不检查、不报错**——开发态与"未配置"的默认路径安静待着，UI 上只说一句"未配置更新源"。
 *   2. **不骚扰**：没有任何弹窗、通知或错误框。状态只落在设置页「关于」栏的一行文字里，
 *      错误也只是一句截断过的话；启动检查是静默的。
 *   3. **不自动装**：检出后自动下载（进度同样只进状态），但**安装必须用户点"重启并安装"**
 *      （autoInstallOnAppQuit = false）—— 本机模拟源给的是假安装包，静默安装不可接受。
 *
 * 为什么把 autoUpdater 包一层：electron-updater 是 electron 运行时模块（而且它的 `error` 事件
 * 没有监听者时会把进程带走），真件在 `electronUpdaterBackend()` 里动态 import；状态机本体不碰
 * electron，单测直接注入假后端（见 main/__tests__/updater.spec.ts）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { UpdateState, UpdateStatus } from '../shared/ipc'

/** 更新源覆盖（本机模拟更新源、内测切通道都走它） */
export const UPDATE_URL_ENV = 'KYCLAW_UPDATE_URL'

/** 打包内的更新配置：electron-builder 配了 publish 时会写进 resources/ */
export const BUNDLED_UPDATE_CONFIG = 'app-update.yml'

/** 开发态替代品：forceDevUpdateConfig 时 electron-updater 读它（repo 根目录一份，不进安装包） */
export const DEV_UPDATE_CONFIG = 'dev-app-update.yml'

/** 错误文案上限：状态栏是一行字，不是日志 */
const ERROR_TEXT_LIMIT = 160

/**
 * 更新源的三种下场：url = 显式给了地址（未打包时还要开 forceDevUpdateConfig，才能读 dev-app-update.yml
 * 里的缓存目录名等本地配置）；bundled = 用打包内的 app-update.yml；none = 没配（安静待着）。
 */
export type UpdateSource =
  { kind: 'url'; url: string; forceDevConfig: boolean } | { kind: 'bundled' } | { kind: 'none' }

export function resolveUpdateSource(options: {
  envUrl?: string | undefined
  isPackaged: boolean
  /** 打包内有没有 app-update.yml（测试注入；生产由调用方 existsSync 判定） */
  hasBundledConfig: boolean
}): UpdateSource {
  const url = options.envUrl?.trim()
  if (url !== undefined && url.length > 0) {
    return { kind: 'url', url, forceDevConfig: !options.isPackaged }
  }
  if (options.isPackaged && options.hasBundledConfig) return { kind: 'bundled' }
  return { kind: 'none' }
}

/** 主进程从打包目录判定"有没有 app-update.yml" */
export function hasBundledUpdateConfig(resourcesPath: string): boolean {
  return existsSync(join(resourcesPath, BUNDLED_UPDATE_CONFIG))
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
  /** 配置 generic provider 源；不调 = 用打包内的 app-update.yml */
  setFeedURL(url: string): void
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
}

/** 错误文案：一行、截断、不带栈（electron-updater 的 error.message 有时会带一大段上下文） */
function errorText(error: unknown): string {
  const raw =
    error instanceof Error && error.message.length > 0 ? error.message : String(error ?? '未知错误')
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > ERROR_TEXT_LIMIT ? `${oneLine.slice(0, ERROR_TEXT_LIMIT - 1)}…` : oneLine
}

function versionOf(info: unknown): string | undefined {
  const version = (info as { version?: unknown } | null)?.version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

/**
 * 状态机（不碰 electron）：把后端的事件翻成 UpdateState 并回调 `onChange`。
 * 没配置源时给一个"什么都不做"的实例——IPC 那侧就不必到处判空。
 */
export function createUpdater(options: {
  currentVersion: string
  source: UpdateSource
  /** 真后端；none 时传 null */
  backend: UpdateBackend | null
  onChange?: (state: UpdateState) => void
}): KyclawUpdater {
  const configured = options.source.kind !== 'none'
  let status: UpdateStatus = { phase: 'idle' }
  /** 本次检出到的目标版本（下载进度要带上它，单独记不用从相位里抠） */
  let targetVersion: string | undefined

  const snapshot = (): UpdateState => ({
    currentVersion: options.currentVersion,
    configured,
    status
  })

  const setStatus = (next: UpdateStatus): void => {
    status = next
    options.onChange?.(snapshot())
  }

  const backend = options.backend
  if (backend !== null) {
    if (options.source.kind === 'url') {
      backend.setFeedURL(options.source.url)
      backend.setForceDevConfig(options.source.forceDevConfig)
    }
    backend.on('update-available', (info) => {
      targetVersion = versionOf(info)
      setStatus({ phase: 'available', version: targetVersion })
    })
    backend.on('update-not-available', () => {
      setStatus({ phase: 'up-to-date' })
    })
    backend.on('download-progress', (progress) => {
      // 下载中也要带上目标版本（available 那一下记下来的）
      setStatus({
        phase: 'downloading',
        version: targetVersion,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
      })
    })
    backend.on('update-downloaded', (info) => {
      targetVersion = versionOf(info) ?? targetVersion
      setStatus({ phase: 'downloaded', version: targetVersion })
    })
    backend.on('error', (error) => {
      setStatus({ phase: 'error', message: errorText(error) })
    })
  }

  return {
    state: snapshot,

    check: async () => {
      if (backend === null || !configured) return snapshot()
      setStatus({ phase: 'checking' })
      try {
        await backend.check()
      } catch (error) {
        // 后端自己也会发 error 事件；这里兜住"抛出来的那条"（两条路都进同一个状态）
        if (status.phase !== 'error') setStatus({ phase: 'error', message: errorText(error) })
        return snapshot()
      }
      // 后端没发任何结果事件（比如 updater 被判定为不活跃）：退回"尚未检查"，不编造结论
      if (status.phase === 'checking') setStatus({ phase: 'idle' })
      return snapshot()
    },

    install: () => {
      if (backend === null || status.phase !== 'downloaded') return
      backend.install()
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
    setFeedURL: (url) => {
      autoUpdater.setFeedURL({ provider: 'generic', url })
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
  return createUpdater({ currentVersion, source: { kind: 'none' }, backend: null })
}

/**
 * 应用启动时装配更新器：**不会抛**。源没配 / electron-updater 加载失败都退回"未配置"实例
 * （更新是加法，不该拦住应用启动）。
 */
export async function createKyclawUpdater(options: {
  currentVersion: string
  envUrl?: string | undefined
  isPackaged: boolean
  hasBundledConfig: boolean
  onChange?: (state: UpdateState) => void
}): Promise<KyclawUpdater> {
  const source = resolveUpdateSource(options)
  if (source.kind === 'none') {
    return createUpdater({ currentVersion: options.currentVersion, source, backend: null })
  }

  try {
    const backend = await electronUpdaterBackend()
    return createUpdater({
      currentVersion: options.currentVersion,
      source,
      backend,
      onChange: options.onChange
    })
  } catch (error) {
    console.warn('[kyclaw] 更新通道加载失败（本次运行不检查更新）', error)
    return createUpdater({
      currentVersion: options.currentVersion,
      source: { kind: 'none' },
      backend: null
    })
  }
}
