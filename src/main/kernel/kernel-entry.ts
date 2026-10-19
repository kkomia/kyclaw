/**
 * B2：内核启动计划（**只算参数，不 spawn 进程**）。
 *
 * B1.5 真机实测的入口（对 Ada B1 报告的一处纠正）：
 *   - **不是** `dsh-desktop-host/lib/cli.js`（那是插件管理 CLI）；
 *   - 服务入口 = `@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 0 --no-open`；
 *   - 用 **Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`** 直接跑 **asar 内**的 bin
 *     （纯 `node.exe` 读不了 asar；见 `.superpowers/dev-verify/20261019-0.2.0/bao/poc-kernel-boot.md`）。
 *
 * D1：这套东西只在 **Electron main** 里用；renderer 拿不到内核 URL/token。
 */
export const DSH_KERNEL_SCRIPT_IN_ASAR = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

export const DSH_KERNEL_ARGS = ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'] as const

export interface KernelLaunchInput {
  /** Electron 可执行文件（打包态 = process.execPath；开发态 = electron 二进制） */
  electronExecutable: string
  /** 打包态：`<resources>/app.asar`；开发态：仓库根（无 asar，asar 路径拼接规则由调用方决定） */
  asarPath: string
  /** 隔离的内核 home（绝不指向用户的 `~/.dsh`） */
  dshHome: string
  extraEnv?: Readonly<Record<string, string>>
}

export interface KernelLaunchPlan {
  executable: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  /** 供日志/诊断（不含 token——token 只有内核自己打印） */
  scriptPath: string
}

export function planKernelLaunch(input: KernelLaunchInput): KernelLaunchPlan {
  const scriptPath = `${input.asarPath}/${DSH_KERNEL_SCRIPT_IN_ASAR}`
  return {
    executable: input.electronExecutable,
    args: ['--expose-internals', scriptPath, ...DSH_KERNEL_ARGS],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: input.dshHome,
      ...input.extraEnv
    },
    scriptPath
  }
}
