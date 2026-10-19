/**
 * B2：内核启动计划（**只算参数，不 spawn 进程**）。
 *
 * B1.5 真机实测的入口（对 Ada B1 报告的一处纠正）：
 *   - **不是** `dsh-desktop-host/lib/cli.js`（那是插件管理 CLI）；
 *   - 服务入口 = `@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 0 --no-open`；
 *   - 用 **Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`** 直接跑入口脚本
 *     （纯 `node.exe` 读不了 asar；见 `.superpowers/dev-verify/20261019-0.2.0/bao/poc-kernel-boot.md`）。
 *
 * B4 / PB-006：内核从"asar 内"改为"随包 `resources/kernel/<version>` 树"。两种布局都支持，
 * **按实际文件存在判定**（见 chooseKernelScript）：
 *   - 旧 asar 布局：`<root>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`；
 *   - 新内核树：`<versionDir>/node_modules/@deepseek-ai/dsh/lib/bin.js`。
 *
 * D1：这套东西只在 **Electron main** 里用；renderer 拿不到内核 URL/token。
 */
import { KernelStartupError } from './kernel-startup'

export const DSH_KERNEL_SCRIPT_IN_ASAR = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

export const DSH_KERNEL_SCRIPT_IN_KERNEL_TREE = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

export const DSH_KERNEL_ARGS = ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'] as const

export interface KernelScriptCandidates {
  /** 旧布局（app.asar 内 `dsh/node_modules/...`） */
  asarLayout: string
  /** 新布局（内核树 `node_modules/...`） */
  kernelTree: string
}

/**
 * 两个候选入口（**只拼路径，不判存在**）。`kernelRoot` 给了就作为新布局的根；
 * 旧布局永远以 `asarPath` 为根（开发/测试注入的 app.asar）。
 */
export function kernelScriptCandidates(input: {
  asarPath: string
  kernelRoot?: string
}): KernelScriptCandidates {
  const treeRoot = input.kernelRoot ?? input.asarPath
  return {
    asarLayout: `${input.asarPath}/${DSH_KERNEL_SCRIPT_IN_ASAR}`,
    kernelTree: `${treeRoot}/${DSH_KERNEL_SCRIPT_IN_KERNEL_TREE}`
  }
}

export interface KernelScriptChoice {
  kind: 'asar-layout' | 'kernel-tree'
  scriptPath: string
  candidates: KernelScriptCandidates
}

export interface KernelScriptResolveInput {
  asarPath: string
  /** 显式内核树根（打包态 = `<resources>/kernel/<version>`）；缺省按 asarPath 兼容旧布局 */
  kernelRoot?: string
  exists: (path: string) => boolean
}

/**
 * 选内核入口：**只看实际存在**（不靠版本号/flag 猜）。
 * - 显式给了 `kernelRoot`：优先内核树，其次旧 asar（保留开发/测试兼容）；
 * - 没给：优先旧 asar（B3.x 集成测试与本机 DSH 安装的行为不变），其次内核树；
 * - 两个都不存在：抛 `KERNEL_ENTRY_MISSING`，消息里列出两个候选 + 各自是否存在。
 *
 * ⚠️ `.asar` 是**合法候选**：asar 是文件不是目录，**普通 Node 的 existsSync 看不见 asar 内部**
 * （只有 Electron-as-node 的 fs 补丁能读）。所以"asar 根"这一支按**路径形态**放行、不做存在性
 * 判定 —— 真缺件让 spawn 后的内核自己报 MODULE_NOT_FOUND（stderr 原样进 KERNEL_EXITED）。
 * 反过来，如果这里用 existsSync 判 asar 内部文件，plain Node 下会全 False → 真机/集成测试
 * 直接被误判成 KERNEL_ENTRY_MISSING（PB-005 实测回归，见 PB-006 修复记录）。
 */
export function chooseKernelScript(input: KernelScriptResolveInput): KernelScriptChoice {
  const candidates = kernelScriptCandidates({
    asarPath: input.asarPath,
    ...(input.kernelRoot === undefined ? {} : { kernelRoot: input.kernelRoot })
  })
  /** asar 根（文件形态）：内部不可探测，按路径形态视为可用候选 */
  const asarLike = /\.asar$/iu.test(input.asarPath)
  const asarUsable = asarLike || input.exists(candidates.asarLayout)
  const treeUsable = input.exists(candidates.kernelTree)
  const order: readonly (readonly [KernelScriptChoice['kind'], string, boolean])[] =
    input.kernelRoot === undefined
      ? [
          ['asar-layout', candidates.asarLayout, asarUsable],
          ['kernel-tree', candidates.kernelTree, treeUsable]
        ]
      : [
          ['kernel-tree', candidates.kernelTree, treeUsable],
          ['asar-layout', candidates.asarLayout, asarUsable]
        ]
  for (const [kind, scriptPath, usable] of order) {
    if (usable) return { kind, scriptPath, candidates }
  }
  const describe = (usable: boolean, asar: boolean): string =>
    asar && usable
      ? '按 .asar 路径形态视为可用（内部不可探测，真缺件由 spawn 后的内核报错）'
      : usable
        ? '存在'
        : '不存在'
  throw new KernelStartupError(
    'KERNEL_ENTRY_MISSING',
    [
      '内核入口不存在（KERNEL_ENTRY_MISSING）：两个候选都不可用。',
      `  候选 1（旧 asar 布局）：${candidates.asarLayout}（${describe(asarUsable, true)}）`,
      `  候选 2（内核树布局）：${candidates.kernelTree}（${describe(treeUsable, false)}）`,
      '  打包态应为安装目录 resources/kernel/<version>/…；开发先跑 `pnpm fetch:kernel`；',
      '  也可用 KYCLAW_KERNEL_ROOT 指到现成内核树。'
    ].join('\n')
  )
}

export interface KernelLaunchInput {
  /** Electron 可执行文件（打包态 = process.execPath；开发态 = electron 二进制） */
  electronExecutable: string
  /**
   * 内核根：旧布局 = app.asar 根（`dsh/node_modules/...`）；新布局 = 版本目录本身
   * （`node_modules/@deepseek-ai/dsh/lib/bin.js`）。
   */
  asarPath: string
  /** 可选：显式内核树根（打包态由 kernel-layout 解析出的版本目录传进来） */
  kernelRoot?: string
  /** 可选：调用方已解析好的入口（chooseKernelScript 的结果）；缺省按 kernelRoot/asarPath 拼 */
  scriptPath?: string
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
  const scriptPath =
    input.scriptPath ??
    (input.kernelRoot === undefined
      ? `${input.asarPath}/${DSH_KERNEL_SCRIPT_IN_ASAR}`
      : `${input.kernelRoot}/${DSH_KERNEL_SCRIPT_IN_KERNEL_TREE}`)
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
