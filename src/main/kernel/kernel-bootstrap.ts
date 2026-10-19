/**
 * B3.1a：main 侧入口（flag 开才实例化真内核）。
 *
 * B4 / PB-006：这里补齐了"真机生产通路"与验收④的可诊断错误面：
 *   1. flag 开 → 先按 `asarPath`（= 内核根，main/index.ts 注入）解析布局（current.json /
 *      旧 asar 兼容），再起内核；
 *   2. 全过程写 `<userData>/logs/kernel.log`：`kernel.start` / `kernel.ready`（端口/session/耗时）/
 *      `kernel.failed`（错误码/退出码/首行原因）；
 *   3. 失败抛带 `code` 的 KernelStartupError，main/index.ts 原样交给 IPC → ErrorCard 展示。
 *
 * flag 关：第一行就返回 null（不解析路径、不建日志、不 spawn）——旧路径字节级不变。
 */
import { join } from 'node:path'
import { isKernelPortEnabled } from './feature-flag'
import { startKernelAdapter, type KernelAdapter, type KernelAdapterOptions } from './kernel-adapter'
import { resolveKernelLayout } from './kernel-layout'
import { createKernelLog } from './kernel-log'
import {
  KernelStartupError,
  asKernelStartupError,
  assertKernelLaunchConfigured,
  kernelFailureText
} from './kernel-startup'

export interface KernelBootstrapOptions extends KernelAdapterOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** 内核启动日志落点（生产 = `<userData>/logs/kernel.log`）；缺省不写文件（测试/纯诊断） */
  logFile?: string
}

/** 日志里放首行原因即可（完整 stderr 已在 failure.message 里；日志单行好检索） */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}

/** flag 关：返回 null（不 spawn、不连网、行为与现在完全一致）；flag 开：起真内核 */
export async function maybeStartKernelAdapter(
  options: KernelBootstrapOptions
): Promise<KernelAdapter | null> {
  const env = options.env ?? process.env
  if (!isKernelPortEnabled(env)) return null
  const { env: _ignored, logFile, ...adapterOptions } = options
  void _ignored
  // PB-017：flag 开但没注入内核参数（service.ts 把缺省值兜成空串）时，spawn('') 会同步抛
  // TypeError。必须在 spawn 之前 fail fast，给「内核入口未配置」+ 配置来源的可诊断错误。
  assertKernelLaunchConfigured({
    electronExecutable: adapterOptions.electronExecutable,
    kernelRoot: adapterOptions.asarPath
  })

  const log = logFile === undefined || logFile === '' ? null : createKernelLog(logFile)
  const startedAt = Date.now()
  const dshHome = adapterOptions.dshHome ?? join(adapterOptions.appDataDir, 'dsh-kernel-home')

  // 布局解析（轻校验）：失败也给统一错误码 + 日志，不把半截路径交给 spawn
  const layout = resolveKernelLayout({ kernelRoot: adapterOptions.asarPath })
  if (!layout.ok) {
    const failure = new KernelStartupError(layout.code, layout.detail)
    log?.event('kernel.failed', {
      code: layout.code,
      reason: firstLine(layout.detail),
      log: logFile ?? null
    })
    console.error(`[kyclaw] ${kernelFailureText(failure, logFile)}`)
    throw failure
  }

  log?.event('kernel.start', {
    kind: layout.kind,
    root: layout.kernelRoot,
    version: layout.version,
    sha256: layout.sha256,
    dshHome,
    executable: adapterOptions.electronExecutable,
    log: logFile ?? null
  })

  try {
    const adapter = await startKernelAdapter({
      ...adapterOptions,
      asarPath: layout.versionDir,
      dshHome
    })
    log?.event('kernel.ready', {
      kind: layout.kind,
      version: layout.version,
      port: adapter.port,
      pid: adapter.pid ?? null,
      sessionId: adapter.sessionId,
      elapsedMs: Date.now() - startedAt
    })
    console.warn(
      `[kyclaw] 内核已启动（${layout.version}，port=${String(adapter.port)}，${String(Date.now() - startedAt)}ms）`
    )
    return adapter
  } catch (error) {
    const failure = asKernelStartupError(error)
    log?.event('kernel.failed', {
      code: failure.code,
      exitCode: failure.exitCode ?? null,
      reason: firstLine(failure.message),
      log: logFile ?? null
    })
    throw failure
  }
}
