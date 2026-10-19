/**
 * PB-017 / PB-006：内核启动失败的**可诊断错误**（第一层，main 侧统一口径）。
 *
 * 为什么单独一层：内核启动失败的原因横跨「配置缺失 / 入口文件缺失 / 进程起不来 / 提前退出 /
 * 就绪超时」几类，错误文本会直接经 `agent:endpoint` 到用户眼前（验收项④），必须带
 * **错误码 + 原因 + 退出码（有的话）+ 日志落点（调用方补）**，不能只剩一句 TypeError。
 *
 * 纪律：
 * - 本模块不 import electron / 不 spawn，纯错误与校验（单测可直接跑）；
 * - `KERNEL_NOT_CONFIGURED` 在 **spawn 之前** 抛出（PB-017：空串 spawn('') 会同步抛 TypeError）；
 * - 错误消息用中文人话，且 `code` 字段供日志/测试判定（不靠字符串猜）。
 */

export type KernelStartupCode =
  | 'KERNEL_NOT_CONFIGURED'
  | 'KERNEL_ENTRY_MISSING'
  | 'KERNEL_SPAWN_FAILED'
  | 'KERNEL_EXITED'
  | 'KERNEL_NOT_READY'

export interface KernelStartupErrorDetails {
  /** 进程退出码（仅 EXITED 类有） */
  exitCode?: number | null
  signal?: string | null
  /** 已脱敏的 stderr 尾部（仅进程类错误） */
  stderrTail?: string
  /** 本次实际要跑的入口路径（便于对照「候选路径」） */
  scriptPath?: string
}

/** 带 code 的内核启动错误：main 侧据此写日志、IPC 侧据此给用户可诊断文案 */
export class KernelStartupError extends Error {
  readonly code: KernelStartupCode
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly stderrTail?: string
  readonly scriptPath?: string

  constructor(code: KernelStartupCode, message: string, details: KernelStartupErrorDetails = {}) {
    super(message)
    this.name = 'KernelStartupError'
    this.code = code
    if (details.exitCode !== undefined) this.exitCode = details.exitCode
    if (details.signal !== undefined) this.signal = details.signal
    if (details.stderrTail !== undefined) this.stderrTail = details.stderrTail
    if (details.scriptPath !== undefined) this.scriptPath = details.scriptPath
  }
}

export interface KernelLaunchConfigInput {
  /** Electron 可执行文件（打包态 = process.execPath） */
  electronExecutable: string | undefined
  /**
   * 内核根目录：
   * - 旧 asar 布局 = `<resources>/app.asar`（内核在 `dsh/node_modules/...` 里）；
   * - 打包态新布局 = 安装目录 `resources/kernel`（下面有 `current.json` + `rc.2/`）或
   *   `<version>` 版本目录本身（`node_modules/@deepseek-ai/dsh/...`）。
   * 它由 main/index.ts 注入；测试/开发也可直接给。
   */
  kernelRoot: string | undefined
}

type MissingConfig = 'both' | 'executable' | 'kernel-root'

/**
 * 「内核入口未配置」的人话：说清**缺什么**、**谁该注入**、**从哪来**（flag/env/项目配置）。
 * 这条消息会原样进 kernel.log 与 IPC 错误（ErrorCard 对中文错误原样显示）。
 */
export function kernelNotConfiguredMessage(missing: MissingConfig): string {
  const what =
    missing === 'both'
      ? '启动参数一个都没有（electronExecutable 与内核目录都是空）'
      : missing === 'executable'
        ? '缺少 Electron 可执行文件（electronExecutable）'
        : '缺少内核目录（asarPath/kernelRoot；打包态应为安装目录 resources/kernel）'
  return [
    `内核入口未配置（KERNEL_NOT_CONFIGURED）：KYCLAW_KERNEL_PORT=1，但${what}。`,
    '  期望来源：生产由 src/main/index.ts 注入 process.execPath + process.resourcesPath/kernel；',
    '  开发态为 app.getAppPath()/resources/kernel（先跑 `pnpm fetch:kernel` 把快照落到 resources/kernel/rc.2），',
    '  也可用环境变量 KYCLAW_KERNEL_ROOT 指到现成的内核树。',
    '  只想走旧路径时不要设 KYCLAW_KERNEL_PORT=1（flag/env：KYCLAW_KERNEL_PORT）。'
  ].join('\n')
}

/**
 * spawn 前的硬校验（PB-017）：flag 已开但调用方没注入内核参数时 fail fast，
 * 绝不把空串交给 `spawn()`（Node 会同步抛 `TypeError: The argument 'file' cannot be empty`）。
 */
export function assertKernelLaunchConfigured(input: KernelLaunchConfigInput): void {
  const executable = typeof input.electronExecutable === 'string' ? input.electronExecutable.trim() : ''
  const kernelRoot = typeof input.kernelRoot === 'string' ? input.kernelRoot.trim() : ''
  if (executable !== '' && kernelRoot !== '') return
  const missing: MissingConfig =
    executable === '' && kernelRoot === '' ? 'both' : executable === '' ? 'executable' : 'kernel-root'
  throw new KernelStartupError('KERNEL_NOT_CONFIGURED', kernelNotConfiguredMessage(missing))
}
